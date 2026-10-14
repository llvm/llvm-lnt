/**
 * What the Compare page computes from the samples of its two sides (CP2 "Computation Reference",
 * CP4), in three steps that depend on different settings, so that the page computes each again only
 * when its own settings change:
 *
 * 1. `joinSides`: the tests of the comparison, and what depends only on the samples -- each side's
 *    statistics and the p-value of Welch's t-test between them.
 * 2. `sideValues`: a side's value of each test, through the aggregation pipeline.
 * 3. `compareRows`: the rows, from the two sides' values: Delta, Delta %, Ratio and Status.
 */

import { aggregate, mean, type Aggregation } from '../../aggregation'
import type { Schemas } from '../../api/client'
import { compareStrings } from '../../format'

type Sample = Schemas['Sample']

/**
 * A side's samples for each test (CP2): for each of the side's selected runs that has some, the
 * run's values of the metric for the test. A test with no value on the side is absent.
 */
export type SideSamples = Map<string, number[][]>

/** Add `item` to the list `key` holds in `map`, starting it if there is none. */
function append<Item>(map: Map<string, Item[]>, key: string, item: Item) {
  const items = map.get(key)
  if (items === undefined) map.set(key, [item])
  else items.push(item)
}

/** The samples of `runs`, the side's selected runs, for `metric`, a numeric one (CP1). */
export function sideSamples(runs: readonly (readonly Sample[])[], metric: string): SideSamples {
  const side: SideSamples = new Map()
  for (const samples of runs) {
    const ofRun = new Map<string, number[]>()
    for (const { test, metrics } of samples) {
      const value = metrics[metric]
      if (typeof value === 'number') append(ofRun, test, value)
    }
    for (const [test, values] of ofRun) append(side, test, values)
  }
  return side
}

/** The statistics of a side's samples for a test (CP2 "Optional columns"). */
export interface Statistics {
  /** How many samples there are: 0 on a side with none. */
  count: number
  /** Null on a side with no samples, like the median, the smallest and the largest. */
  mean: number | null
  median: number | null
  min: number | null
  max: number | null
  /** The sample standard deviation (`n - 1`), null with fewer than 2 samples. */
  stddev: number | null
  /** `stddev / |mean| * 100`, null when the standard deviation is, or the mean is 0. */
  cv: number | null
}

/** The sample variance of `values`, at least 2 of them, whose mean is `m`. */
function variance(values: readonly number[], m: number): number {
  return values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1)
}

/** The statistics of `values`, a side's samples for a test. */
export function statisticsOf(values: readonly number[]): Statistics {
  if (values.length === 0) {
    return { count: 0, mean: null, median: null, min: null, max: null, stddev: null, cv: null }
  }
  const m = mean(values)
  const stddev = values.length < 2 ? null : Math.sqrt(variance(values, m))
  return {
    count: values.length,
    mean: m,
    median: aggregate(values, 'median'),
    min: aggregate(values, 'min'),
    max: aggregate(values, 'max'),
    stddev,
    cv: stddev === null || m === 0 ? null : (stddev / Math.abs(m)) * 100,
  }
}

/** The coefficients of the Lanczos approximation of `lnGamma`, for g = 7. */
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
]

/**
 * `ln(Γ(z))`, by the Lanczos approximation, for `z >= 0.5`: every argument Welch's t-test gives it,
 * whose degrees of freedom are at least 1.
 */
function lnGamma(z: number): number {
  const x = z - 1
  let sum = LANCZOS[0]
  for (let i = 1; i < LANCZOS.length; i++) sum += LANCZOS[i] / (x + i)
  const t = x + 7.5
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(sum)
}

/** The `n`th coefficient of the continued fraction of `incompleteBeta`. */
function fractionTerm(n: number, a: number, b: number, x: number): number {
  const m = Math.floor(n / 2)
  return n % 2 === 0
    ? (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m))
    : -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1))
}

/**
 * The regularized incomplete beta function `I_x(a, b)`, from its continued fraction, evaluated by
 * the modified Lentz method (as Numerical Recipes' `betacf` does), on whichever side of the mean
 * `x` falls for it to converge quickly.
 */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  if (x > (a + 1) / (a + b + 2)) return 1 - incompleteBeta(1 - x, b, a)
  const front = Math.exp(
    a * Math.log(x) + b * Math.log(1 - x) - Math.log(a) - lnGamma(a) - lnGamma(b) + lnGamma(a + b),
  )
  const TINY = 1e-30
  const nonZero = (value: number) => (Math.abs(value) < TINY ? TINY : value)
  let d = 1 / nonZero(1 + fractionTerm(1, a, b, x))
  let c = 1
  let f = d
  for (let n = 2; n <= 400; n++) {
    const term = fractionTerm(n, a, b, x)
    d = 1 / nonZero(1 + term * d)
    c = nonZero(1 + term / c)
    f *= c * d
    if (Math.abs(c * d - 1) < 1e-14) break
  }
  return front * f
}

/**
 * The two-tailed p-value of Welch's t-test between `a` and `b` (CP1 "P-value above"), or null
 * when it is skipped: with fewer than 2 values on either side, or when both have no variance and
 * the same mean. When both have no variance but different means, the change is deterministic, and
 * the p-value is 0.
 */
export function welchTTest(a: readonly number[], b: readonly number[]): number | null {
  if (a.length < 2 || b.length < 2) return null
  const meanA = mean(a)
  const meanB = mean(b)
  // The variance of each side's mean.
  const spreadA = variance(a, meanA) / a.length
  const spreadB = variance(b, meanB) / b.length
  if (spreadA === 0 && spreadB === 0) return meanA === meanB ? null : 0
  const t = (meanA - meanB) / Math.sqrt(spreadA + spreadB)
  // The Welch-Satterthwaite degrees of freedom.
  const df =
    (spreadA + spreadB) ** 2 / (spreadA ** 2 / (a.length - 1) + spreadB ** 2 / (b.length - 1))
  return incompleteBeta(df / (df + t * t), df / 2, 0.5)
}

/** What a side's samples for a test give, whatever the aggregation. */
export interface SideStatistics extends Statistics {
  /** How many of the side's selected runs have samples of the test (see CP2's tooltips). */
  runs: number
}

/** A test of the comparison, with what depends only on the two sides' samples. */
export interface ComparedTest {
  test: string
  statisticsA: SideStatistics
  statisticsB: SideStatistics
  /**
   * The p-value of Welch's t-test between the two sides' samples, or null where it is skipped (see
   * `welchTTest`). It is computed for every test, the zero baselines included, for the P-value
   * column, which shows it whether or not the knob applies (CP2 "Optional columns").
   */
  pValue: number | null
}

/**
 * The tests of the comparison: every test with a value on at least one side, by name, matched
 * across the sides whatever their suites, in the order of `compareStrings`.
 */
export function joinSides(a: SideSamples, b: SideSamples): ComparedTest[] {
  const tests = [...new Set([...a.keys(), ...b.keys()])].sort(compareStrings)
  return tests.map((test) => {
    const ofA = a.get(test) ?? []
    const ofB = b.get(test) ?? []
    const pooledA = ofA.flat()
    const pooledB = ofB.flat()
    return {
      test,
      statisticsA: { ...statisticsOf(pooledA), runs: ofA.length },
      statisticsB: { ...statisticsOf(pooledB), runs: ofB.length },
      pValue: welchTTest(pooledA, pooledB),
    }
  })
}

/**
 * A side's value of each test (CP2 "Aggregation pipeline"): `sampleAgg` combines the test's
 * samples within each run, then `runAgg` combines the runs' values.
 */
export function sideValues(
  side: SideSamples,
  sampleAgg: Aggregation,
  runAgg: Aggregation,
): Map<string, number> {
  const values = new Map<string, number>()
  for (const [test, perRun] of side) {
    values.set(
      test,
      aggregate(
        perRun.map((ofRun) => aggregate(ofRun, sampleAgg)),
        runAgg,
      ),
    )
  }
  return values
}

/** The statuses of a test whose sides can be compared, which CP4 gives the share of. */
export const COMPARABLE = ['improved', 'regressed', 'noise', 'unchanged'] as const

/** The statuses of CP2, in the order the table sorts them and CP4 lists them. */
export const STATUSES = [...COMPARABLE, 'na'] as const

export type Status = (typeof STATUSES)[number]

/** The noise knobs of CP1: Delta % below, P-value above and Absolute below. */
export type NoiseKnob = 'pct' | 'pval' | 'floor'

/** Each knob's threshold, or null while it is disabled. */
export type NoiseSettings = Record<NoiseKnob, number | null>

/** A knob that classified a test as noise: the test's value it judged, and its threshold. */
export interface NoiseReason {
  knob: NoiseKnob
  /** |Delta %|, the p-value, or max(|Value A|, |Value B|), as the knob reads it. */
  value: number
  threshold: number
}

/** The values a row of the table shows, the geomean summary row's included. */
export interface Values {
  /** The side's value, or null when it has none. */
  a: number | null
  b: number | null
  delta: number | null
  deltaPct: number | null
  ratio: number | null
  status: Status
}

/** A row of the comparison table. */
export interface ComparisonRow extends ComparedTest, Values {
  /** The knobs that classified the test as noise: its status is noise exactly if there are any. */
  noise: NoiseReason[]
}

/** The values of a row that has nothing to compare: N/A throughout. */
const NOTHING: Values = { a: null, b: null, delta: null, deltaPct: null, ratio: null, status: 'na' }

/** Delta's status, from its sign and the metric's `bigger_is_better` (CP2 steps 2 to 6). */
function statusOfDelta(delta: number, biggerIsBetter: boolean): Status {
  if (delta === 0) return 'unchanged'
  return delta > 0 === biggerIsBetter ? 'improved' : 'regressed'
}

/** The knobs that classify a test as noise, from its values and its p-value. */
function noiseOf(
  a: number,
  b: number,
  deltaPct: number,
  pValue: number | null,
  settings: NoiseSettings,
): NoiseReason[] {
  const reasons: NoiseReason[] = []
  const { pct, pval, floor } = settings
  if (pct !== null && Math.abs(deltaPct) < pct) {
    reasons.push({ knob: 'pct', value: Math.abs(deltaPct), threshold: pct })
  }
  if (pval !== null && pValue !== null && pValue > pval) {
    reasons.push({ knob: 'pval', value: pValue, threshold: pval })
  }
  const largest = Math.max(Math.abs(a), Math.abs(b))
  if (floor !== null && largest < floor) {
    reasons.push({ knob: 'floor', value: largest, threshold: floor })
  }
  return reasons
}

export interface RowOptions {
  biggerIsBetter: boolean
  noise: NoiseSettings
}

/** The row of `test`, given each side's value of it. */
function rowOf(
  test: ComparedTest,
  a: number | null,
  b: number | null,
  { biggerIsBetter, noise: settings }: RowOptions,
): ComparisonRow {
  if (a === null || b === null) return { ...test, ...NOTHING, a, b, noise: [] }
  const delta = b - a
  if (a === 0) return { ...test, ...NOTHING, a, b, delta, noise: [] }
  // Over |a|, so that Delta % has the sign of Delta, even with a negative baseline.
  const deltaPct = (delta / Math.abs(a)) * 100
  const noise = noiseOf(a, b, deltaPct, test.pValue, settings)
  const status = noise.length > 0 ? 'noise' : statusOfDelta(delta, biggerIsBetter)
  return { ...test, a, b, delta, deltaPct, ratio: b / a, status, noise }
}

/** The rows of `tests`, from each side's values (see `sideValues`). */
export function compareRows(
  tests: readonly ComparedTest[],
  valuesA: ReadonlyMap<string, number>,
  valuesB: ReadonlyMap<string, number>,
  options: RowOptions,
): ComparisonRow[] {
  return tests.map((test) =>
    rowOf(test, valuesA.get(test.test) ?? null, valuesB.get(test.test) ?? null, options),
  )
}

/** The geometric mean of the absolute values of `values`, at least one of them, none zero. */
function geomean(values: readonly number[]): number {
  return Math.exp(mean(values.map((value) => Math.log(Math.abs(value)))))
}

/**
 * The geomean summary row of `rows`, the compared rows (CP2): over those where both sides have a
 * value and neither is 0. Its status comes from its Delta, and is never noise. With no such row,
 * every value is null and the status N/A.
 */
export function geomeanRow(rows: readonly Values[], biggerIsBetter: boolean): Values {
  const pairs: [number, number][] = []
  for (const { a, b } of rows) {
    if (a !== null && b !== null && a !== 0 && b !== 0) pairs.push([a, b])
  }
  if (pairs.length === 0) return NOTHING
  const a = geomean(pairs.map(([value]) => value))
  const b = geomean(pairs.map(([, value]) => value))
  const delta = b - a
  return {
    a,
    b,
    delta,
    deltaPct: (delta / a) * 100,
    // Over the same tests, the geomean of the ratios is that of B over that of A.
    ratio: b / a,
    status: statusOfDelta(delta, biggerIsBetter),
  }
}

/** The categories of the summary bar (CP4), in the order it shows them. */
export const CATEGORIES = [...COMPARABLE, 'onlyA', 'onlyB', 'zeroBaseline'] as const

export type Category = (typeof CATEGORIES)[number]

/** How the table names each status, and the summary bar each category. */
export const CATEGORY_LABELS: Record<Status | Category, string> = {
  improved: 'Improved',
  regressed: 'Regressed',
  noise: 'Noise',
  unchanged: 'Unchanged',
  onlyA: 'Only in A',
  onlyB: 'Only in B',
  na: 'N/A',
  zeroBaseline: 'Zero baseline',
}

/**
 * The summary bar's category of a row: the side it has a value on, if only one, or its status, an
 * N/A one being a zero baseline.
 */
export function categoryOf(row: Values): Category {
  if (row.a === null) return 'onlyB'
  if (row.b === null) return 'onlyA'
  return row.status === 'na' ? 'zeroBaseline' : row.status
}

/** How many of `rows` fall in each category of the summary bar (CP4). */
export function summaryCounts(rows: readonly Values[]): Record<Category, number> {
  const counts = Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as Record<
    Category,
    number
  >
  for (const row of rows) counts[categoryOf(row)]++
  return counts
}

/**
 * `count` as a percentage of `total`, which is not 0, to one decimal place, without a trailing `.0`
 * (CP4).
 */
export function formatShare(count: number, total: number): string {
  return `${((count / total) * 100).toFixed(1).replace(/\.0$/, '')}%`
}
