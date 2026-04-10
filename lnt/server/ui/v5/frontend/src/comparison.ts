import type { AggFn, ComparisonRow, RowStatus, SampleInfo } from './types';
import { getAggFn, geomean } from './utils';

/**
 * Aggregate multiple samples within a single run for one metric.
 * Groups by test name, applies aggFn to metric values (skips nulls).
 */
export function aggregateSamplesWithinRun(
  samples: SampleInfo[],
  metric: string,
  aggFn: AggFn,
): Map<string, number> {
  const byTest = new Map<string, number[]>();

  for (const s of samples) {
    const val = s.metrics[metric];
    if (val === null || val === undefined) continue;
    let arr = byTest.get(s.test);
    if (!arr) {
      arr = [];
      byTest.set(s.test, arr);
    }
    arr.push(val);
  }

  const agg = getAggFn(aggFn);
  const result = new Map<string, number>();
  for (const [test, values] of byTest) {
    if (values.length > 0) {
      result.set(test, agg(values));
    }
  }
  return result;
}

/**
 * Aggregate across multiple runs. For each test, collect the per-run values
 * and apply aggFn.
 */
export function aggregateAcrossRuns(
  perRunMaps: Map<string, number>[],
  aggFn: AggFn,
): Map<string, number> {
  if (perRunMaps.length === 0) return new Map();
  if (perRunMaps.length === 1) return perRunMaps[0];

  const allTests = new Set<string>();
  for (const m of perRunMaps) {
    for (const t of m.keys()) allTests.add(t);
  }

  const agg = getAggFn(aggFn);
  const result = new Map<string, number>();
  for (const test of allTests) {
    const values: number[] = [];
    for (const m of perRunMaps) {
      const v = m.get(test);
      if (v !== undefined) values.push(v);
    }
    if (values.length > 0) {
      result.set(test, agg(values));
    }
  }
  return result;
}

/**
 * Full outer join on test name. Compute delta, deltaPct, ratio, status.
 */
export function computeComparison(
  mapA: Map<string, number>,
  mapB: Map<string, number>,
  biggerIsBetter: boolean,
  noiseThreshold: number,
): ComparisonRow[] {
  const allTests = new Set<string>();
  for (const t of mapA.keys()) allTests.add(t);
  for (const t of mapB.keys()) allTests.add(t);

  const rows: ComparisonRow[] = [];

  for (const test of allTests) {
    const vA = mapA.get(test) ?? null;
    const vB = mapB.get(test) ?? null;

    let sidePresent: 'both' | 'a_only' | 'b_only';
    if (vA !== null && vB !== null) sidePresent = 'both';
    else if (vA !== null) sidePresent = 'a_only';
    else sidePresent = 'b_only';

    // Missing side
    if (sidePresent !== 'both') {
      rows.push({
        test, valueA: vA, valueB: vB,
        delta: null, deltaPct: null, ratio: null,
        status: 'missing', sidePresent,
      });
      continue;
    }

    // Both sides present
    const delta = vB! - vA!;

    // Zero baseline
    if (vA === 0) {
      rows.push({
        test, valueA: vA, valueB: vB,
        delta, deltaPct: null, ratio: null,
        status: 'na', sidePresent,
      });
      continue;
    }

    // We use Math.abs(vA) in the denominator so that deltaPct always has the
    // same sign as delta (positive when B > A, negative when B < A), even if
    // the baseline is negative.  Without abs, a negative baseline would flip
    // the percentage sign, making the displayed value misleading.
    const deltaPct = (delta / Math.abs(vA!)) * 100;
    const ratio = vB! / vA!;

    let status: RowStatus;
    if (Math.abs(deltaPct) <= noiseThreshold) {
      status = 'noise';
    } else if (biggerIsBetter) {
      status = delta > 0 ? 'improved' : 'regressed';
    } else {
      status = delta < 0 ? 'improved' : 'regressed';
    }

    rows.push({
      test, valueA: vA, valueB: vB,
      delta, deltaPct, ratio,
      status, sidePresent,
    });
  }

  return rows;
}

export interface GeomeanResult {
  /** Geometric mean of side A values. */
  geomeanA: number;
  /** Geometric mean of side B values. */
  geomeanB: number;
  /** Delta: geomeanB - geomeanA. */
  delta: number;
  /** Delta as percentage of geomeanA. Null if geomeanA is 0. */
  deltaPct: number | null;
  /** Geometric mean of per-test ratios (B/A). */
  ratioGeomean: number;
}

/**
 * Compute geomean summary for all rows present on both sides.
 * Returns null if no valid rows exist.
 */
export function computeGeomean(rows: ComparisonRow[]): GeomeanResult | null {
  const valid = rows.filter(
    r => r.sidePresent === 'both'
      && r.ratio !== null
      && r.status !== 'na'
      && r.valueA !== null
      && r.valueB !== null
      && r.valueA !== 0
      && r.valueB !== 0,
  );

  if (valid.length === 0) return null;

  const geomeanA = geomean(valid.map(r => Math.abs(r.valueA!)));
  const geomeanB = geomean(valid.map(r => Math.abs(r.valueB!)));
  const ratioGeomean = geomean(valid.map(r => Math.abs(r.ratio!)));

  // geomean() returns null only when all values are <= 0, but we already
  // filtered out zeros above, so these will always be non-null.
  if (geomeanA === null || geomeanB === null || ratioGeomean === null) return null;

  const delta = geomeanB - geomeanA;
  // Use Math.abs so deltaPct sign matches delta sign (see computeComparison).
  const deltaPct = geomeanA !== 0 ? (delta / Math.abs(geomeanA)) * 100 : null;

  return { geomeanA, geomeanB, delta, deltaPct, ratioGeomean };
}
