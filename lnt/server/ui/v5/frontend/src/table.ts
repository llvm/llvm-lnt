import type { ComparisonRow, SortCol, SortDir } from './types';
import { TABLE_HOVER } from './events';
import { getState, setState } from './state';
import { formatValue, formatPercent, formatRatio, el, spaLink, matchesFilter } from './utils';
import { computeGeomean } from './comparison';

export interface TableOptions {
  /** Test names that are manually hidden (grayed out in table). Noise-hidden
   *  rows are filtered upstream before reaching renderTable. */
  hiddenTests?: Set<string>;
  /** Called when a row is single-clicked (toggle visibility). */
  onToggle?: (test: string) => void;
  /** Called when a row is double-clicked (isolate — hide all others). */
  onIsolate?: (test: string) => void;
  /** Map from test name to profile page URL path. When set, a Profile column appears. */
  profileLinks?: Map<string, string>;
}

let tableContainer: HTMLElement | null = null;
let allRows: ComparisonRow[] = [];
let filteredTests: Set<string> | null = null;  // null = show all
let currentOptions: TableOptions = {};
let renderedRows: Map<string, HTMLTableRowElement> = new Map();
let renderedMissingRows: Map<string, HTMLTableRowElement> = new Map();
let rowIndex: Map<string, ComparisonRow> = new Map();
let geomeanTr: HTMLTableRowElement | null = null;
let summaryMessageEl: HTMLElement | null = null;
let missingHeaderEl: HTMLElement | null = null;

export function renderTable(container: HTMLElement, rows: ComparisonRow[], options?: TableOptions): void {
  tableContainer = container;
  allRows = rows;
  filteredTests = null;
  currentOptions = options ?? {};
  redraw();
}

export function filterToTests(tests: Set<string> | null): void {
  filteredTests = tests;
  if (renderedRows.size > 0) {
    applyTableFilters();
  } else {
    redraw();
  }
}

function redraw(): void {
  if (!tableContainer) return;
  tableContainer.replaceChildren();

  // Rebuild lookup index
  renderedRows.clear();
  renderedMissingRows.clear();
  rowIndex.clear();
  geomeanTr = null;
  summaryMessageEl = null;
  missingHeaderEl = null;
  for (const r of allRows) rowIndex.set(r.test, r);

  const state = getState();
  const { sort, sortDir } = state;
  const hiddenTests = currentOptions.hiddenTests ?? new Set<string>();

  // All rows are built regardless of the active filter so the display:none
  // fast path can widen results without a full rebuild.
  const presentRows = allRows.filter(r => r.sidePresent === 'both');
  const missingRows = allRows.filter(r => r.sidePresent !== 'both');

  const sorted = sortRows(presentRows, sort, sortDir);

  const totalPresent = presentRows.length;
  if (totalPresent > 0) {
    summaryMessageEl = el('div', { class: 'table-message' }, `${totalPresent} tests`);
    tableContainer.append(summaryMessageEl);
  }

  // Main table
  if (sorted.length > 0) {
    tableContainer.append(buildTable(sorted, sort, sortDir, hiddenTests));
  }

  // Missing tests section
  if (missingRows.length > 0) {
    missingHeaderEl = el('h4', { class: 'missing-header' }, `Missing tests (${missingRows.length})`) as HTMLElement;
    tableContainer.append(missingHeaderEl);
    tableContainer.append(buildMissingTable(missingRows));
  }

  applyTableFilters();
}

function buildTable(rows: ComparisonRow[], sort: SortCol, sortDir: SortDir, hiddenTests: Set<string>): HTMLTableElement {
  const table = el('table', { class: 'comparison-table' }) as HTMLTableElement;

  // Header
  const thead = el('thead');
  const headerRow = el('tr');
  const cols: { key: SortCol; label: string }[] = [
    { key: 'test', label: 'Test' },
    { key: 'value_a', label: 'Value A' },
    { key: 'value_b', label: 'Value B' },
    { key: 'delta', label: 'Delta' },
    { key: 'delta_pct', label: 'Delta %' },
    { key: 'ratio', label: 'Ratio' },
    { key: 'status', label: 'Status' },
  ];

  for (const col of cols) {
    const isSorted = col.key === sort;
    const ariaSortValue = isSorted ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
    const th = el('th', { class: 'sortable', 'aria-sort': ariaSortValue });
    const indicator = isSorted ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';
    th.textContent = col.label + indicator;
    th.addEventListener('click', () => {
      if (sort === col.key) {
        setState({ sortDir: sortDir === 'asc' ? 'desc' : 'asc' });
      } else {
        setState({ sort: col.key, sortDir: 'desc' });
      }
      redraw();
    });
    headerRow.append(th);
  }
  if (currentOptions.profileLinks) {
    headerRow.append(el('th', {}, 'Profile'));
  }
  thead.append(headerRow);
  table.append(thead);

  // Body
  const tbody = el('tbody');

  // Geomean summary row (first row) — only visible (non-hidden) rows
  const visibleRows = rows.filter(r => !hiddenTests.has(r.test));
  const geomean = computeGeomean(visibleRows);
  if (geomean !== null) {
    const summaryRow = el('tr', { class: 'geomean-row' });
    summaryRow.append(
      el('td', { class: 'col-test' }, el('strong', {}, 'Geomean')),
      el('td', { class: 'col-num' }, formatValue(geomean.geomeanA)),
      el('td', { class: 'col-num' }, formatValue(geomean.geomeanB)),
      el('td', { class: 'col-num' }, formatValue(geomean.delta)),
      el('td', { class: 'col-num' }, formatPercent(geomean.deltaPct)),
      el('td', { class: 'col-num' }, formatRatio(geomean.ratioGeomean)),
      el('td', { class: 'col-status' }, ''),
    );
    if (currentOptions.profileLinks) {
      summaryRow.append(el('td', { class: 'col-profile' }, ''));
    }
    tbody.append(summaryRow);
    geomeanTr = summaryRow;
  }

  for (const row of rows) {
    const tr = el('tr', { 'data-test': row.test });

    if (hiddenTests.has(row.test)) {
      tr.classList.add('row-hidden');
    } else if (row.status === 'na') {
      tr.classList.add('row-na');
    }

    tr.append(el('td', { class: 'col-test' }, row.test));
    tr.append(el('td', { class: 'col-num' }, formatValue(row.valueA)));
    tr.append(el('td', { class: 'col-num' }, formatValue(row.valueB)));
    tr.append(el('td', { class: 'col-num' }, formatValue(row.delta)));
    tr.append(el('td', { class: 'col-num' }, formatPercent(row.deltaPct)));
    tr.append(el('td', { class: 'col-num' }, formatRatio(row.ratio)));
    const statusAttrs: Record<string, string> = {
      class: `col-status status-${row.status}`,
    };
    if (row.status === 'noise' && row.noiseReasons.length > 0) {
      statusAttrs.title = row.noiseReasons.map(r => r.message).join('\n');
    }
    tr.append(el('td', statusAttrs, row.status));

    if (currentOptions.profileLinks) {
      const url = currentOptions.profileLinks.get(row.test);
      if (url) {
        tr.append(el('td', { class: 'col-profile' }, spaLink('View', url)));
      } else {
        tr.append(el('td', { class: 'col-profile' }, ''));
      }
    }

    renderedRows.set(row.test, tr);
    tbody.append(tr);
  }

  // Event delegation for hover sync (1 listener instead of 2N)
  tbody.addEventListener('mouseenter', (e) => {
    const tr = (e.target as HTMLElement).closest('tr[data-test]');
    if (tr) {
      document.dispatchEvent(new CustomEvent(TABLE_HOVER, { detail: tr.getAttribute('data-test') }));
    }
  }, true);
  tbody.addEventListener('mouseleave', (e) => {
    const tr = (e.target as HTMLElement).closest('tr[data-test]');
    if (tr) {
      document.dispatchEvent(new CustomEvent(TABLE_HOVER, { detail: null }));
    }
  }, true);

  // Click/dblclick for toggle/isolate (200ms delay to distinguish, same as test-selection-table)
  if (currentOptions.onToggle || currentOptions.onIsolate) {
    let clickTimer: ReturnType<typeof setTimeout> | null = null;

    tbody.addEventListener('click', (e) => {
      const tr = (e.target as HTMLElement).closest('tr[data-test]');
      if (!tr) return;
      const test = tr.getAttribute('data-test');
      if (!test) return;

      if (clickTimer !== null) return; // dblclick pending
      clickTimer = setTimeout(() => {
        clickTimer = null;
        if (currentOptions.onToggle) currentOptions.onToggle(test);
      }, 200);
    });

    tbody.addEventListener('dblclick', (e) => {
      const tr = (e.target as HTMLElement).closest('tr[data-test]');
      if (!tr) return;
      const test = tr.getAttribute('data-test');
      if (!test) return;

      if (clickTimer !== null) {
        clearTimeout(clickTimer);
        clickTimer = null;
      }
      if (currentOptions.onIsolate) currentOptions.onIsolate(test);
    });
  }

  table.append(tbody);
  return table;
}

function buildMissingTable(rows: ComparisonRow[]): HTMLTableElement {
  const table = el('table', { class: 'comparison-table missing-table' }) as HTMLTableElement;
  const thead = el('thead');
  const headerRow = el('tr');
  headerRow.append(el('th', {}, 'Test'), el('th', {}, 'Value A'), el('th', {}, 'Value B'), el('th', {}, 'Present In'));
  if (currentOptions.profileLinks) {
    headerRow.append(el('th', {}, 'Profile'));
  }
  thead.append(headerRow);
  table.append(thead);

  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr', { 'data-test': row.test, class: 'row-missing' });
    tr.append(el('td', {}, row.test));
    tr.append(el('td', { class: 'col-num' }, formatValue(row.valueA)));
    tr.append(el('td', { class: 'col-num' }, formatValue(row.valueB)));
    tr.append(el('td', {}, row.sidePresent === 'a_only' ? 'Side A only' : 'Side B only'));
    if (currentOptions.profileLinks) {
      tr.append(el('td', { class: 'col-profile' }, ''));
    }
    renderedMissingRows.set(row.test, tr);
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

function updateGeomeanCells(tr: HTMLTableRowElement, geomean: ReturnType<typeof computeGeomean>): void {
  if (!geomean) {
    tr.style.display = 'none';
    return;
  }
  tr.style.display = '';
  const cells = tr.querySelectorAll('td');
  if (cells[1]) cells[1].textContent = formatValue(geomean.geomeanA);
  if (cells[2]) cells[2].textContent = formatValue(geomean.geomeanB);
  if (cells[3]) cells[3].textContent = formatValue(geomean.delta);
  if (cells[4]) cells[4].textContent = formatPercent(geomean.deltaPct);
  if (cells[5]) cells[5].textContent = formatRatio(geomean.ratioGeomean);
}

/** Fast path: toggle display:none on existing rows. Returns the set of matching test names. */
export function applyTableFilters(): Set<string> | null {
  if (!tableContainer || renderedRows.size === 0) return null;

  const state = getState();
  const { testFilter } = state;
  const hiddenTests = currentOptions.hiddenTests ?? new Set<string>();

  const visibleRows: ComparisonRow[] = [];
  const matchingTests = new Set<string>();
  let totalPresent = 0;

  for (const [test, tr] of renderedRows) {
    totalPresent++;

    const matchesText = !testFilter || matchesFilter(test, testFilter);
    const matchesZoom = !filteredTests || filteredTests.has(test);
    const visible = matchesText && matchesZoom;

    tr.style.display = visible ? '' : 'none';
    if (matchesText) matchingTests.add(test);
    if (visible && !hiddenTests.has(test)) {
      const row = rowIndex.get(test);
      if (row) visibleRows.push(row);
    }
  }

  let visibleMissing = 0;
  for (const [test, tr] of renderedMissingRows) {
    const matchesText = !testFilter || matchesFilter(test, testFilter);
    const matchesZoom = !filteredTests || filteredTests.has(test);
    const visible = matchesText && matchesZoom;
    tr.style.display = visible ? '' : 'none';
    if (visible) visibleMissing++;
  }

  if (missingHeaderEl) {
    const totalMissing = renderedMissingRows.size;
    if (testFilter || filteredTests) {
      missingHeaderEl.textContent = `Missing tests (${visibleMissing} of ${totalMissing} matching)`;
    } else {
      missingHeaderEl.textContent = `Missing tests (${totalMissing})`;
    }
  }

  if (geomeanTr) {
    const geomean = computeGeomean(visibleRows);
    updateGeomeanCells(geomeanTr, geomean);
  }

  if (summaryMessageEl) {
    const visibleCount = visibleRows.length;
    if (testFilter || filteredTests) {
      summaryMessageEl.textContent = `${visibleCount} of ${totalPresent} tests matching`;
    } else if (visibleCount < totalPresent) {
      summaryMessageEl.textContent = `${visibleCount} of ${totalPresent} tests visible`;
    } else {
      summaryMessageEl.textContent = `${totalPresent} tests`;
    }
  }

  return testFilter ? matchingTests : null;
}

export function sortRows(rows: ComparisonRow[], col: SortCol, dir: SortDir): ComparisonRow[] {
  const mult = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let av: number | string | null;
    let bv: number | string | null;
    switch (col) {
      case 'test': av = a.test; bv = b.test; break;
      case 'value_a': av = a.valueA; bv = b.valueA; break;
      case 'value_b': av = a.valueB; bv = b.valueB; break;
      case 'delta': av = a.delta; bv = b.delta; break;
      case 'delta_pct': av = a.deltaPct; bv = b.deltaPct; break;
      case 'ratio': av = a.ratio; bv = b.ratio; break;
      case 'status': av = a.status; bv = b.status; break;
    }
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === 'string' && typeof bv === 'string') {
      return av.localeCompare(bv) * mult;
    }
    return ((av as number) - (bv as number)) * mult;
  });
}

// External: highlight a row by test name
export function highlightRow(testName: string | null): void {
  if (!tableContainer) return;
  // Remove previous highlights
  for (const el of tableContainer.querySelectorAll('.row-highlighted')) {
    el.classList.remove('row-highlighted');
  }
  if (!testName) return;
  const tr = tableContainer.querySelector(`tr[data-test="${CSS.escape(testName)}"]`);
  if (tr) {
    tr.classList.add('row-highlighted');
  }
}

/** Reset module-level state. Call from page unmount. */
export function resetTable(): void {
  tableContainer = null;
  allRows = [];
  filteredTests = null;
  currentOptions = {};
  renderedRows.clear();
  renderedMissingRows.clear();
  rowIndex.clear();
  geomeanTr = null;
  summaryMessageEl = null;
  missingHeaderEl = null;
}
