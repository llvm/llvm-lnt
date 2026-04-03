import { describe, it, expect } from 'vitest';
import { prepareChartData } from '../chart';
import type { ComparisonRow } from '../types';

/** Helper to build a ComparisonRow with sensible defaults. */
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

describe('prepareChartData', () => {
  it('filters out rows where sidePresent !== "both"', () => {
    const rows: ComparisonRow[] = [
      makeRow({ test: 'a-only', sidePresent: 'a_only', ratio: 1.1 }),
      makeRow({ test: 'b-only', sidePresent: 'b_only', ratio: 1.2 }),
      makeRow({ test: 'both-ok', sidePresent: 'both', ratio: 1.05 }),
    ];
    const result = prepareChartData(rows, null);
    expect(result).not.toBeNull();
    expect(result!.sortedTests).toEqual(['both-ok']);
  });

  it('filters out rows where ratio is null', () => {
    const rows: ComparisonRow[] = [
      makeRow({ test: 'no-ratio', ratio: null }),
      makeRow({ test: 'has-ratio', ratio: 1.05 }),
    ];
    const result = prepareChartData(rows, null);
    expect(result).not.toBeNull();
    expect(result!.sortedTests).toEqual(['has-ratio']);
  });

  it('filters out rows where status is "na"', () => {
    const rows: ComparisonRow[] = [
      makeRow({ test: 'na-status', status: 'na', ratio: 1.1 }),
      makeRow({ test: 'ok-status', status: 'improved', ratio: 1.05 }),
    ];
    const result = prepareChartData(rows, null);
    expect(result).not.toBeNull();
    expect(result!.sortedTests).toEqual(['ok-status']);
  });

  it('includes noise rows (visibility is controlled by the caller)', () => {
    const rows: ComparisonRow[] = [
      makeRow({ test: 'noisy', status: 'noise', ratio: 1.001 }),
      makeRow({ test: 'improved', status: 'improved', ratio: 1.2 }),
    ];
    const result = prepareChartData(rows, null);
    expect(result).not.toBeNull();
    expect(result!.sortedTests).toContain('noisy');
    expect(result!.sortedTests).toHaveLength(2);
  });

  it('filterTests filters to specific test names', () => {
    const rows: ComparisonRow[] = [
      makeRow({ test: 'alpha', ratio: 1.1 }),
      makeRow({ test: 'beta', ratio: 1.2 }),
      makeRow({ test: 'gamma', ratio: 0.9 }),
    ];
    const filter = new Set(['alpha', 'gamma']);
    const result = prepareChartData(rows, filter);
    expect(result).not.toBeNull();
    expect(result!.sortedTests).toHaveLength(2);
    expect(result!.sortedTests).toContain('alpha');
    expect(result!.sortedTests).toContain('gamma');
    expect(result!.sortedTests).not.toContain('beta');
  });

  it('sorts by ratio ascending', () => {
    const rows: ComparisonRow[] = [
      makeRow({ test: 'high', ratio: 1.5, status: 'improved' }),
      makeRow({ test: 'low', ratio: 0.5, status: 'regressed' }),
      makeRow({ test: 'mid', ratio: 1.0, status: 'noise' }),
    ];
    const result = prepareChartData(rows, null);
    expect(result).not.toBeNull();
    expect(result!.sortedTests).toEqual(['low', 'mid', 'high']);
  });

  it('returns null when no plottable data', () => {
    // All rows filtered out: a_only, null ratio, na status
    const rows: ComparisonRow[] = [
      makeRow({ test: 'a-only', sidePresent: 'a_only' }),
      makeRow({ test: 'no-ratio', ratio: null }),
      makeRow({ test: 'na', status: 'na' }),
    ];
    expect(prepareChartData(rows, null)).toBeNull();

    // Empty input
    expect(prepareChartData([], null)).toBeNull();
  });

  it('assigns correct colors by status', () => {
    const rows: ComparisonRow[] = [
      makeRow({ test: 'imp', status: 'improved', ratio: 1.1 }),
      makeRow({ test: 'reg', status: 'regressed', ratio: 0.9 }),
      makeRow({ test: 'noi', status: 'noise', ratio: 1.001 }),
      makeRow({ test: 'unc', status: 'unchanged', ratio: 1.0 }),
    ];
    const result = prepareChartData(rows, null);
    expect(result).not.toBeNull();

    // Map test names to colors for order-independent assertions
    const colorByTest = new Map(
      result!.sortedTests.map((t, i) => [t, result!.colors[i]])
    );
    expect(colorByTest.get('imp')).toBe('#2ca02c');      // improved = green
    expect(colorByTest.get('reg')).toBe('#d62728');       // regressed = red
    expect(colorByTest.get('noi')).toBe('#999999');       // noise = grey
    expect(colorByTest.get('unc')).toBe('#1f77b4');       // unchanged/other = blue
  });

  it('computes y values as (ratio - 1) * 100', () => {
    const rows: ComparisonRow[] = [
      makeRow({ test: 'a', ratio: 1.2, status: 'improved' }),
      makeRow({ test: 'b', ratio: 0.8, status: 'regressed' }),
      makeRow({ test: 'c', ratio: 1.0, status: 'noise' }),
    ];
    const result = prepareChartData(rows, null);
    expect(result).not.toBeNull();

    // Map test names to y values for order-independent assertions
    const yByTest = new Map(
      result!.sortedTests.map((t, i) => [t, result!.y[i]])
    );
    expect(yByTest.get('a')).toBeCloseTo(20);   // (1.2 - 1) * 100
    expect(yByTest.get('b')).toBeCloseTo(-20);   // (0.8 - 1) * 100
    expect(yByTest.get('c')).toBeCloseTo(0);     // (1.0 - 1) * 100
  });

  it('produces correct customdata format', () => {
    const rows: ComparisonRow[] = [
      makeRow({
        test: 'mytest',
        valueA: 100,
        valueB: 120,
        deltaPct: 20,
        ratio: 1.2,
        status: 'improved',
      }),
    ];
    const result = prepareChartData(rows, null);
    expect(result).not.toBeNull();
    expect(result!.customdata).toHaveLength(1);

    const cd = result!.customdata[0];
    expect(cd[0]).toBe('mytest');                  // test name
    expect(cd[1]).toBe((100).toPrecision(4));      // valueA
    expect(cd[2]).toBe((120).toPrecision(4));      // valueB
    expect(cd[3]).toBe('+20.00%');                 // deltaPct with sign
    expect(cd[4]).toBe((1.2).toFixed(4));          // ratio
  });

  it('customdata handles null values', () => {
    const rows: ComparisonRow[] = [
      makeRow({
        test: 'partial',
        valueA: null,
        valueB: null,
        deltaPct: null,
        ratio: 1.05,
        status: 'noise',
      }),
    ];
    const result = prepareChartData(rows, null);
    expect(result).not.toBeNull();

    const cd = result!.customdata[0];
    expect(cd[0]).toBe('partial');
    expect(cd[1]).toBe('N/A');
    expect(cd[2]).toBe('N/A');
    expect(cd[3]).toBe('N/A');
    expect(cd[4]).toBe((1.05).toFixed(4));
  });

  it('customdata formats negative deltaPct without explicit plus sign', () => {
    const rows: ComparisonRow[] = [
      makeRow({
        test: 'regtest',
        valueA: 100,
        valueB: 80,
        deltaPct: -20,
        ratio: 0.8,
        status: 'regressed',
      }),
    ];
    const result = prepareChartData(rows, null);
    expect(result).not.toBeNull();

    const cd = result!.customdata[0];
    expect(cd[3]).toBe('-20.00%');
  });

  it('x values are sequential indices starting at 0', () => {
    const rows: ComparisonRow[] = [
      makeRow({ test: 'a', ratio: 1.1 }),
      makeRow({ test: 'b', ratio: 1.2 }),
      makeRow({ test: 'c', ratio: 0.9 }),
    ];
    const result = prepareChartData(rows, null);
    expect(result).not.toBeNull();
    expect(result!.x).toEqual([0, 1, 2]);
  });

  it('filterTests combined with noise rows', () => {
    const rows: ComparisonRow[] = [
      makeRow({ test: 'keep', status: 'improved', ratio: 1.2 }),
      makeRow({ test: 'noise-keep', status: 'noise', ratio: 1.001 }),
      makeRow({ test: 'filter-out', status: 'improved', ratio: 1.1 }),
    ];
    const filter = new Set(['keep', 'noise-keep']);
    const result = prepareChartData(rows, filter);
    expect(result).not.toBeNull();
    // noise-keep is included (caller handles visibility), filter-out is excluded
    expect(result!.sortedTests).toHaveLength(2);
    expect(result!.sortedTests).toContain('keep');
    expect(result!.sortedTests).toContain('noise-keep');
  });
});
