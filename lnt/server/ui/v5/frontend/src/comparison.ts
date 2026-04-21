import type { AggFn, ComparisonRow, NoiseConfig, NoiseReason, RowStatus, SampleInfo } from './types';
import { getAggFn, geomean, mean } from './utils';

// ---------------------------------------------------------------------------
// Sample grouping and aggregation
// ---------------------------------------------------------------------------

/**
 * Group raw metric values by test name, pooling across multiple runs.
 * Returns the raw (unaggregated) values for each test.
 */
export function groupSamplesByTest(
  samplesByRun: SampleInfo[][],
  metric: string,
): Map<string, number[]> {
  const byTest = new Map<string, number[]>();
  for (const samples of samplesByRun) {
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
  }
  return byTest;
}

/**
 * Aggregate a pre-grouped map using the specified function.
 */
export function aggregateGrouped(
  grouped: Map<string, number[]>,
  aggFn: AggFn,
): Map<string, number> {
  const agg = getAggFn(aggFn);
  const result = new Map<string, number>();
  for (const [test, values] of grouped) {
    if (values.length > 0) {
      result.set(test, agg(values));
    }
  }
  return result;
}

/**
 * Aggregate multiple samples within a single run for one metric.
 * Groups by test name, applies aggFn to metric values (skips nulls).
 */
export function aggregateSamplesWithinRun(
  samples: SampleInfo[],
  metric: string,
  aggFn: AggFn,
): Map<string, number> {
  return aggregateGrouped(groupSamplesByTest([samples], metric), aggFn);
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

// ---------------------------------------------------------------------------
// Welch's t-test
// ---------------------------------------------------------------------------

/** Compute sample variance (unbiased, divides by n-1). */
function variance(arr: number[], m: number): number {
  let sum = 0;
  for (const v of arr) {
    const d = v - m;
    sum += d * d;
  }
  return sum / (arr.length - 1);
}

/**
 * Regularized incomplete beta function I_x(a, b) via Lentz's continued
 * fraction algorithm. Used for the Student's t-distribution CDF.
 */
function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  // Use the symmetry relation when x > (a+1)/(a+b+2) for better convergence
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - regularizedIncompleteBeta(1 - x, b, a);
  }

  // Log of the beta function prefix: x^a * (1-x)^b / (a * B(a,b))
  const lnPrefix = a * Math.log(x) + b * Math.log(1 - x)
    - Math.log(a)
    - (lnGamma(a) + lnGamma(b) - lnGamma(a + b));

  const prefix = Math.exp(lnPrefix);

  // Lentz's continued fraction
  const TINY = 1e-30;
  const EPS = 1e-14;
  const MAX_ITER = 200;

  let f = 1 + cfCoeff(1, a, b, x);
  if (Math.abs(f) < TINY) f = TINY;
  let C = f;
  let D = 1;

  for (let m = 1; m <= MAX_ITER; m++) {
    const d = cfCoeff(m + 1, a, b, x);
    D = 1 + d * D;
    if (Math.abs(D) < TINY) D = TINY;
    D = 1 / D;
    C = 1 + d / C;
    if (Math.abs(C) < TINY) C = TINY;
    const delta = C * D;
    f *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }

  return prefix * f;
}

/** Continued fraction coefficients for I_x(a, b). */
function cfCoeff(n: number, a: number, b: number, x: number): number {
  const m = Math.floor(n / 2);
  if (n % 2 === 0) {
    // Even terms: d_{2m}
    return (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
  } else {
    // Odd terms: d_{2m+1}
    return -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
  }
}

/** Log-gamma function using Lanczos approximation. */
function lnGamma(z: number): number {
  const g = 7;
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];

  if (z < 0.5) {
    // Reflection formula
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }

  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) {
    x += c[i] / (z + i);
  }
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * Welch's t-test (two-tailed). Returns p-value or null if the test cannot
 * be computed (< 2 samples per side, or both sides zero variance with equal
 * means).
 */
export function welchTTest(a: number[], b: number[]): number | null {
  if (a.length < 2 || b.length < 2) return null;

  const nA = a.length;
  const nB = b.length;
  const mA = mean(a);
  const mB = mean(b);
  const vA = variance(a, mA);
  const vB = variance(b, mB);

  // Both zero variance
  if (vA === 0 && vB === 0) {
    return mA === mB ? null : 0;
  }

  const se = Math.sqrt(vA / nA + vB / nB);
  const t = (mA - mB) / se;

  // Welch-Satterthwaite degrees of freedom
  const sA = vA / nA;
  const sB = vB / nB;
  const num = (sA + sB) ** 2;
  const den = (sA ** 2) / (nA - 1) + (sB ** 2) / (nB - 1);
  const df = num / den;

  // Two-tailed p-value from Student's t-distribution
  const x = df / (df + t * t);
  return regularizedIncompleteBeta(x, df / 2, 0.5);
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Full outer join on test name. Compute delta, deltaPct, ratio, status.
 * Applies multi-knob noise classification.
 */
export function computeComparison(
  mapA: Map<string, number>,
  mapB: Map<string, number>,
  biggerIsBetter: boolean,
  noiseConfig: NoiseConfig,
  rawA?: Map<string, number[]>,
  rawB?: Map<string, number[]>,
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
        status: 'missing', sidePresent, noiseReasons: [],
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
        status: 'na', sidePresent, noiseReasons: [],
      });
      continue;
    }

    // We use Math.abs(vA) in the denominator so that deltaPct always has the
    // same sign as delta (positive when B > A, negative when B < A), even if
    // the baseline is negative.  Without abs, a negative baseline would flip
    // the percentage sign, making the displayed value misleading.
    const deltaPct = (delta / Math.abs(vA!)) * 100;
    const ratio = vB! / vA!;

    // Multi-knob noise classification
    const noiseReasons: NoiseReason[] = [];

    // Delta % knob
    if (noiseConfig.pct.enabled) {
      if (Math.abs(deltaPct) <= noiseConfig.pct.value) {
        noiseReasons.push({
          knob: 'pct',
          message: `Delta ${Math.abs(deltaPct).toFixed(1)}% below ${noiseConfig.pct.value}% threshold`,
        });
      }
    }

    // P-value knob
    if (noiseConfig.pval.enabled && rawA && rawB) {
      const samplesA = rawA.get(test);
      const samplesB = rawB.get(test);
      if (samplesA && samplesB) {
        const pval = welchTTest(samplesA, samplesB);
        if (pval !== null && pval > noiseConfig.pval.value) {
          noiseReasons.push({
            knob: 'pval',
            message: `p-value ${pval.toFixed(2)} above ${noiseConfig.pval.value}`,
          });
        }
      }
    }

    // Absolute floor knob
    if (noiseConfig.floor.enabled) {
      const maxAbs = Math.max(Math.abs(vA!), Math.abs(vB!));
      if (maxAbs < noiseConfig.floor.value) {
        noiseReasons.push({
          knob: 'floor',
          message: `max(|A|, |B|) = ${maxAbs.toPrecision(3)} below floor of ${noiseConfig.floor.value}`,
        });
      }
    }

    // Classify
    let status: RowStatus;
    if (noiseReasons.length > 0) {
      status = 'noise';
    } else if (delta === 0) {
      status = 'noise';
    } else if (biggerIsBetter) {
      status = delta > 0 ? 'improved' : 'regressed';
    } else {
      status = delta < 0 ? 'improved' : 'regressed';
    }

    rows.push({
      test, valueA: vA, valueB: vB,
      delta, deltaPct, ratio,
      status, sidePresent, noiseReasons,
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
