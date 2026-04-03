// components/data-table.ts — Reusable sortable data table.

import { el } from '../utils';

export interface Column<T> {
  key: string;
  label: string;
  /** Custom cell content. Return a string or DOM node. */
  render?: (row: T) => string | Node;
  /** Extract a sortable value. Defaults to render text content. */
  sortValue?: (row: T) => string | number | null;
  /** CSS class for the cell (e.g. 'col-num'). */
  cellClass?: string;
  /** Whether this column is sortable (default true). */
  sortable?: boolean;
}

export interface DataTableOptions<T> {
  columns: Column<T>[];
  rows: T[];
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
  onRowClick?: (row: T) => void;
  rowClass?: (row: T) => string;
  emptyMessage?: string;
}

/**
 * Render a sortable data table into the given container.
 * Clicking a column header sorts by that column.
 */
export function renderDataTable<T>(
  container: HTMLElement,
  options: DataTableOptions<T>,
): void {
  let currentSortKey = options.sortKey || '';
  let currentSortDir: 'asc' | 'desc' = options.sortDir || 'asc';
  let sortedRows = sortRows(options.rows, options.columns, currentSortKey, currentSortDir);

  const table = el('table', { class: 'comparison-table data-table' });
  const thead = el('thead', {});
  const headerRow = el('tr', {});
  thead.append(headerRow);
  table.append(thead);

  const tbody = el('tbody', {});
  table.append(tbody);

  function rebuildHeader(): void {
    headerRow.replaceChildren();
    for (const col of options.columns) {
      const sortable = col.sortable !== false;
      const th = el('th', {
        class: sortable ? 'sortable' : '',
      }, col.label);
      if (col.cellClass) th.classList.add(col.cellClass);
      if (sortable && col.key === currentSortKey) {
        th.append(currentSortDir === 'asc' ? ' \u25B2' : ' \u25BC');
      }
      if (sortable) {
        th.addEventListener('click', () => {
          if (currentSortKey === col.key) {
            currentSortDir = currentSortDir === 'asc' ? 'desc' : 'asc';
          } else {
            currentSortKey = col.key;
            currentSortDir = 'asc';
          }
          sortedRows = sortRows(options.rows, options.columns, currentSortKey, currentSortDir);
          rebuildHeader();
          rebuildBody();
        });
      }
      headerRow.append(th);
    }
  }

  function rebuildBody(): void {
    tbody.replaceChildren();
    if (sortedRows.length === 0) {
      const emptyRow = el('tr', {});
      const emptyCell = el('td', {
        colspan: String(options.columns.length),
        class: 'no-results',
      }, options.emptyMessage || 'No data.');
      emptyRow.append(emptyCell);
      tbody.append(emptyRow);
      return;
    }
    for (const row of sortedRows) {
      const tr = el('tr', {});
      if (options.rowClass) {
        const cls = options.rowClass(row);
        if (cls) tr.className = cls;
      }
      if (options.onRowClick) {
        tr.style.cursor = 'pointer';
        const handler = options.onRowClick;
        tr.addEventListener('click', () => handler(row));
      }
      for (const col of options.columns) {
        const td = el('td', {});
        if (col.cellClass) td.className = col.cellClass;
        if (col.render) {
          const content = col.render(row);
          if (typeof content === 'string') {
            td.textContent = content;
          } else {
            td.append(content);
          }
        } else {
          td.textContent = String((row as Record<string, unknown>)[col.key] ?? '');
        }
        tr.append(td);
      }
      tbody.append(tr);
    }
  }

  rebuildHeader();
  rebuildBody();
  container.append(table);
}

function sortRows<T>(
  rows: T[],
  columns: Column<T>[],
  sortKey: string,
  sortDir: 'asc' | 'desc',
): T[] {
  if (!sortKey) return [...rows];
  const col = columns.find(c => c.key === sortKey);
  if (!col) return [...rows];

  const sorted = [...rows].sort((a, b) => {
    const va = col.sortValue ? col.sortValue(a) : (a as Record<string, unknown>)[sortKey];
    const vb = col.sortValue ? col.sortValue(b) : (b as Record<string, unknown>)[sortKey];
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return va - vb;
    return String(va).localeCompare(String(vb));
  });
  if (sortDir === 'desc') sorted.reverse();
  return sorted;
}
