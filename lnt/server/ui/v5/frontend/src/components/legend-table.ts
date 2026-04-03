// components/legend-table.ts — Legend table below the graph chart.

import { el, TRACE_SEP } from '../utils';
import { GRAPH_TABLE_HOVER } from '../events';

export interface LegendEntry {
  testName: string;
  color: string;
  active: boolean;
  /** Machine name shown right-justified in the row. */
  machineName?: string;
  /** Unicode character representing the marker symbol (e.g., '●', '▲'). */
  symbolChar?: string;
}

export interface LegendTableOptions {
  entries: LegendEntry[];
  onToggle: (testName: string) => void;
  /** Called on double-click: isolate this test (or restore all if already isolated). */
  onIsolate: (testName: string) => void;
  /** Optional message shown above the table rows (e.g., cap warning). */
  message?: string;
}

export interface LegendTableHandle {
  /** Re-render the table with new entries and optional message. */
  update(entries: LegendEntry[], message?: string): void;
  /** Highlight (or un-highlight) a row by test name. */
  highlightRow(testName: string | null): void;
  /** Remove the table and clean up listeners. */
  destroy(): void;
}

/**
 * Create a legend table listing all tests with color swatches.
 * Active tests are listed first, then inactive tests (grayed out).
 * Clicking a row calls onToggle. Hovering dispatches GRAPH_TABLE_HOVER.
 */
export function createLegendTable(
  container: HTMLElement,
  options: LegendTableOptions,
): LegendTableHandle {
  const wrapper = el('div', {});
  const messageEl = el('div', { class: 'legend-message' });
  const table = el('table', { class: 'legend-table' });
  const tbody = el('tbody');
  table.append(tbody);
  wrapper.append(messageEl, table);
  container.append(wrapper);

  let currentOnToggle = options.onToggle;
  let currentOnIsolate = options.onIsolate;

  function setMessage(msg?: string): void {
    if (msg) {
      messageEl.textContent = msg;
      messageEl.style.display = '';
    } else {
      messageEl.textContent = '';
      messageEl.style.display = 'none';
    }
  }

  function buildRows(entries: LegendEntry[]): void {
    tbody.replaceChildren();
    for (const entry of entries) {
      const tr = el('tr', { 'data-test': entry.testName });
      if (!entry.active) tr.classList.add('legend-row-inactive');

      // Colored symbol cell — symbol character rendered in the trace color
      const symbolCell = el('td', { class: 'legend-swatch-cell' });
      const symbolChar = entry.symbolChar || '●';
      const symbolSpan = el('span', { class: 'legend-symbol' }, symbolChar);
      (symbolSpan as HTMLElement).style.color = entry.color;
      symbolCell.append(symbolSpan);

      // Test name (left-justified) — extract from trace name if machine is present
      const displayTestName = entry.machineName
        ? entry.testName.replace(`${TRACE_SEP}${entry.machineName}`, '')
        : entry.testName;
      const nameCell = el('td', { class: 'legend-test-name' }, displayTestName);

      // Machine name (right-justified) — always render cell for consistent column count
      const machineCell = el('td', { class: 'legend-machine-name' }, entry.machineName ?? '');

      tr.append(symbolCell, nameCell, machineCell);

      tbody.append(tr);
    }
  }

  buildRows(options.entries);
  setMessage(options.message);

  // Click/dblclick delegation.
  // Delay single-click to distinguish from double-click: a double-click
  // fires two click events then a dblclick. We cancel the pending single-
  // click when a dblclick arrives so the toggle doesn't fire spuriously.
  let clickTimer: ReturnType<typeof setTimeout> | null = null;

  tbody.addEventListener('click', (e) => {
    const tr = (e.target as HTMLElement).closest('tr[data-test]');
    if (!tr) return;
    const testName = tr.getAttribute('data-test')!;
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      clickTimer = null;
      currentOnToggle(testName);
    }, 200);
  });

  tbody.addEventListener('dblclick', (e) => {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    const tr = (e.target as HTMLElement).closest('tr[data-test]');
    if (tr) {
      currentOnIsolate(tr.getAttribute('data-test')!);
    }
  });

  // Hover delegation
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
    update(entries: LegendEntry[], message?: string): void {
      buildRows(entries);
      setMessage(message);
    },

    highlightRow(testName: string | null): void {
      // Remove previous highlight
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
