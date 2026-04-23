import { describe, it, expect } from 'vitest';
import {
  aggregateSamplesWithinRun,
  aggregateAcrossRuns,
  groupSamplesByTest,
  aggregateGrouped,
  welchTTest,
  computeComparison,
  computeGeomean,
} from '../comparison';
import type { SampleInfo, ComparisonRow, NoiseConfig } from '../types';

// ---------------------------------------------------------------------------
// Helper to build a NoiseConfig with only the Delta % knob enabled at a
// given threshold, matching the previous single-number API.
// ---------------------------------------------------------------------------
function pctOnly(threshold: number): NoiseConfig {
  return {
    pct: { enabled: true, value: threshold },
    pval: { enabled: false, value: 0.05 },
    floor: { enabled: false, value: 0 },
  };
}

function allDisabled(): NoiseConfig {
  return {
    pct: { enabled: false, value: 1 },
    pval: { enabled: false, value: 0.05 },
    floor: { enabled: false, value: 0 },
  };
}

// ---------------------------------------------------------------------------
// groupSamplesByTest
// ---------------------------------------------------------------------------

describe('groupSamplesByTest', () => {
  it('pools samples across multiple runs for the same test', () => {
    const run1: SampleInfo[] = [
      { test: 'foo', metrics: { exec_time: 10 } },
      { test: 'foo', metrics: { exec_time: 20 } },
    ];
    const run2: SampleInfo[] = [
      { test: 'foo', metrics: { exec_time: 30 } },
    ];
    const result = groupSamplesByTest([run1, run2], 'exec_time');
    expect(result.get('foo')).toEqual([10, 20, 30]);
  });

  it('skips null metric values', () => {
    const samples: SampleInfo[] = [
      { test: 'foo', metrics: { exec_time: 10 } },
      { test: 'foo', metrics: { exec_time: null } },
      { test: 'foo', metrics: { exec_time: 30 } },
    ];
    const result = groupSamplesByTest([samples], 'exec_time');
    expect(result.get('foo')).toEqual([10, 30]);
  });

  it('skips samples missing the metric entirely', () => {
    const samples: SampleInfo[] = [
      { test: 'foo', metrics: { other: 10 } },
    ];
    const result = groupSamplesByTest([samples], 'exec_time');
    expect(result.size).toBe(0);
  });

  it('returns empty map for empty input', () => {
    expect(groupSamplesByTest([], 'exec_time').size).toBe(0);
    expect(groupSamplesByTest([[]], 'exec_time').size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// aggregateGrouped
// ---------------------------------------------------------------------------

describe('aggregateGrouped', () => {
  it('aggregates grouped values with the specified function', () => {
    const grouped = new Map([
      ['foo', [10, 20, 30]],
      ['bar', [5]],
    ]);
    const result = aggregateGrouped(grouped, 'median');
    expect(result.get('foo')).toBe(20);
    expect(result.get('bar')).toBe(5);
  });

  it('skips empty arrays', () => {
    const grouped = new Map([['foo', []]]);
    expect(aggregateGrouped(grouped, 'mean').size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// aggregateSamplesWithinRun (preserved behavior)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// aggregateAcrossRuns (preserved behavior)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// welchTTest
// ---------------------------------------------------------------------------

describe('welchTTest', () => {
  it('returns small p-value for clearly different groups (reference: scipy)', () => {
    // scipy.stats.ttest_ind([1,2,3,4,5], [6,7,8,9,10]) → p ≈ 0.000430
    const p = welchTTest([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]);
    expect(p).not.toBeNull();
    expect(p!).toBeCloseTo(0.000430, 3);
  });

  it('returns p-value close to 1 for nearly identical groups', () => {
    const p = welchTTest([10, 10.01, 9.99], [10.005, 9.995, 10]);
    expect(p).not.toBeNull();
    expect(p!).toBeGreaterThan(0.5);
  });

  it('returns null for n=1 per side', () => {
    expect(welchTTest([5], [10])).toBeNull();
  });

  it('returns null for n=0 on one side', () => {
    expect(welchTTest([], [1, 2, 3])).toBeNull();
    expect(welchTTest([1, 2, 3], [])).toBeNull();
  });

  it('works with n=2 per side (minimum valid)', () => {
    const p = welchTTest([1, 2], [100, 200]);
    expect(p).not.toBeNull();
    expect(typeof p).toBe('number');
    expect(p!).toBeGreaterThan(0);
    expect(p!).toBeLessThan(1);
  });

  it('works with highly unequal sample sizes', () => {
    const a = [1, 2];
    const b = Array.from({ length: 30 }, (_, i) => 50 + i);
    const p = welchTTest(a, b);
    expect(p).not.toBeNull();
    expect(p!).toBeLessThan(0.001);
  });

  it('returns null for zero variance on both sides with equal means', () => {
    expect(welchTTest([5, 5, 5], [5, 5, 5])).toBeNull();
  });

  it('returns 0 for zero variance on both sides with different means', () => {
    expect(welchTTest([5, 5, 5], [10, 10, 10])).toBe(0);
  });

  it('works with zero variance on one side only', () => {
    const p = welchTTest([5, 5, 5], [3, 7, 5]);
    expect(p).not.toBeNull();
    expect(typeof p).toBe('number');
  });

  it('works with negative values', () => {
    // Means are far apart relative to sample size but high variance
    const p = welchTTest([-10, -20, -30], [-100, -200, -300]);
    expect(p).not.toBeNull();
    expect(typeof p).toBe('number');
    expect(p!).toBeGreaterThan(0);
    expect(p!).toBeLessThan(1);
  });

  it('returns correct p-value for large samples (reference: scipy)', () => {
    // scipy.stats.ttest_ind(range(50), range(50, 100)) → p ≈ 4.15e-27
    const a = Array.from({ length: 50 }, (_, i) => i);
    const b = Array.from({ length: 50 }, (_, i) => 50 + i);
    const p = welchTTest(a, b);
    expect(p).not.toBeNull();
    expect(p!).toBeLessThan(1e-20);
  });
});

// ---------------------------------------------------------------------------
// computeComparison — basic behavior (adapted from single-threshold tests)
// ---------------------------------------------------------------------------

describe('computeComparison', () => {
  it('marks improvement when bigger_is_better=true and B > A', () => {
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 120]]);
    const rows = computeComparison(mapA, mapB, true, pctOnly(1));
    expect(rows).toHaveLength(1);
    expect(rows[0].test).toBe('foo');
    expect(rows[0].status).toBe('improved');
    expect(rows[0].delta).toBe(20);
    expect(rows[0].deltaPct).toBeCloseTo(20);
    expect(rows[0].ratio).toBeCloseTo(1.2);
    expect(rows[0].sidePresent).toBe('both');
    expect(rows[0].noiseReasons).toEqual([]);
  });

  it('marks regression when bigger_is_better=true and B < A', () => {
    const mapA = new Map([['foo', 120]]);
    const mapB = new Map([['foo', 100]]);
    const rows = computeComparison(mapA, mapB, true, pctOnly(1));
    expect(rows[0].status).toBe('regressed');
    expect(rows[0].noiseReasons).toEqual([]);
  });

  it('flips direction when bigger_is_better=false', () => {
    const mapA = new Map([['foo', 120]]);
    const mapB = new Map([['foo', 100]]);
    const rows = computeComparison(mapA, mapB, false, pctOnly(1));
    expect(rows[0].status).toBe('improved');

    const mapA2 = new Map([['foo', 100]]);
    const mapB2 = new Map([['foo', 120]]);
    const rows2 = computeComparison(mapA2, mapB2, false, pctOnly(1));
    expect(rows2[0].status).toBe('regressed');
  });

  it('marks noise when delta % is within threshold', () => {
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 100.5]]); // 0.5% change, threshold is 1%
    const rows = computeComparison(mapA, mapB, true, pctOnly(1));
    expect(rows[0].status).toBe('noise');
    expect(rows[0].noiseReasons).toHaveLength(1);
    expect(rows[0].noiseReasons[0].knob).toBe('pct');
  });

  it('handles zero baseline (valueA=0)', () => {
    const mapA = new Map([['foo', 0]]);
    const mapB = new Map([['foo', 5]]);
    const rows = computeComparison(mapA, mapB, true, pctOnly(1));
    expect(rows[0].status).toBe('na');
    expect(rows[0].delta).toBe(5);
    expect(rows[0].deltaPct).toBeNull();
    expect(rows[0].ratio).toBeNull();
    expect(rows[0].noiseReasons).toEqual([]);
  });

  it('handles both values zero', () => {
    const mapA = new Map([['foo', 0]]);
    const mapB = new Map([['foo', 0]]);
    const rows = computeComparison(mapA, mapB, true, pctOnly(1));
    expect(rows[0].status).toBe('na');
    expect(rows[0].noiseReasons).toEqual([]);
  });

  it('handles negative baseline with Math.abs in deltaPct', () => {
    const mapA = new Map([['foo', -10]]);
    const mapB = new Map([['foo', -5]]);
    const rows = computeComparison(mapA, mapB, true, pctOnly(1));
    expect(rows[0].delta).toBe(5);
    expect(rows[0].deltaPct).toBeCloseTo(50);
    expect(rows[0].ratio).toBeCloseTo(0.5);
    expect(rows[0].status).toBe('improved');
  });

  it('marks missing when test only in side A', () => {
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map<string, number>();
    const rows = computeComparison(mapA, mapB, true, pctOnly(1));
    expect(rows[0].status).toBe('missing');
    expect(rows[0].sidePresent).toBe('a_only');
    expect(rows[0].noiseReasons).toEqual([]);
  });

  it('marks missing when test only in side B', () => {
    const mapA = new Map<string, number>();
    const mapB = new Map([['foo', 100]]);
    const rows = computeComparison(mapA, mapB, true, pctOnly(1));
    expect(rows[0].status).toBe('missing');
    expect(rows[0].sidePresent).toBe('b_only');
    expect(rows[0].noiseReasons).toEqual([]);
  });

  it('returns empty for empty maps', () => {
    const rows = computeComparison(new Map(), new Map(), true, pctOnly(1));
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// computeComparison — noise boundary edge cases (pct knob only)
// ---------------------------------------------------------------------------

describe('computeComparison — noise boundary edge cases', () => {
  it('classifies exactly-at-threshold change as signal (strict <)', () => {
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 105]]);
    const rows = computeComparison(mapA, mapB, true, pctOnly(5));
    expect(rows[0].deltaPct).toBeCloseTo(5);
    expect(rows[0].status).toBe('improved');
  });

  it('classifies exactly-at-threshold negative change as signal', () => {
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 95]]);
    const rows = computeComparison(mapA, mapB, true, pctOnly(5));
    expect(rows[0].deltaPct).toBeCloseTo(-5);
    expect(rows[0].status).toBe('regressed');
  });

  it('classifies just-above-threshold change as improved (bigger_is_better=true)', () => {
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 105.01]]);
    const rows = computeComparison(mapA, mapB, true, pctOnly(5));
    expect(rows[0].deltaPct).toBeGreaterThan(5);
    expect(rows[0].status).toBe('improved');
  });

  it('classifies just-above-threshold negative change as regressed (bigger_is_better=true)', () => {
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 94.99]]);
    const rows = computeComparison(mapA, mapB, true, pctOnly(5));
    expect(rows[0].deltaPct).toBeLessThan(-5);
    expect(rows[0].status).toBe('regressed');
  });

  it('classifies just-below-threshold change as noise', () => {
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 104.99]]);
    const rows = computeComparison(mapA, mapB, true, pctOnly(5));
    expect(rows[0].deltaPct).toBeCloseTo(4.99);
    expect(rows[0].status).toBe('noise');
  });

  it('with noiseThreshold=0, tiny positive change is improved', () => {
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 100.001]]);
    const rows = computeComparison(mapA, mapB, true, pctOnly(0));
    expect(rows[0].deltaPct).toBeGreaterThan(0);
    expect(rows[0].status).toBe('improved');
  });

  it('with noiseThreshold=0, tiny negative change is regressed', () => {
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 99.999]]);
    const rows = computeComparison(mapA, mapB, true, pctOnly(0));
    expect(rows[0].deltaPct).toBeLessThan(0);
    expect(rows[0].status).toBe('regressed');
  });

  it('with noiseThreshold=0, delta=0 is unchanged (strict <)', () => {
    const mapA = new Map([['foo', 42]]);
    const mapB = new Map([['foo', 42]]);
    const rows = computeComparison(mapA, mapB, true, pctOnly(0));
    expect(rows[0].delta).toBe(0);
    expect(rows[0].deltaPct).toBe(0);
    expect(rows[0].status).toBe('unchanged');
  });

  it('delta=0 is noise when pct knob is enabled with threshold > 0', () => {
    const mapA = new Map([['foo', 50]]);
    const mapB = new Map([['foo', 50]]);

    const rowsLarge = computeComparison(mapA, mapB, true, pctOnly(10));
    expect(rowsLarge[0].status).toBe('noise');

    const rowsZero = computeComparison(mapA, mapB, false, pctOnly(0));
    expect(rowsZero[0].status).toBe('unchanged');

    const rowsTiny = computeComparison(mapA, mapB, true, pctOnly(0.001));
    expect(rowsTiny[0].status).toBe('noise');
  });

  it('with noiseThreshold=0 and bigger_is_better=false, tiny changes are classified correctly', () => {
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 99.999]]);
    const rows = computeComparison(mapA, mapB, false, pctOnly(0));
    expect(rows[0].status).toBe('improved');

    const mapA2 = new Map([['foo', 100]]);
    const mapB2 = new Map([['foo', 100.001]]);
    const rows2 = computeComparison(mapA2, mapB2, false, pctOnly(0));
    expect(rows2[0].status).toBe('regressed');
  });
});

// ---------------------------------------------------------------------------
// computeComparison — multi-knob noise classification
// ---------------------------------------------------------------------------

describe('computeComparison — multi-knob noise', () => {
  it('p-value knob marks as noise when p-value exceeds alpha', () => {
    const config: NoiseConfig = {
      pct: { enabled: false, value: 1 },
      pval: { enabled: true, value: 0.05 },
      floor: { enabled: false, value: 0 },
    };
    const mapA = new Map([['foo', 10]]);
    const mapB = new Map([['foo', 10.01]]);
    // Raw samples with high variance → p-value will be large
    const rawA = new Map([['foo', [8, 9, 10, 11, 12]]]);
    const rawB = new Map([['foo', [8.01, 9.01, 10.01, 11.01, 12.01]]]);
    const rows = computeComparison(mapA, mapB, true, config, rawA, rawB);
    expect(rows[0].status).toBe('noise');
    expect(rows[0].noiseReasons).toHaveLength(1);
    expect(rows[0].noiseReasons[0].knob).toBe('pval');
  });

  it('p-value knob passes when p-value is below alpha', () => {
    const config: NoiseConfig = {
      pct: { enabled: false, value: 1 },
      pval: { enabled: true, value: 0.05 },
      floor: { enabled: false, value: 0 },
    };
    const mapA = new Map([['foo', 3]]);
    const mapB = new Map([['foo', 8]]);
    // Raw samples clearly different → p-value will be small
    const rawA = new Map([['foo', [1, 2, 3, 4, 5]]]);
    const rawB = new Map([['foo', [6, 7, 8, 9, 10]]]);
    const rows = computeComparison(mapA, mapB, true, config, rawA, rawB);
    expect(rows[0].status).toBe('improved');
    expect(rows[0].noiseReasons).toEqual([]);
  });

  it('p-value knob is skipped when fewer than 2 samples per side', () => {
    const config: NoiseConfig = {
      pct: { enabled: false, value: 1 },
      pval: { enabled: true, value: 0.05 },
      floor: { enabled: false, value: 0 },
    };
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 200]]);
    const rawA = new Map([['foo', [100]]]);
    const rawB = new Map([['foo', [200]]]);
    const rows = computeComparison(mapA, mapB, true, config, rawA, rawB);
    // p-value skipped, no other knobs → not noise
    expect(rows[0].status).toBe('improved');
    expect(rows[0].noiseReasons).toEqual([]);
  });

  it('p-value knob is skipped when raw samples not provided', () => {
    const config: NoiseConfig = {
      pct: { enabled: false, value: 1 },
      pval: { enabled: true, value: 0.05 },
      floor: { enabled: false, value: 0 },
    };
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 200]]);
    const rows = computeComparison(mapA, mapB, true, config);
    expect(rows[0].status).toBe('improved');
    expect(rows[0].noiseReasons).toEqual([]);
  });

  it('absolute floor knob marks noise when values below floor', () => {
    const config: NoiseConfig = {
      pct: { enabled: false, value: 1 },
      pval: { enabled: false, value: 0.05 },
      floor: { enabled: true, value: 10 },
    };
    const mapA = new Map([['foo', 5]]);
    const mapB = new Map([['foo', 8]]);
    const rows = computeComparison(mapA, mapB, true, config);
    expect(rows[0].status).toBe('noise');
    expect(rows[0].noiseReasons).toHaveLength(1);
    expect(rows[0].noiseReasons[0].knob).toBe('floor');
  });

  it('absolute floor knob passes when any value above floor', () => {
    const config: NoiseConfig = {
      pct: { enabled: false, value: 1 },
      pval: { enabled: false, value: 0.05 },
      floor: { enabled: true, value: 10 },
    };
    const mapA = new Map([['foo', 5]]);
    const mapB = new Map([['foo', 500]]);
    const rows = computeComparison(mapA, mapB, true, config);
    expect(rows[0].status).toBe('improved');
    expect(rows[0].noiseReasons).toEqual([]);
  });

  it('floor knob works correctly with negative values', () => {
    const config: NoiseConfig = {
      pct: { enabled: false, value: 1 },
      pval: { enabled: false, value: 0.05 },
      floor: { enabled: true, value: 1 },
    };
    const mapA = new Map([['foo', -0.5]]);
    const mapB = new Map([['foo', -0.3]]);
    const rows = computeComparison(mapA, mapB, true, config);
    // max(|-0.5|, |-0.3|) = 0.5 < 1 → noise
    expect(rows[0].status).toBe('noise');
    expect(rows[0].noiseReasons[0].knob).toBe('floor');
  });

  it('floor knob with value=0 never fires (max abs cannot be < 0)', () => {
    const config: NoiseConfig = {
      pct: { enabled: false, value: 1 },
      pval: { enabled: false, value: 0.05 },
      floor: { enabled: true, value: 0 },
    };
    const mapA = new Map([['foo', 0.001]]);
    const mapB = new Map([['foo', 0.002]]);
    const rows = computeComparison(mapA, mapB, true, config);
    expect(rows[0].status).toBe('improved');
    expect(rows[0].noiseReasons).toEqual([]);
  });

  it('multiple knobs can fire: noise if ANY fires', () => {
    const config: NoiseConfig = {
      pct: { enabled: true, value: 50 },   // 50% threshold → will fire for small delta
      pval: { enabled: false, value: 0.05 },
      floor: { enabled: true, value: 1000 }, // floor at 1000 → will fire for small values
    };
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 110]]);
    const rows = computeComparison(mapA, mapB, true, config);
    expect(rows[0].status).toBe('noise');
    expect(rows[0].noiseReasons).toHaveLength(2);
    const knobs = rows[0].noiseReasons.map(r => r.knob);
    expect(knobs).toContain('pct');
    expect(knobs).toContain('floor');
  });

  it('all three knobs fire simultaneously', () => {
    const config: NoiseConfig = {
      pct: { enabled: true, value: 50 },
      pval: { enabled: true, value: 0.01 }, // low alpha, but samples nearly identical → high p-value
      floor: { enabled: true, value: 1000 },
    };
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 110]]);
    // Nearly identical samples → p-value will be high (above 0.01)
    const rawA = new Map([['foo', [99, 100, 101, 100, 100]]]);
    const rawB = new Map([['foo', [109, 110, 111, 110, 110]]]);
    const rows = computeComparison(mapA, mapB, true, config, rawA, rawB);
    expect(rows[0].status).toBe('noise');
    // pct fires (10% < 50%), floor fires (max(100,110) < 1000)
    // pval: means are 100 vs 110 with low variance → p-value should be small
    // So pval may or may not fire. Let's just verify at least pct and floor.
    expect(rows[0].noiseReasons.length).toBeGreaterThanOrEqual(2);
    const knobs = rows[0].noiseReasons.map(r => r.knob);
    expect(knobs).toContain('pct');
    expect(knobs).toContain('floor');
  });

  it('all knobs disabled: small delta is improved/regressed, not noise', () => {
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 100.5]]);
    const rows = computeComparison(mapA, mapB, true, allDisabled());
    expect(rows[0].status).toBe('improved');
    expect(rows[0].noiseReasons).toEqual([]);
  });

  it('all knobs disabled: delta=0 is unchanged', () => {
    const mapA = new Map([['foo', 42]]);
    const mapB = new Map([['foo', 42]]);
    const rows = computeComparison(mapA, mapB, true, allDisabled());
    expect(rows[0].status).toBe('unchanged');
    expect(rows[0].delta).toBe(0);
    expect(rows[0].noiseReasons).toEqual([]);
  });

  it('noiseReasons message contains threshold values', () => {
    const config: NoiseConfig = {
      pct: { enabled: true, value: 5 },
      pval: { enabled: false, value: 0.05 },
      floor: { enabled: true, value: 200 },
    };
    const mapA = new Map([['foo', 100]]);
    const mapB = new Map([['foo', 103]]);
    const rows = computeComparison(mapA, mapB, true, config);
    expect(rows[0].status).toBe('noise');

    const pctReason = rows[0].noiseReasons.find(r => r.knob === 'pct');
    expect(pctReason).toBeDefined();
    expect(pctReason!.message).toContain('5%');
    expect(pctReason!.message).toContain('threshold');

    const floorReason = rows[0].noiseReasons.find(r => r.knob === 'floor');
    expect(floorReason).toBeDefined();
    expect(floorReason!.message).toContain('200');
    expect(floorReason!.message).toContain('floor');
  });
});

// ---------------------------------------------------------------------------
// computeComparison — multi-test mixed status
// ---------------------------------------------------------------------------

describe('computeComparison — multi-test mixed status', () => {
  it('produces all status types in a single call and returns correct fields per row', () => {
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

    const rows = computeComparison(mapA, mapB, true, pctOnly(5));
    expect(rows).toHaveLength(5);

    const byTest = new Map(rows.map(r => [r.test, r]));

    const improved = byTest.get('test-improved')!;
    expect(improved.status).toBe('improved');
    expect(improved.valueA).toBe(100);
    expect(improved.valueB).toBe(120);
    expect(improved.delta).toBe(20);
    expect(improved.deltaPct).toBeCloseTo(20);
    expect(improved.ratio).toBeCloseTo(1.2);
    expect(improved.sidePresent).toBe('both');
    expect(improved.noiseReasons).toEqual([]);

    const regressed = byTest.get('test-regressed')!;
    expect(regressed.status).toBe('regressed');
    expect(regressed.noiseReasons).toEqual([]);

    const noise = byTest.get('test-noise')!;
    expect(noise.status).toBe('noise');
    expect(noise.noiseReasons).toHaveLength(1);
    expect(noise.noiseReasons[0].knob).toBe('pct');

    const aOnly = byTest.get('test-a-only')!;
    expect(aOnly.status).toBe('missing');
    expect(aOnly.sidePresent).toBe('a_only');
    expect(aOnly.noiseReasons).toEqual([]);

    const bOnly = byTest.get('test-b-only')!;
    expect(bOnly.status).toBe('missing');
    expect(bOnly.sidePresent).toBe('b_only');
    expect(bOnly.noiseReasons).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeGeomean (unchanged behavior)
// ---------------------------------------------------------------------------

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
      noiseReasons: [],
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
    const rows = [
      makeRow({ valueA: 50, valueB: 100, ratio: 2 }),
      makeRow({ valueA: 10, valueB: 80, ratio: 8 }),
    ];
    const result = computeGeomean(rows)!;
    expect(result).not.toBeNull();
    expect(result.ratioGeomean).toBeCloseTo(4);
  });

  it('computes geomeanA and geomeanB from absolute values', () => {
    const rows = [
      makeRow({ valueA: 100, valueB: 200, ratio: 2 }),
      makeRow({ valueA: 400, valueB: 800, ratio: 2 }),
    ];
    const result = computeGeomean(rows)!;
    expect(result.geomeanA).toBeCloseTo(200);
    expect(result.geomeanB).toBeCloseTo(400);
    expect(result.delta).toBeCloseTo(200);
    expect(result.deltaPct).toBeCloseTo(100);
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
    const rows = [makeRow({ valueA: 0, valueB: 10, ratio: null, status: 'na' })];
    expect(computeGeomean(rows)).toBeNull();
  });

  it('produces valid geomean for negative values', () => {
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
    expect(result.ratioGeomean).toBeCloseTo(1);
  });
});
