// components/test-selection-table.ts — Test selection table for the graph page.
// Shows all matching tests with checkboxes for explicit plot selection.

import { el } from '../utils';
import { GRAPH_TABLE_HOVER } from '../events';

export interface TestSelectionEntry {
  testName: string;
  selected: boolean;
  /** Color assigned to this test (only set when selected). */
  color?: string;
  /** Unicode marker symbol character (e.g., '●') — only shown when selected. */
  symbolChar?: string;
  /** Whether data is currently loading for this test. */
  loading?: boolean;
}

export interface TestSelectionTableOptions {
  entries: TestSelectionEntry[];
  /** Called when the selection changes. Receives the full new selection set. */
  onSelectionChange: (selected: Set<string>) => void;
  /** Optional message shown above the table rows. */
  message?: string;
}

export interface TestSelectionTableHandle {
  /** Re-render the table with new entries and optional message. */
  update(entries: TestSelectionEntry[], message?: string): void;
  /** Highlight (or un-highlight) a row by test name. */
  highlightRow(testName: string | null): void;
  /** Remove the table and clean up listeners. */
  destroy(): void;
}

/**
 * Create a test selection table.
 *
 * One row per test name with a checkbox for selection. Click to toggle,
 * shift-click for range selection, double-click to isolate/restore.
 * Hover dispatches GRAPH_TABLE_HOVER with the bare test name.
 */
export function createTestSelectionTable(
  container: HTMLElement,
  options: TestSelectionTableOptions,
): TestSelectionTableHandle {
  const wrapper = el('div', {});
  const messageEl = el('div', { class: 'test-selection-message' });
  const table = el('table', { class: 'test-selection-table' });

  // Header with "check all" checkbox
  const thead = el('thead');
  const headerRow = el('tr');
  const headerCbCell = el('th', { class: 'sel-checkbox-cell' });
  const headerCb = el('input', { type: 'checkbox' }) as HTMLInputElement;
  headerCbCell.append(headerCb);
  headerRow.append(headerCbCell, el('th'), el('th'));
  thead.append(headerRow);

  const tbody = el('tbody');
  table.append(thead, tbody);
  wrapper.append(messageEl, table);
  container.append(wrapper);

  let currentEntries: TestSelectionEntry[] = options.entries;
  let currentOnSelectionChange = options.onSelectionChange;
  /** Last-clicked test name (not index) — survives update() rebuilds. */
  let lastClickedTest: string | null = null;

  function currentSelection(): Set<string> {
    const sel = new Set<string>();
    for (const e of currentEntries) {
      if (e.selected) sel.add(e.testName);
    }
    return sel;
  }

  function setMessage(msg?: string): void {
    if (msg) {
      messageEl.textContent = msg;
      messageEl.style.display = '';
    } else {
      messageEl.textContent = '';
      messageEl.style.display = 'none';
    }
  }

  function updateHeaderCheckbox(): void {
    const total = currentEntries.length;
    const selectedCount = currentEntries.filter(e => e.selected).length;
    headerCb.checked = total > 0 && selectedCount === total;
    headerCb.indeterminate = selectedCount > 0 && selectedCount < total;
  }

  function buildRows(entries: TestSelectionEntry[]): void {
    tbody.replaceChildren();
    for (const entry of entries) {
      const tr = el('tr', { 'data-test': entry.testName });
      if (entry.selected) tr.classList.add('row-selected');
      if (entry.loading) tr.classList.add('row-loading');

      // Checkbox cell
      const cbCell = el('td', { class: 'sel-checkbox-cell' });
      const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = entry.selected;
      if (entry.loading) cb.disabled = true;
      cbCell.append(cb);

      // Symbol cell — colored marker when selected, empty otherwise
      const symbolCell = el('td', { class: 'sel-symbol-cell' });
      if (entry.selected && entry.color) {
        const symbolSpan = el('span', { class: 'legend-symbol' }, entry.symbolChar || '●');
        (symbolSpan as HTMLElement).style.color = entry.color;
        symbolCell.append(symbolSpan);
      }

      // Test name cell
      const nameCell = el('td', { class: 'sel-test-name' }, entry.testName);

      tr.append(cbCell, symbolCell, nameCell);
      tbody.append(tr);
    }
    updateHeaderCheckbox();
  }

  buildRows(currentEntries);
  setMessage(options.message);

  // --- Header "check all" checkbox ---
  headerCb.addEventListener('click', () => {
    const allSelected = currentEntries.length > 0 &&
      currentEntries.every(e => e.selected);
    if (allSelected) {
      // Deselect all
      currentOnSelectionChange(new Set());
    } else {
      // Select all
      const allSel = new Set<string>();
      for (const e of currentEntries) allSel.add(e.testName);
      currentOnSelectionChange(allSel);
    }
  });

  // --- Interaction: click, shift-click, double-click ---
  // Single-click uses a 200ms delay to distinguish from double-click.
  // Shift-click bypasses the delay (modifier key makes intent unambiguous).
  let clickTimer: ReturnType<typeof setTimeout> | null = null;

  function findRowIndex(testName: string): number {
    return currentEntries.findIndex(e => e.testName === testName);
  }

  tbody.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    // Undo native checkbox toggle — selection is driven by data, not DOM state.
    // The table rebuild after onSelectionChange will set the correct checked state.
    if (target instanceof HTMLInputElement && target.type === 'checkbox') {
      target.checked = !target.checked;
    }
    const tr = target.closest('tr[data-test]');
    if (!tr) return;
    const testName = tr.getAttribute('data-test')!;

    if (e.shiftKey && lastClickedTest !== null) {
      // Shift-click: immediate range selection (no delay)
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }

      const fromIdx = findRowIndex(lastClickedTest);
      const toIdx = findRowIndex(testName);

      if (fromIdx < 0) {
        // lastClickedTest no longer in entries — treat as normal click
        lastClickedTest = testName;
        const sel = currentSelection();
        if (sel.has(testName)) { sel.delete(testName); } else { sel.add(testName); }
        currentOnSelectionChange(sel);
        return;
      }

      const lo = Math.min(fromIdx, toIdx);
      const hi = Math.max(fromIdx, toIdx);
      const sel = currentSelection();
      for (let i = lo; i <= hi; i++) {
        sel.add(currentEntries[i].testName);
      }
      lastClickedTest = testName;
      currentOnSelectionChange(sel);
      return;
    }

    // Normal click: 200ms delay to distinguish from double-click
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      clickTimer = null;
      lastClickedTest = testName;
      const sel = currentSelection();
      if (sel.has(testName)) { sel.delete(testName); } else { sel.add(testName); }
      currentOnSelectionChange(sel);
    }, 200);
  });

  tbody.addEventListener('dblclick', (e) => {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    const tr = (e.target as HTMLElement).closest('tr[data-test]');
    if (!tr) return;
    const testName = tr.getAttribute('data-test')!;
    lastClickedTest = testName;

    const sel = currentSelection();
    if (sel.size === 1 && sel.has(testName)) {
      // Already isolated — restore all (select every visible test)
      const allSel = new Set<string>();
      for (const entry of currentEntries) allSel.add(entry.testName);
      currentOnSelectionChange(allSel);
    } else {
      // Isolate: select only this test
      currentOnSelectionChange(new Set([testName]));
    }
  });

  // --- Hover delegation ---
  tbody.addEventListener('mouseenter', (e) => {
    const tr = (e.target as HTMLElement).closest('tr[data-test]');
    if (tr) {
      document.dispatchEvent(new CustomEvent(GRAPH_TABLE_HOVER, {
        detail: tr.getAttribute('data-test'),
      }));
    }
  }, true);

  tbody.addEventListener('mouseleave', (e) => {
    const tr = (e.target as HTMLElement).closest('tr[data-test]');
    if (tr) {
      document.dispatchEvent(new CustomEvent(GRAPH_TABLE_HOVER, {
        detail: null,
      }));
    }
  }, true);

  return {
    update(entries: TestSelectionEntry[], message?: string): void {
      currentEntries = entries;
      // Reset lastClickedTest if it's no longer in the entries
      if (lastClickedTest !== null && !entries.some(e => e.testName === lastClickedTest)) {
        lastClickedTest = null;
      }
      buildRows(entries);
      setMessage(message);
    },

    highlightRow(testName: string | null): void {
      const prev = tbody.querySelectorAll('.row-highlighted');
      for (const el of prev) el.classList.remove('row-highlighted');

      if (testName) {
        const row = tbody.querySelector(`tr[data-test="${CSS.escape(testName)}"]`);
        if (row) row.classList.add('row-highlighted');
      }
    },

    destroy(): void {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      wrapper.remove();
    },
  };
}
