// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderDataTable } from '../components/data-table';
import type { Column } from '../components/data-table';

interface TestRow {
  name: string;
  value: number;
}

const columns: Column<TestRow>[] = [
  { key: 'name', label: 'Name' },
  { key: 'value', label: 'Value', cellClass: 'col-num',
    sortValue: (r) => r.value },
];

const rows: TestRow[] = [
  { name: 'alpha', value: 3 },
  { name: 'beta', value: 1 },
  { name: 'gamma', value: 2 },
];

describe('renderDataTable', () => {
  it('renders a table with header and rows', () => {
    const container = document.createElement('div');
    renderDataTable(container, { columns, rows });

    const table = container.querySelector('table');
    expect(table).not.toBeNull();

    const ths = table!.querySelectorAll('th');
    expect(ths).toHaveLength(2);
    expect(ths[0].textContent).toContain('Name');
    expect(ths[1].textContent).toContain('Value');

    const trs = table!.querySelectorAll('tbody tr');
    expect(trs).toHaveLength(3);
  });

  it('shows empty message when no rows', () => {
    const container = document.createElement('div');
    renderDataTable(container, {
      columns,
      rows: [],
      emptyMessage: 'Nothing here.',
    });

    const td = container.querySelector('td.no-results');
    expect(td).not.toBeNull();
    expect(td!.textContent).toBe('Nothing here.');
  });

  it('sorts by column when header clicked', () => {
    const container = document.createElement('div');
    renderDataTable(container, { columns, rows, sortKey: 'value', sortDir: 'asc' });

    // Initial sort: value ascending → beta(1), gamma(2), alpha(3)
    let cells = container.querySelectorAll('tbody tr td:first-child');
    expect(cells[0].textContent).toBe('beta');
    expect(cells[2].textContent).toBe('alpha');

    // Click Value header to toggle to descending
    const valueHeader = container.querySelectorAll('th')[1];
    valueHeader.click();

    cells = container.querySelectorAll('tbody tr td:first-child');
    expect(cells[0].textContent).toBe('alpha');
    expect(cells[2].textContent).toBe('beta');
  });

  it('applies cellClass to data cells', () => {
    const container = document.createElement('div');
    renderDataTable(container, { columns, rows: rows.slice(0, 1) });

    const valueTd = container.querySelector('tbody tr td:nth-child(2)');
    expect(valueTd!.className).toBe('col-num');
  });

  it('calls onRowClick when a row is clicked', () => {
    const clicked: TestRow[] = [];
    const container = document.createElement('div');
    renderDataTable(container, {
      columns, rows: rows.slice(0, 1),
      onRowClick: (row) => clicked.push(row),
    });

    const tr = container.querySelector('tbody tr') as HTMLElement;
    tr.click();
    expect(clicked).toHaveLength(1);
    expect(clicked[0].name).toBe('alpha');
  });

  it('renders custom Node from render callback', () => {
    const container = document.createElement('div');
    const cols: Column<TestRow>[] = [
      { key: 'name', label: 'Name',
        render: (r) => {
          const span = document.createElement('span');
          span.className = 'custom';
          span.textContent = r.name.toUpperCase();
          return span;
        } },
    ];
    renderDataTable(container, { columns: cols, rows: rows.slice(0, 1) });

    const span = container.querySelector('tbody td span.custom');
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe('ALPHA');
  });

  it('does not add sortable class or click handler when sortable is false', () => {
    const container = document.createElement('div');
    const cols: Column<TestRow>[] = [
      { key: 'name', label: 'Name', sortable: false },
      { key: 'value', label: 'Value', sortValue: (r) => r.value },
    ];
    renderDataTable(container, { columns: cols, rows, sortKey: 'value', sortDir: 'asc' });

    const nameHeader = container.querySelectorAll('th')[0];
    expect(nameHeader.classList.contains('sortable')).toBe(false);

    // Click the non-sortable header — sort order should not change
    const cellsBefore = container.querySelectorAll('tbody tr td:first-child');
    const firstBefore = cellsBefore[0].textContent;
    nameHeader.click();
    const cellsAfter = container.querySelectorAll('tbody tr td:first-child');
    expect(cellsAfter[0].textContent).toBe(firstBefore);
  });

  it('applies rowClass to each row', () => {
    const container = document.createElement('div');
    renderDataTable(container, {
      columns, rows: rows.slice(0, 2),
      rowClass: (r) => r.value > 2 ? 'highlight' : '',
    });

    const trs = container.querySelectorAll('tbody tr');
    expect(trs[0].className).toBe('highlight'); // alpha, value=3
    expect(trs[1].className).toBe('');           // beta, value=1
  });

  it('resets sort direction to asc when clicking a different column', () => {
    const container = document.createElement('div');
    renderDataTable(container, { columns, rows, sortKey: 'value', sortDir: 'desc' });

    // Currently sorted by value desc: alpha(3), gamma(2), beta(1)
    let cells = container.querySelectorAll('tbody tr td:first-child');
    expect(cells[0].textContent).toBe('alpha');

    // Click Name header — should sort by name ascending
    const nameHeader = container.querySelectorAll('th')[0];
    nameHeader.click();

    cells = container.querySelectorAll('tbody tr td:first-child');
    expect(cells[0].textContent).toBe('alpha');
    expect(cells[1].textContent).toBe('beta');
    expect(cells[2].textContent).toBe('gamma');
  });
});
