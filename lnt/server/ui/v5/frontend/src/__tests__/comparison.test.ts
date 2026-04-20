import { describe, it, expect } from 'vitest';
import {
  aggregateSamplesWithinRun,
  aggregateAcrossRuns,
  computeComparison,
  computeGeomean,
} from '../comparison';
import type { SampleInfo, ComparisonRow } from '../types';

describe('aggregateSamplesWithinRun', () => {
  it('groups by test name and applies median', () => {
    const samples: SampleInfo[] = [
      { test: 'foo', metrics: { exec_time: 10 } },
      { test: 'foo', metrics: { exec_time: 20 } },
      { test: 'foo', metrics: { exec_time: 30 } },
      { test: 'bar', metrics: { exec_time: 5 } },
    ];
    const result = aggregateSamplesWithinRun(samples, 'exec_time', 'median');
    expect(result.get('foo')).toBe(20);
    expect(result.get('bar')).toBe(5);
  });

  it('skips null metric values', () => {
    const samples: SampleInfo[] = [
      { test: 'foo', metrics: { exec_time: 10 } },
      { test: 'foo', metrics: { exec_time: null } },
      { test: 'foo', metrics: { exec_time: 30 } },
    ];
    const result = aggregateSamplesWithinRun(samples, 'exec_time', 'mean');
    expect(result.get('foo')).toBe(20); // mean(10, 30) = 20
  });

  it('skips samples missing the metric entirely', () => {
    const samples: SampleInfo[] = [
      { test: 'foo', metrics: { other_metric: 10 } },
    ];
    const result = aggregateSamplesWithinRun(samples, 'exec_time', 'median');
    expect(result.size).toBe(0);
  });

  it('returns empty map for empty samples', () => {
    const result = aggregateSamplesWithinRun([], 'exec_time', 'median');
    expect(result.size).toBe(0);
  });

  it('uses the specified aggregation function', () => {
    const samples: SampleInfo[] = [
      { test: 'foo', metrics: { exec_time: 10 } },
      { test: 'foo', metrics: { exec_time: 20 } },
      { test: 'foo', metrics: { exec_time: 30 } },
    ];
    expect(aggregateSamplesWithinRun(samples, 'exec_time', 'min').get('foo')).toBe(10);
    expect(aggregateSamplesWithinRun(samples, 'exec_time', 'max').get('foo')).toBe(30);
    expect(aggregateSamplesWithinRun(samples, 'exec_time', 'mean').get('foo')).toBe(20);
  });
});

describe('aggregateAcrossRuns', () => {
  it('returns empty map for empty array', () => {
    expect(aggregateAcrossRuns([], 'median').size).toBe(0);
  });

  it('returns the single map directly', () => {
    const m = new Map([['foo', 10], ['bar', 20]]);
    const result = aggregateAcrossRuns([m], 'median');
    expect(result).toEqual(m);
  });

  it('aggregates across multiple maps with overlapping tests', () => {
    const m1 = new Map([['foo', 10], ['bar', 20]]);
    const m2 = new Map([['foo', 30], ['bar', 40]]);
    const result = aggregateAcrossRuns([m1, m2], 'mean');
    expect(result.get('foo')).toBe(20); // mean(10, 30)
    expect(result.get('bar')).toBe(30); // mean(20, 40)
  });

  it('handles disjoint tests across maps', () => {
    const m1 = new Map([['foo', 10]]);
    const m2 = new Map([['bar', 20]]);
    const result = aggregateAcrossRuns([m1, m2], 'median');
    expect(result.get('foo')).toBe(10);
    expect(result.get('bar')).toBe(20);
  });

  it('handles partial overlap', () => {
    const m1 = new Map([['foo', 10], ['bar', 20]]);
    const m2 = new Map([['bar', 40], ['baz', 50]]);
    const result = aggregateAcrossRuns([m1, m2], 'mean');
    expect(result.get('foo')).toBe(10);   // only in m1
    expect(result.get('bar')).toBe(30);   // mean(20, 40)
    expect(result.get('baz')).toBe(50);   // only in m2
  });
});

describe('computeComparison', () => {
  it('marks improvement when bigger_is_better=true and B > A', () => {
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 120]]);
    const rows = computeComparison(mapA, mapB, true, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].test).toBe('foo');
    expect(rows[0].status).toBe('improved');
    expect(rows[0].delta).toBe(20);
    expect(rows[0].deltaPct).toBeCloseTo(20);
    expect(rows[0].ratio).toBeCloseTo(1.2);
    expect(rows[0].sidePresent).toBe('both');
  });

  it('marks regression when bigger_is_better=true and B < A', () => {
    const mapA = new Map([['foo', 120]]);
    const mapB = new Map([['foo', 100]]);
    const rows = computeComparison(mapA, mapB, true, 1);
    expect(rows[0].test).toBe('foo');
    expect(rows[0].status).toBe('regressed');
  });

  it('flips direction when bigger_is_better=false', () => {
    // Lower is better: B < A means improvement
    const mapA = new Map([['foo', 120]]);
    const mapB = new Map([['foo', 100]]);
    const rows = computeComparison(mapA, mapB, false, 1);
    expect(rows[0].test).toBe('foo');
    expect(rows[0].status).toBe('improved');

    // Lower is better: B > A means regression
    const mapA2 = new Map([['foo', 100]]);
    const mapB2 = new Map([['foo', 120]]);
    const rows2 = computeComparison(mapA2, mapB2, false, 1);
    expect(rows2[0].test).toBe('foo');
    expect(rows2[0].status).toBe('regressed');
  });

  it('marks noise when delta % is within threshold', () => {
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 100.5]]); // 0.5% change, threshold is 1%
    const rows = computeComparison(mapA, mapB, true, 1);
    expect(rows[0].test).toBe('foo');
    expect(rows[0].status).toBe('noise');
  });

  it('handles zero baseline (valueA=0)', () => {
    const mapA = new Map([['foo', 0]]);
    const mapB = new Map([['foo', 5]]);
    const rows = computeComparison(mapA, mapB, true, 1);
    expect(rows[0].test).toBe('foo');
    expect(rows[0].status).toBe('na');
    expect(rows[0].delta).toBe(5);
    expect(rows[0].deltaPct).toBeNull();
    expect(rows[0].ratio).toBeNull();
  });

  it('handles both values zero', () => {
    const mapA = new Map([['foo', 0]]);
    const mapB = new Map([['foo', 0]]);
    const rows = computeComparison(mapA, mapB, true, 1);
    expect(rows[0].test).toBe('foo');
    expect(rows[0].status).toBe('na');
    expect(rows[0].delta).toBe(0);
    expect(rows[0].deltaPct).toBeNull();
    expect(rows[0].ratio).toBeNull();
  });

  it('handles negative baseline with Math.abs in deltaPct', () => {
    const mapA = new Map([['foo', -10]]);
    const mapB = new Map([['foo', -5]]);
    const rows = computeComparison(mapA, mapB, true, 1);
    // delta = -5 - (-10) = 5, deltaPct = 5/10 * 100 = 50%
    expect(rows[0].test).toBe('foo');
    expect(rows[0].delta).toBe(5);
    expect(rows[0].deltaPct).toBeCloseTo(50);
    expect(rows[0].ratio).toBeCloseTo(0.5); // -5 / -10
    expect(rows[0].status).toBe('improved'); // bigger is better, delta > 0
  });

  it('marks missing when test only in side A', () => {
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map<string, number>();
    const rows = computeComparison(mapA, mapB, true, 1);
    expect(rows[0].test).toBe('foo');
    expect(rows[0].status).toBe('missing');
    expect(rows[0].sidePresent).toBe('a_only');
    expect(rows[0].valueA).toBe(100);
    expect(rows[0].valueB).toBeNull();
  });

  it('marks missing when test only in side B', () => {
    const mapA = new Map<string, number>();
    const mapB = new Map([['foo', 100]]);
    const rows = computeComparison(mapA, mapB, true, 1);
    expect(rows[0].test).toBe('foo');
    expect(rows[0].status).toBe('missing');
    expect(rows[0].sidePresent).toBe('b_only');
    expect(rows[0].valueA).toBeNull();
    expect(rows[0].valueB).toBe(100);
  });

  it('returns empty for empty maps', () => {
    const rows = computeComparison(new Map(), new Map(), true, 1);
    expect(rows).toHaveLength(0);
  });
});

describe('computeComparison — noise boundary edge cases', () => {
  it('classifies exactly-at-threshold change as noise (<=)', () => {
    // 5% change with noiseThreshold=5 => deltaPct === threshold => noise
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 105]]);
    const rows = computeComparison(mapA, mapB, true, 5);
    expect(rows[0].test).toBe('foo');
    expect(rows[0].deltaPct).toBeCloseTo(5);
    expect(rows[0].status).toBe('noise');
  });

  it('classifies exactly-at-threshold negative change as noise', () => {
    // -5% change with noiseThreshold=5 => |deltaPct| === threshold => noise
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 95]]);
    const rows = computeComparison(mapA, mapB, true, 5);
    expect(rows[0].test).toBe('foo');
    expect(rows[0].deltaPct).toBeCloseTo(-5);
    expect(rows[0].status).toBe('noise');
  });

  it('classifies just-above-threshold change as improved (bigger_is_better=true)', () => {
    // 5.01% change with noiseThreshold=5 => exceeds threshold => improved
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 105.01]]);
    const rows = computeComparison(mapA, mapB, true, 5);
    expect(rows[0].test).toBe('foo');
    expect(rows[0].deltaPct).toBeGreaterThan(5);
    expect(rows[0].status).toBe('improved');
  });

  it('classifies just-above-threshold negative change as regressed (bigger_is_better=true)', () => {
    // -5.01% change with noiseThreshold=5 => exceeds threshold => regressed
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 94.99]]);
    const rows = computeComparison(mapA, mapB, true, 5);
    expect(rows[0].test).toBe('foo');
    expect(rows[0].deltaPct).toBeLessThan(-5);
    expect(rows[0].status).toBe('regressed');
  });

  it('classifies just-below-threshold change as noise', () => {
    // 4.99% change with noiseThreshold=5 => below threshold => noise
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 104.99]]);
    const rows = computeComparison(mapA, mapB, true, 5);
    expect(rows[0].test).toBe('foo');
    expect(rows[0].deltaPct).toBeCloseTo(4.99);
    expect(rows[0].status).toBe('noise');
  });

  it('with noiseThreshold=0, tiny positive change is improved', () => {
    // Even 0.001% change should not be noise when threshold is 0
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 100.001]]);
    const rows = computeComparison(mapA, mapB, true, 0);
    expect(rows[0].test).toBe('foo');
    expect(rows[0].deltaPct).toBeGreaterThan(0);
    expect(rows[0].status).toBe('improved');
  });

  it('with noiseThreshold=0, tiny negative change is regressed', () => {
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 99.999]]);
    const rows = computeComparison(mapA, mapB, true, 0);
    expect(rows[0].test).toBe('foo');
    expect(rows[0].deltaPct).toBeLessThan(0);
    expect(rows[0].status).toBe('regressed');
  });

  it('with noiseThreshold=0, delta=0 is still noise', () => {
    // Identical values => deltaPct=0, and |0| <= 0 is true => noise
    const mapA = new Map([['foo', 42]]);
    const mapB = new Map([['foo', 42]]);
    const rows = computeComparison(mapA, mapB, true, 0);
    expect(rows[0].test).toBe('foo');
    expect(rows[0].delta).toBe(0);
    expect(rows[0].deltaPct).toBe(0);
    expect(rows[0].status).toBe('noise');
  });

  it('delta=0 is noise regardless of noise threshold', () => {
    // With a large threshold, zero delta is obviously noise
    const mapA = new Map([['foo', 50]]);
    const mapB = new Map([['foo', 50]]);
    const rowsLarge = computeComparison(mapA, mapB, true, 10);
    expect(rowsLarge[0].test).toBe('foo');
    expect(rowsLarge[0].status).toBe('noise');

    // With threshold=0, zero delta is still noise
    const rowsZero = computeComparison(mapA, mapB, false, 0);
    expect(rowsZero[0].test).toBe('foo');
    expect(rowsZero[0].status).toBe('noise');

    // With a tiny threshold, zero delta is still noise
    const rowsTiny = computeComparison(mapA, mapB, true, 0.001);
    expect(rowsTiny[0].test).toBe('foo');
    expect(rowsTiny[0].status).toBe('noise');
  });

  it('with noiseThreshold=0 and bigger_is_better=false, tiny changes are classified correctly', () => {
    // Lower is better: B < A => improved
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 99.999]]);
    const rows = computeComparison(mapA, mapB, false, 0);
    expect(rows[0].test).toBe('foo');
    expect(rows[0].status).toBe('improved');

    // Lower is better: B > A => regressed
    const mapA2 = new Map([['foo', 100]]);
    const mapB2 = new Map([['foo', 100.001]]);
    const rows2 = computeComparison(mapA2, mapB2, false, 0);
    expect(rows2[0].test).toBe('foo');
    expect(rows2[0].status).toBe('regressed');
  });
});

describe('computeComparison — multi-test mixed status', () => {
  it('produces all status types in a single call and returns correct fields per row', () => {
    // bigger_is_better=true, noiseThreshold=5%
    //
    // improved:  test-improved  A=100, B=120 => delta=20, deltaPct=20%, ratio=1.2
    // regressed: test-regressed A=100, B=70  => delta=-30, deltaPct=-30%, ratio=0.7
    // noise:     test-noise     A=100, B=103 => delta=3, deltaPct=3% (within 5%)
    // a_only:    test-a-only    A=200, B=absent
    // b_only:    test-b-only    A=absent, B=300

    const mapA = new Map<string, number>([
      ['test-improved', 100],
      ['test-regressed', 100],
      ['test-noise', 100],
      ['test-a-only', 200],
    ]);

    const mapB = new Map<string, number>([
      ['test-improved', 120],
      ['test-regressed', 70],
      ['test-noise', 103],
      ['test-b-only', 300],
    ]);

    const rows = computeComparison(mapA, mapB, true, 5);
    expect(rows).toHaveLength(5);

    // Index into rows by test name for order-independent assertions
    const byTest = new Map(rows.map(r => [r.test, r]));

    // improved
    const improved = byTest.get('test-improved')!;
    expect(improved.test).toBe('test-improved');
    expect(improved.status).toBe('improved');
    expect(improved.valueA).toBe(100);
    expect(improved.valueB).toBe(120);
    expect(improved.delta).toBe(20);
    expect(improved.deltaPct).toBeCloseTo(20);
    expect(improved.ratio).toBeCloseTo(1.2);
    expect(improved.sidePresent).toBe('both');

    // regressed
    const regressed = byTest.get('test-regressed')!;
    expect(regressed.test).toBe('test-regressed');
    expect(regressed.status).toBe('regressed');
    expect(regressed.valueA).toBe(100);
    expect(regressed.valueB).toBe(70);
    expect(regressed.delta).toBe(-30);
    expect(regressed.deltaPct).toBeCloseTo(-30);
    expect(regressed.ratio).toBeCloseTo(0.7);
    expect(regressed.sidePresent).toBe('both');

    // noise (within threshold)
    const noise = byTest.get('test-noise')!;
    expect(noise.test).toBe('test-noise');
    expect(noise.status).toBe('noise');
    expect(noise.valueA).toBe(100);
    expect(noise.valueB).toBe(103);
    expect(noise.delta).toBe(3);
    expect(noise.deltaPct).toBeCloseTo(3);
    expect(noise.ratio).toBeCloseTo(1.03);
    expect(noise.sidePresent).toBe('both');

    // a_only (missing from side B)
    const aOnly = byTest.get('test-a-only')!;
    expect(aOnly.test).toBe('test-a-only');
    expect(aOnly.status).toBe('missing');
    expect(aOnly.valueA).toBe(200);
    expect(aOnly.valueB).toBeNull();
    expect(aOnly.delta).toBeNull();
    expect(aOnly.deltaPct).toBeNull();
    expect(aOnly.ratio).toBeNull();
    expect(aOnly.sidePresent).toBe('a_only');

    // b_only (missing from side A)
    const bOnly = byTest.get('test-b-only')!;
    expect(bOnly.test).toBe('test-b-only');
    expect(bOnly.status).toBe('missing');
    expect(bOnly.valueA).toBeNull();
    expect(bOnly.valueB).toBe(300);
    expect(bOnly.delta).toBeNull();
    expect(bOnly.deltaPct).toBeNull();
    expect(bOnly.ratio).toBeNull();
    expect(bOnly.sidePresent).toBe('b_only');
  });
});

describe('computeGeomean', () => {
  function makeRow(overrides: Partial<ComparisonRow>): ComparisonRow {
    return {
      test: 'test',
      valueA: 100,
      valueB: 120,
      delta: 20,
      deltaPct: 20,
      ratio: 1.2,
      status: 'improved',
      sidePresent: 'both',
      ...overrides,
    };
  }

  it('returns null for empty rows', () => {
    expect(computeGeomean([])).toBeNull();
  });

  it('returns null when all rows are missing', () => {
    const rows = [
      makeRow({ sidePresent: 'a_only', ratio: null, valueB: null, status: 'missing' }),
      makeRow({ sidePresent: 'b_only', ratio: null, valueA: null, status: 'missing' }),
    ];
    expect(computeGeomean(rows)).toBeNull();
  });

  it('returns null when all rows are na', () => {
    const rows = [makeRow({ status: 'na', ratio: 1.5 })];
    expect(computeGeomean(rows)).toBeNull();
  });

  it('computes correct ratio geomean for known values', () => {
    // geomean of ratios [2, 8] = sqrt(16) = 4
    const rows = [
      makeRow({ valueA: 50, valueB: 100, ratio: 2 }),
      makeRow({ valueA: 10, valueB: 80, ratio: 8 }),
    ];
    const result = computeGeomean(rows)!;
    expect(result).not.toBeNull();
    expect(result.ratioGeomean).toBeCloseTo(4);
  });

  it('computes geomeanA and geomeanB from absolute values', () => {
    // geomean([100, 400]) = sqrt(40000) = 200
    // geomean([200, 800]) = sqrt(160000) = 400
    const rows = [
      makeRow({ valueA: 100, valueB: 200, ratio: 2 }),
      makeRow({ valueA: 400, valueB: 800, ratio: 2 }),
    ];
    const result = computeGeomean(rows)!;
    expect(result.geomeanA).toBeCloseTo(200);
    expect(result.geomeanB).toBeCloseTo(400);
    expect(result.delta).toBeCloseTo(200);
    expect(result.deltaPct).toBeCloseTo(100); // 200/200 * 100
  });

  it('ignores rows with null ratio', () => {
    const rows = [
      makeRow({ valueA: 50, valueB: 100, ratio: 2 }),
      makeRow({ ratio: null, status: 'improved' }),
      makeRow({ valueA: 10, valueB: 80, ratio: 8 }),
    ];
    const result = computeGeomean(rows)!;
    expect(result.ratioGeomean).toBeCloseTo(4);
  });

  it('ignores a_only and b_only rows', () => {
    const rows = [
      makeRow({ valueA: 50, valueB: 100, ratio: 2 }),
      makeRow({ sidePresent: 'a_only', ratio: null, valueB: null, status: 'missing' }),
      makeRow({ valueA: 10, valueB: 80, ratio: 8 }),
    ];
    const result = computeGeomean(rows)!;
    expect(result.ratioGeomean).toBeCloseTo(4);
  });

  it('single row: geomean equals the values', () => {
    const rows = [makeRow({ valueA: 100, valueB: 150, ratio: 1.5 })];
    const result = computeGeomean(rows)!;
    expect(result.geomeanA).toBeCloseTo(100);
    expect(result.geomeanB).toBeCloseTo(150);
    expect(result.ratioGeomean).toBeCloseTo(1.5);
  });

  it('all ratios = 1.0: ratio geomean = 1.0', () => {
    const rows = [
      makeRow({ valueA: 100, valueB: 100, ratio: 1.0, status: 'noise' }),
      makeRow({ valueA: 200, valueB: 200, ratio: 1.0, status: 'noise' }),
      makeRow({ valueA: 50, valueB: 50, ratio: 1.0, status: 'noise' }),
    ];
    const result = computeGeomean(rows)!;
    expect(result.ratioGeomean).toBeCloseTo(1.0);
    expect(result.delta).toBeCloseTo(0);
  });

  it('returns null when valueA is zero (status=na is filtered out)', () => {
    // In real data, valueA=0 produces status='na', which is excluded
    const rows = [makeRow({ valueA: 0, valueB: 10, ratio: null, status: 'na' })];
    expect(computeGeomean(rows)).toBeNull();
  });

  it('produces valid geomean for negative values', () => {
    // Both sides negative: geomean of absolute values
    // |valueA| = [10, 40], geomean = sqrt(400) = 20
    // |valueB| = [20, 80], geomean = sqrt(1600) = 40
    const rows = [
      makeRow({ valueA: -10, valueB: -20, ratio: 2, status: 'improved' }),
      makeRow({ valueA: -40, valueB: -80, ratio: 2, status: 'improved' }),
    ];
    const result = computeGeomean(rows)!;
    expect(result).not.toBeNull();
    expect(result.geomeanA).toBeCloseTo(20);
    expect(result.geomeanB).toBeCloseTo(40);
    expect(result.ratioGeomean).toBeCloseTo(2);
    expect(Number.isNaN(result.geomeanA)).toBe(false);
    expect(Number.isNaN(result.geomeanB)).toBe(false);
  });

  it('excludes rows with zero values', () => {
    // Row with valueB=0 should be excluded; only the non-zero row contributes
    const rows = [
      makeRow({ valueA: 100, valueB: 200, ratio: 2, status: 'improved' }),
      makeRow({ valueA: 50, valueB: 0, ratio: 0, status: 'improved' }),
    ];
    const result = computeGeomean(rows)!;
    expect(result).not.toBeNull();
    expect(result.geomeanA).toBeCloseTo(100);
    expect(result.geomeanB).toBeCloseTo(200);
    expect(result.ratioGeomean).toBeCloseTo(2);
    expect(Number.isFinite(result.geomeanA)).toBe(true);
    expect(Number.isFinite(result.geomeanB)).toBe(true);
  });

  it('returns null when all rows have zero values', () => {
    const rows = [
      makeRow({ valueA: 0, valueB: 0, ratio: null, status: 'na' }),
      makeRow({ valueA: 0, valueB: 5, ratio: null, status: 'na' }),
    ];
    expect(computeGeomean(rows)).toBeNull();
  });

  it('handles mixed positive and negative values correctly', () => {
    // Mix of positive and negative: geomean uses absolute values
    // |valueA| = [100, 50], geomean = sqrt(5000) ≈ 70.71
    // |valueB| = [200, 25], geomean = sqrt(5000) ≈ 70.71
    const rows = [
      makeRow({ valueA: 100, valueB: 200, ratio: 2, status: 'improved' }),
      makeRow({ valueA: -50, valueB: -25, ratio: 0.5, status: 'regressed' }),
    ];
    const result = computeGeomean(rows)!;
    expect(result).not.toBeNull();
    expect(Number.isNaN(result.geomeanA)).toBe(false);
    expect(Number.isNaN(result.geomeanB)).toBe(false);
    expect(Number.isFinite(result.geomeanA)).toBe(true);
    expect(Number.isFinite(result.geomeanB)).toBe(true);
    expect(result.geomeanA).toBeCloseTo(Math.sqrt(100 * 50));
    expect(result.geomeanB).toBeCloseTo(Math.sqrt(200 * 25));
    expect(result.ratioGeomean).toBeCloseTo(1); // geomean([2, 0.5]) = sqrt(1) = 1
  });
});
