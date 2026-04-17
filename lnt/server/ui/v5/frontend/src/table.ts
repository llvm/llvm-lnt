import type { ComparisonRow, SortCol, SortDir } from './types';
import { TABLE_HOVER } from './events';
import { getState, setState } from './state';
import { formatValue, formatPercent, formatRatio, el } from './utils';
import { computeGeomean } from './comparison';

export interface TableOptions {
  /** Test names that are manually hidden (grayed out in table). Noise-hidden
   *  rows are filtered upstream before reaching renderTable. */
  hiddenTests?: Set<string>;
  /** Called when a row is single-clicked (toggle visibility). */
  onToggle?: (test: string) => void;
  /** Called when a row is double-clicked (isolate — hide all others). */
  onIsolate?: (test: string) => void;
}

let tableContainer: HTMLElement | null = null;
let allRows: ComparisonRow[] = [];
let filteredTests: Set<string> | null = null;  // null = show all
let currentOptions: TableOptions = {};

export function renderTable(container: HTMLElement, rows: ComparisonRow[], options?: TableOptions): void {
  tableContainer = container;
  allRows = rows;
  filteredTests = null;
  currentOptions = options ?? {};
  redraw();
}

export function filterToTests(tests: Set<string> | null): void {
  filteredTests = tests;
  redraw();
}

function redraw(): void {
  if (!tableContainer) return;
  tableContainer.replaceChildren();

  const state = getState();
  const { sort, sortDir, testFilter } = state;
  const hiddenTests = currentOptions.hiddenTests ?? new Set<string>();

  // Filter + sort
  let rows = [...allRows];

  // Text filter
  if (testFilter) {
    const lf = testFilter.toLowerCase();
    rows = rows.filter(r => r.test.toLowerCase().includes(lf));
  }

  // Chart zoom filter
  if (filteredTests) {
    rows = rows.filter(r => filteredTests!.has(r.test));
  }

  // Separate missing tests
  const presentRows = rows.filter(r => r.sidePresent === 'both');
  const missingRows = rows.filter(r => r.sidePresent !== 'both');

  // Total present tests (before text filter and zoom, but after upstream noise
  // filtering — noise rows are absent from allRows when hideNoise is on).
  const totalPresent = allRows.filter(r => r.sidePresent === 'both').length;
  const visibleCount = presentRows.filter(r => !hiddenTests.has(r.test)).length;

  // hiddenTests contains only manually-toggled rows (grayed out);
  // noise rows are filtered upstream before reaching renderTable.
  const sorted = sortRows(presentRows, sort, sortDir);

  // Summary message (like Graph page's "42 of 150 traces matching")
  if (totalPresent > 0) {
    let message: string;
    if (testFilter || filteredTests) {
      message = `${visibleCount} of ${totalPresent} tests matching`;
    } else if (visibleCount < totalPresent) {
      message = `${visibleCount} of ${totalPresent} tests visible`;
    } else {
      message = `${totalPresent} tests`;
    }
    tableContainer.append(el('div', { class: 'table-message' }, message));
  }

  // Main table
  if (sorted.length > 0) {
    tableContainer.append(buildTable(sorted, sort, sortDir, hiddenTests));
  }

  // Missing tests section
  if (missingRows.length > 0) {
    const missingHeader = el('h4', { class: 'missing-header' }, `Missing tests (${missingRows.length})`);
    tableContainer.append(missingHeader);
    tableContainer.append(buildMissingTable(missingRows));
  }
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
    tbody.append(summaryRow);
  }

  for (const row of rows) {
    const tr = el('tr', { 'data-test': row.test });

    if (hiddenTests.has(row.test)) {
      tr.classList.add('row-hidden');
    } else if (row.status === 'noise') {
      tr.classList.add('row-noise');
    } else if (row.status === 'na') {
      tr.classList.add('row-na');
    }

    tr.append(el('td', { class: 'col-test' }, row.test));
    tr.append(el('td', { class: 'col-num' }, formatValue(row.valueA)));
    tr.append(el('td', { class: 'col-num' }, formatValue(row.valueB)));
    tr.append(el('td', { class: 'col-num' }, formatValue(row.delta)));
    tr.append(el('td', { class: 'col-num' }, formatPercent(row.deltaPct)));
    tr.append(el('td', { class: 'col-num' }, formatRatio(row.ratio)));
    tr.append(el('td', { class: `col-status status-${row.status}` }, row.status));

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
  thead.append(headerRow);
  table.append(thead);

  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr', { 'data-test': row.test, class: 'row-missing' });
    tr.append(el('td', {}, row.test));
    tr.append(el('td', { class: 'col-num' }, formatValue(row.valueA)));
    tr.append(el('td', { class: 'col-num' }, formatValue(row.valueB)));
    tr.append(el('td', {}, row.sidePresent === 'a_only' ? 'Side A only' : 'Side B only'));
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
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

export function getVisibleTestNames(): Set<string> | null {
  if (!tableContainer) return null;
  const trs = tableContainer.querySelectorAll<HTMLTableRowElement>('tbody tr[data-test]');
  const names = new Set<string>();
  for (const tr of trs) {
    const name = tr.getAttribute('data-test');
    if (name) names.add(name);
  }
  return names.size > 0 ? names : null;
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
}
