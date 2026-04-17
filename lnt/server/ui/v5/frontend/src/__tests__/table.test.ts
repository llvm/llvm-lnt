// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { sortRows, renderTable, resetTable } from '../table';
import type { ComparisonRow } from '../types';

// Helper to create a ComparisonRow with defaults
function makeRow(overrides: Partial<ComparisonRow> & { test: string }): ComparisonRow {
  return {
    valueA: null,
    valueB: null,
    delta: null,
    deltaPct: null,
    ratio: null,
    status: 'unchanged',
    sidePresent: 'both',
    ...overrides,
  };
}

// Reusable test data
function makeTestRows(): ComparisonRow[] {
  return [
    makeRow({ test: 'bench/compile', valueA: 100, valueB: 110, delta: 10, deltaPct: 10, ratio: 1.1, status: 'regressed' }),
    makeRow({ test: 'bench/link', valueA: 50, valueB: 45, delta: -5, deltaPct: -10, ratio: 0.9, status: 'improved' }),
    makeRow({ test: 'bench/run', valueA: 200, valueB: 200, delta: 0, deltaPct: 0, ratio: 1.0, status: 'unchanged' }),
    makeRow({ test: 'bench/alloc', valueA: 75, valueB: 80, delta: 5, deltaPct: 6.67, ratio: 1.0667, status: 'noise' }),
  ];
}

describe('sortRows', () => {
  describe('sort by test name (string column)', () => {
    it('sorts ascending alphabetically', () => {
      const rows = makeTestRows();
      const sorted = sortRows(rows, 'test', 'asc');
      expect(sorted.map(r => r.test)).toEqual([
        'bench/alloc',
        'bench/compile',
        'bench/link',
        'bench/run',
      ]);
    });

    it('sorts descending alphabetically', () => {
      const rows = makeTestRows();
      const sorted = sortRows(rows, 'test', 'desc');
      expect(sorted.map(r => r.test)).toEqual([
        'bench/run',
        'bench/link',
        'bench/compile',
        'bench/alloc',
      ]);
    });
  });

  describe('sort by value_a (numeric column)', () => {
    it('sorts ascending by value_a', () => {
      const rows = makeTestRows();
      const sorted = sortRows(rows, 'value_a', 'asc');
      expect(sorted.map(r => r.valueA)).toEqual([50, 75, 100, 200]);
    });

    it('sorts descending by value_a', () => {
      const rows = makeTestRows();
      const sorted = sortRows(rows, 'value_a', 'desc');
      expect(sorted.map(r => r.valueA)).toEqual([200, 100, 75, 50]);
    });
  });

  describe('sort by value_b', () => {
    it('sorts ascending by value_b', () => {
      const rows = makeTestRows();
      const sorted = sortRows(rows, 'value_b', 'asc');
      expect(sorted.map(r => r.valueB)).toEqual([45, 80, 110, 200]);
    });

    it('sorts descending by value_b', () => {
      const rows = makeTestRows();
      const sorted = sortRows(rows, 'value_b', 'desc');
      expect(sorted.map(r => r.valueB)).toEqual([200, 110, 80, 45]);
    });
  });

  describe('sort by delta', () => {
    it('sorts ascending by delta', () => {
      const rows = makeTestRows();
      const sorted = sortRows(rows, 'delta', 'asc');
      expect(sorted.map(r => r.delta)).toEqual([-5, 0, 5, 10]);
    });

    it('sorts descending by delta', () => {
      const rows = makeTestRows();
      const sorted = sortRows(rows, 'delta', 'desc');
      expect(sorted.map(r => r.delta)).toEqual([10, 5, 0, -5]);
    });
  });

  describe('sort by delta_pct', () => {
    it('sorts ascending by delta_pct', () => {
      const rows = makeTestRows();
      const sorted = sortRows(rows, 'delta_pct', 'asc');
      expect(sorted.map(r => r.deltaPct)).toEqual([-10, 0, 6.67, 10]);
    });

    it('sorts descending by delta_pct', () => {
      const rows = makeTestRows();
      const sorted = sortRows(rows, 'delta_pct', 'desc');
      expect(sorted.map(r => r.deltaPct)).toEqual([10, 6.67, 0, -10]);
    });
  });

  describe('sort by ratio', () => {
    it('sorts ascending by ratio', () => {
      const rows = makeTestRows();
      const sorted = sortRows(rows, 'ratio', 'asc');
      expect(sorted.map(r => r.ratio)).toEqual([0.9, 1.0, 1.0667, 1.1]);
    });

    it('sorts descending by ratio', () => {
      const rows = makeTestRows();
      const sorted = sortRows(rows, 'ratio', 'desc');
      expect(sorted.map(r => r.ratio)).toEqual([1.1, 1.0667, 1.0, 0.9]);
    });
  });

  describe('sort by status (string column)', () => {
    it('sorts ascending by status', () => {
      const rows = makeTestRows();
      const sorted = sortRows(rows, 'status', 'asc');
      expect(sorted.map(r => r.status)).toEqual([
        'improved',
        'noise',
        'regressed',
        'unchanged',
      ]);
    });

    it('sorts descending by status', () => {
      const rows = makeTestRows();
      const sorted = sortRows(rows, 'status', 'desc');
      expect(sorted.map(r => r.status)).toEqual([
        'unchanged',
        'regressed',
        'noise',
        'improved',
      ]);
    });
  });

  describe('null handling', () => {
    it('pushes null values to the end regardless of sort direction (ascending)', () => {
      const rows = [
        makeRow({ test: 'a', valueA: 50 }),
        makeRow({ test: 'b', valueA: null }),
        makeRow({ test: 'c', valueA: 100 }),
        makeRow({ test: 'd', valueA: null }),
      ];
      const sorted = sortRows(rows, 'value_a', 'asc');
      expect(sorted.map(r => r.valueA)).toEqual([50, 100, null, null]);
    });

    it('pushes null values to the end regardless of sort direction (descending)', () => {
      const rows = [
        makeRow({ test: 'a', valueA: 50 }),
        makeRow({ test: 'b', valueA: null }),
        makeRow({ test: 'c', valueA: 100 }),
        makeRow({ test: 'd', valueA: null }),
      ];
      const sorted = sortRows(rows, 'value_a', 'desc');
      expect(sorted.map(r => r.valueA)).toEqual([100, 50, null, null]);
    });

    it('handles all-null columns', () => {
      const rows = [
        makeRow({ test: 'a', delta: null }),
        makeRow({ test: 'b', delta: null }),
        makeRow({ test: 'c', delta: null }),
      ];
      const sorted = sortRows(rows, 'delta', 'asc');
      // All null, order should be stable (all compare equal)
      expect(sorted).toHaveLength(3);
      expect(sorted.every(r => r.delta === null)).toBe(true);
    });

    it('sorts non-null values correctly when mixed with nulls in delta_pct', () => {
      const rows = [
        makeRow({ test: 'a', deltaPct: null }),
        makeRow({ test: 'b', deltaPct: 5 }),
        makeRow({ test: 'c', deltaPct: -3 }),
        makeRow({ test: 'd', deltaPct: null }),
        makeRow({ test: 'e', deltaPct: 10 }),
      ];
      const sorted = sortRows(rows, 'delta_pct', 'asc');
      expect(sorted.map(r => r.deltaPct)).toEqual([-3, 5, 10, null, null]);
    });

    it('sorts non-null values correctly when mixed with nulls in ratio descending', () => {
      const rows = [
        makeRow({ test: 'a', ratio: null }),
        makeRow({ test: 'b', ratio: 1.5 }),
        makeRow({ test: 'c', ratio: 0.8 }),
        makeRow({ test: 'd', ratio: null }),
      ];
      const sorted = sortRows(rows, 'ratio', 'desc');
      expect(sorted.map(r => r.ratio)).toEqual([1.5, 0.8, null, null]);
    });

    it('handles rows with only one side present (a_only has null valueB)', () => {
      const rows = [
        makeRow({ test: 'both-test', valueB: 100, sidePresent: 'both' }),
        makeRow({ test: 'a-only-test', valueB: null, sidePresent: 'a_only' }),
        makeRow({ test: 'both-test-2', valueB: 50, sidePresent: 'both' }),
      ];
      const sorted = sortRows(rows, 'value_b', 'asc');
      expect(sorted.map(r => r.valueB)).toEqual([50, 100, null]);
    });
  });

  describe('does not mutate input', () => {
    it('returns a new array, not the same reference', () => {
      const rows = makeTestRows();
      const sorted = sortRows(rows, 'test', 'asc');
      expect(sorted).not.toBe(rows);
    });

    it('preserves original array order after sorting', () => {
      const rows = makeTestRows();
      const originalOrder = rows.map(r => r.test);
      sortRows(rows, 'test', 'asc');
      expect(rows.map(r => r.test)).toEqual(originalOrder);
    });

    it('preserves original array order after sorting descending', () => {
      const rows = makeTestRows();
      const originalOrder = rows.map(r => r.test);
      sortRows(rows, 'delta_pct', 'desc');
      expect(rows.map(r => r.test)).toEqual(originalOrder);
    });

    it('preserves original array length', () => {
      const rows = makeTestRows();
      const originalLength = rows.length;
      sortRows(rows, 'value_a', 'asc');
      expect(rows).toHaveLength(originalLength);
    });
  });

  describe('edge cases', () => {
    it('returns empty array for empty input', () => {
      const sorted = sortRows([], 'test', 'asc');
      expect(sorted).toEqual([]);
    });

    it('returns single-element array unchanged', () => {
      const rows = [makeRow({ test: 'only-test', valueA: 42 })];
      const sorted = sortRows(rows, 'value_a', 'desc');
      expect(sorted).toHaveLength(1);
      expect(sorted[0].test).toBe('only-test');
    });

    it('handles rows with identical values for the sort column', () => {
      const rows = [
        makeRow({ test: 'a', valueA: 100 }),
        makeRow({ test: 'b', valueA: 100 }),
        makeRow({ test: 'c', valueA: 100 }),
      ];
      const sorted = sortRows(rows, 'value_a', 'asc');
      expect(sorted).toHaveLength(3);
      expect(sorted.every(r => r.valueA === 100)).toBe(true);
    });

    it('handles negative numeric values correctly', () => {
      const rows = [
        makeRow({ test: 'a', delta: -10 }),
        makeRow({ test: 'b', delta: -1 }),
        makeRow({ test: 'c', delta: -100 }),
      ];
      const sorted = sortRows(rows, 'delta', 'asc');
      expect(sorted.map(r => r.delta)).toEqual([-100, -10, -1]);
    });

    it('handles zero values correctly among positives and negatives', () => {
      const rows = [
        makeRow({ test: 'a', delta: 5 }),
        makeRow({ test: 'b', delta: 0 }),
        makeRow({ test: 'c', delta: -5 }),
      ];
      const sorted = sortRows(rows, 'delta', 'asc');
      expect(sorted.map(r => r.delta)).toEqual([-5, 0, 5]);
    });
  });
});

describe('geomean row', () => {
  function makeRow(overrides: Partial<ComparisonRow> & { test: string }): ComparisonRow {
    return {
      valueA: null,
      valueB: null,
      delta: null,
      deltaPct: null,
      ratio: null,
      status: 'unchanged',
      sidePresent: 'both',
      ...overrides,
    };
  }

  it('renders a geomean row with A/B values, delta, and ratio', () => {
    const container = document.createElement('div');
    const rows = [
      makeRow({ test: 'a', valueA: 100, valueB: 200, ratio: 2.0, status: 'improved' }),
      makeRow({ test: 'b', valueA: 400, valueB: 3200, ratio: 8.0, status: 'regressed' }),
    ];

    renderTable(container, rows);

    const geomeanRow = container.querySelector('.geomean-row');
    expect(geomeanRow).toBeTruthy();
    const cells = geomeanRow!.querySelectorAll('td');
    expect(cells[0].textContent).toBe('Geomean');
    // geomeanA = sqrt(100*400) = 200, geomeanB = sqrt(200*3200) = 800
    expect(cells[1].textContent).not.toBe(''); // Value A filled
    expect(cells[2].textContent).not.toBe(''); // Value B filled
    expect(cells[3].textContent).not.toBe(''); // Delta filled
    expect(cells[4].textContent).not.toBe(''); // Delta % filled
    // Ratio geomean of [2, 8] = 4.0
    expect(cells[5].textContent).toBe('4.0000');

    resetTable();
  });

  it('excludes hidden rows from geomean computation', () => {
    const container = document.createElement('div');
    // Two rows: ratio 2.0 and ratio 8.0
    // Geomean of both = sqrt(2*8) = 4.0
    // Hide 'b' (ratio 8.0) => geomean should be just ratio 2.0
    const rows = [
      makeRow({ test: 'a', valueA: 100, valueB: 200, ratio: 2.0, status: 'improved' }),
      makeRow({ test: 'b', valueA: 400, valueB: 3200, ratio: 8.0, status: 'regressed' }),
    ];

    // First render with no hidden rows: geomean ratio = 4.0
    renderTable(container, rows);
    let geomeanRow = container.querySelector('.geomean-row');
    expect(geomeanRow).toBeTruthy();
    let cells = geomeanRow!.querySelectorAll('td');
    expect(cells[5].textContent).toBe('4.0000');

    resetTable();

    // Now hide 'b': geomean should be computed from only 'a' (ratio 2.0)
    renderTable(container, rows, { hiddenTests: new Set(['b']) });
    geomeanRow = container.querySelector('.geomean-row');
    expect(geomeanRow).toBeTruthy();
    cells = geomeanRow!.querySelectorAll('td');
    expect(cells[5].textContent).toBe('2.0000');

    resetTable();
  });

  it('updates geomean when hidden rows change (simulates toggle)', () => {
    const container = document.createElement('div');
    const rows = [
      makeRow({ test: 'a', valueA: 100, valueB: 200, ratio: 2.0, status: 'improved' }),
      makeRow({ test: 'b', valueA: 400, valueB: 3200, ratio: 8.0, status: 'regressed' }),
    ];

    // Start with 'a' hidden: geomean = ratio of 'b' = 8.0
    renderTable(container, rows, { hiddenTests: new Set(['a']) });
    let cells = container.querySelector('.geomean-row')!.querySelectorAll('td');
    expect(cells[5].textContent).toBe('8.0000');

    resetTable();

    // Un-hide 'a' (empty hidden set): geomean = sqrt(2*8) = 4.0
    renderTable(container, rows, { hiddenTests: new Set() });
    cells = container.querySelector('.geomean-row')!.querySelectorAll('td');
    expect(cells[5].textContent).toBe('4.0000');

    resetTable();
  });

  it('removes geomean row when all rows are hidden', () => {
    const container = document.createElement('div');
    const rows = [
      makeRow({ test: 'a', valueA: 100, valueB: 200, ratio: 2.0, status: 'improved' }),
    ];

    // With the row visible, geomean exists
    renderTable(container, rows);
    expect(container.querySelector('.geomean-row')).toBeTruthy();
    resetTable();

    // With the only row hidden, geomean should be absent
    renderTable(container, rows, { hiddenTests: new Set(['a']) });
    expect(container.querySelector('.geomean-row')).toBeNull();
    resetTable();
  });

  it('does not render a geomean row when no valid ratios', () => {
    const container = document.createElement('div');
    const rows = [
      makeRow({ test: 'a', sidePresent: 'a_only', status: 'missing' }),
    ];

    renderTable(container, rows);

    const geomeanRow = container.querySelector('.geomean-row');
    expect(geomeanRow).toBeNull();

    resetTable();
  });
});

describe('row visibility toggling', () => {
  function makeRow(overrides: Partial<ComparisonRow> & { test: string }): ComparisonRow {
    return {
      valueA: 100,
      valueB: 110,
      delta: 10,
      deltaPct: 10,
      ratio: 1.1,
      status: 'improved',
      sidePresent: 'both',
      ...overrides,
    };
  }

  it('renders manually-hidden rows with row-hidden class', () => {
    const container = document.createElement('div');
    const rows = [
      makeRow({ test: 'a', status: 'improved' }),
      makeRow({ test: 'b', status: 'noise' }),
    ];
    const hidden = new Set(['b']);

    renderTable(container, rows, { hiddenTests: hidden });

    const rowA = container.querySelector('tr[data-test="a"]');
    const rowB = container.querySelector('tr[data-test="b"]');
    expect(rowA).toBeTruthy();
    expect(rowB).toBeTruthy();
    expect(rowA!.classList.contains('row-hidden')).toBe(false);
    expect(rowB!.classList.contains('row-hidden')).toBe(true);

    resetTable();
  });

  it('shows all rows including noise when hiddenTests is empty', () => {
    const container = document.createElement('div');
    const rows = [
      makeRow({ test: 'a', status: 'improved' }),
      makeRow({ test: 'b', status: 'noise' }),
      makeRow({ test: 'c', status: 'regressed' }),
    ];

    renderTable(container, rows, { hiddenTests: new Set() });

    const dataRows = container.querySelectorAll('tr[data-test]');
    expect(dataRows).toHaveLength(3);

    resetTable();
  });

  it('calls onToggle on single click with delay', async () => {
    const container = document.createElement('div');
    const onToggle = vi.fn();
    const rows = [makeRow({ test: 'a' })];

    renderTable(container, rows, { onToggle });

    const row = container.querySelector('tr[data-test="a"]')! as HTMLElement;
    row.click();

    // Not called immediately (200ms delay)
    expect(onToggle).not.toHaveBeenCalled();

    // Wait for delay
    await new Promise(r => setTimeout(r, 250));
    expect(onToggle).toHaveBeenCalledWith('a');

    resetTable();
  });

  it('calls onIsolate on double click without triggering onToggle', async () => {
    const container = document.createElement('div');
    const onToggle = vi.fn();
    const onIsolate = vi.fn();
    const rows = [makeRow({ test: 'a' })];

    renderTable(container, rows, { onToggle, onIsolate });

    const row = container.querySelector('tr[data-test="a"]')! as HTMLElement;
    row.click();
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    // Wait past the single-click delay
    await new Promise(r => setTimeout(r, 250));
    expect(onIsolate).toHaveBeenCalledWith('a');
    expect(onToggle).not.toHaveBeenCalled();

    resetTable();
  });
});

describe('noise-hidden vs manually-hidden separation', () => {
  function makeRow(overrides: Partial<ComparisonRow> & { test: string }): ComparisonRow {
    return {
      valueA: 100,
      valueB: 110,
      delta: 10,
      deltaPct: 10,
      ratio: 1.1,
      status: 'improved',
      sidePresent: 'both',
      ...overrides,
    };
  }

  it('noise rows excluded upstream are absent from the DOM', () => {
    // Simulates what compare.ts does when hideNoise is on: it filters
    // noise rows out of the array before calling renderTable.
    const container = document.createElement('div');
    const allRows = [
      makeRow({ test: 'a', status: 'improved' }),
      makeRow({ test: 'b', status: 'noise' }),
      makeRow({ test: 'c', status: 'regressed' }),
    ];
    // Upstream filters out noise row 'b'
    const tableRows = allRows.filter(r => r.status !== 'noise');
    renderTable(container, tableRows);

    expect(container.querySelector('tr[data-test="a"]')).toBeTruthy();
    expect(container.querySelector('tr[data-test="b"]')).toBeNull();
    expect(container.querySelector('tr[data-test="c"]')).toBeTruthy();

    resetTable();
  });

  it('visible noise row gets .row-noise class (not .row-hidden)', () => {
    // When hideNoise is off, noise rows are in the table but de-emphasized.
    const container = document.createElement('div');
    const rows = [
      makeRow({ test: 'a', status: 'improved' }),
      makeRow({ test: 'b', status: 'noise' }),
    ];
    renderTable(container, rows);

    const rowB = container.querySelector('tr[data-test="b"]')!;
    expect(rowB.classList.contains('row-noise')).toBe(true);
    expect(rowB.classList.contains('row-hidden')).toBe(false);

    resetTable();
  });

  it('.row-hidden and .row-noise classes are mutually exclusive', () => {
    const container = document.createElement('div');
    const rows = [
      makeRow({ test: 'a', status: 'improved' }),
      makeRow({ test: 'b', status: 'noise' }),
      makeRow({ test: 'c', status: 'regressed' }),
    ];
    // 'a' is manually hidden; 'b' is noise (visible); 'c' is normal
    renderTable(container, rows, { hiddenTests: new Set(['a']) });

    const rowA = container.querySelector('tr[data-test="a"]')!;
    const rowB = container.querySelector('tr[data-test="b"]')!;
    const rowC = container.querySelector('tr[data-test="c"]')!;

    // 'a': manually hidden → row-hidden, NOT row-noise
    expect(rowA.classList.contains('row-hidden')).toBe(true);
    expect(rowA.classList.contains('row-noise')).toBe(false);

    // 'b': noise visible → row-noise, NOT row-hidden
    expect(rowB.classList.contains('row-noise')).toBe(true);
    expect(rowB.classList.contains('row-hidden')).toBe(false);

    // 'c': normal → neither
    expect(rowC.classList.contains('row-hidden')).toBe(false);
    expect(rowC.classList.contains('row-noise')).toBe(false);

    resetTable();
  });

  it('summary message reflects pre-filtered input (noise excluded upstream)', () => {
    const container = document.createElement('div');
    // 3 original rows, but noise row 'b' was filtered upstream
    const tableRows = [
      makeRow({ test: 'a', status: 'improved' }),
      makeRow({ test: 'c', status: 'regressed' }),
    ];
    // 'a' is manually hidden → 1 of 2 visible
    renderTable(container, tableRows, { hiddenTests: new Set(['a']) });

    const message = container.querySelector('.table-message');
    expect(message).toBeTruthy();
    expect(message!.textContent).toBe('1 of 2 tests visible');

    resetTable();
  });
});
