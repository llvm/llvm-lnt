/**
 * What the Compare page computes from the samples of its two sides (CP2 "Computation Reference",
 * CP4), in steps that depend on different settings, so that the page computes each again only when
 * its own settings change:
 *
 * 1. `joinSides`: the tests of the comparison, and each side's statistics, which depend only on the
 *    samples.
 * 2. `runValues`: each run's value of each test, with the sample aggregation.
 * 3. `sideValues`: a side's value of each test, from its runs' values, with the run aggregation.
 * 4. `changes`: each test's change, from Welch's t-test between the logs of the two sides' runs'
 *    values, with its confidence interval at the confidence chosen.
 * 5. `compareRows`: the rows: Delta, Delta %, Ratio, and the status, with the margin chosen.
 */

import { aggregate, mean, type Aggregation } from '../../aggregation'
import type { Schemas } from '../../api/client'
import type { RunSamples } from '../../components/run-samples-table'
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

/** The value of `metric`, a numeric one (CP1), that `sample` has, if it has one. */
function valueOf({ metrics }: Sample, metric: string): number | undefined {
  const value = metrics[metric]
  return typeof value === 'number' ? value : undefined
}

/** The samples of `runs`, the side's selected runs, for `metric`. */
export function sideSamples(runs: readonly (readonly Sample[])[], metric: string): SideSamples {
  const side: SideSamples = new Map()
  for (const samples of runs) {
    const ofRun = new Map<string, number[]>()
    for (const sample of samples) {
      const value = valueOf(sample, metric)
      if (value !== undefined) append(ofRun, sample.test, value)
    }
    for (const [test, values] of ofRun) append(side, test, values)
  }
  return side
}

/** A run of a side, and its samples. */
export interface SampledRun {
  uuid: string
  measured_at: string
  samples: readonly Sample[]
}

/**
 * The runs among `runs`, a side's selected runs, that the side's samples for `test` come from (CP2),
 * in the same order, each with its values of `metric` for the test, ascending (CP3 "Details").
 */
export function testRuns(runs: readonly SampledRun[], metric: string, test: string): RunSamples[] {
  return runs.flatMap(({ uuid, measured_at, samples }) => {
    const values: number[] = []
    for (const sample of samples) {
      const value = sample.test === test ? valueOf(sample, metric) : undefined
      if (value !== undefined) values.push(value)
    }
    if (values.length === 0) return []
    return [{ run: uuid, measured: measured_at, samples: values.sort((x, y) => x - y) }]
  })
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
 * `ln(Γ(z))`, by the Lanczos approximation, for `z >= 0.5`: every argument the t-distribution
 * gives it here, whose degrees of freedom are at least 1 (see `logWelch`).
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

/** `ln(B(a, b))`, the logarithm of the beta function. */
function lnBeta(a: number, b: number): number {
  return lnGamma(a) + lnGamma(b) - lnGamma(a + b)
}

/**
 * The regularized incomplete beta function `I_x(a, b)`, from its continued fraction, evaluated by
 * the modified Lentz method (as Numerical Recipes' `betacf` does), on whichever side of the mean
 * `x` falls for it to converge quickly. `lnB` is `lnBeta(a, b)`, for a caller evaluating it at
 * many `x` to compute only once.
 */
function incompleteBeta(x: number, a: number, b: number, lnB = lnBeta(a, b)): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  if (x > (a + 1) / (a + b + 2)) return 1 - incompleteBeta(1 - x, b, a, lnB)
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - Math.log(a) - lnB)
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
 * The two-tailed p-value of `t` in Student's t-distribution with `df` degrees of freedom: how
 * likely a value at least as far from 0 is.
 */
function twoTailed(t: number, df: number): number {
  return incompleteBeta(df / (df + t * t), df / 2, 0.5)
}

/**
 * The two-sided critical value of Student's t-distribution with `df` degrees of freedom at
 * `confidence`, a fraction between 0 and 1 excluded: the `t` whose two-tailed p-value is
 * `1 - confidence`. Found by bisection on `x = df / (df + t²)`, which the p-value increases with,
 * to a relative precision of about 1e-12 on `x`: `t`'s grows with `df`, to about 1e-7 at a
 * million degrees of freedom, still far below what could change a status.
 */
export function criticalT(confidence: number, df: number): number {
  const alpha = 1 - confidence
  const lnB = lnBeta(df / 2, 0.5)
  let low = 0
  let high = 1
  while (high - low > 1e-12 * low) {
    const x = (low + high) / 2
    if (x === low || x === high) break
    if (incompleteBeta(x, df / 2, 0.5, lnB) < alpha) low = x
    else high = x
  }
  const x = (low + high) / 2
  return Math.sqrt((df * (1 - x)) / x)
}

/** How many runs with a value each side needs for a test's change to have an interval. */
export const MIN_RUNS = 2

/**
 * Why a test's change has no confidence interval (CP2 "Status classification"): a run's value that
 * is not positive, which has no logarithm, or fewer than 2 runs on side A, on side B or on both.
 */
export type NoInterval = { kind: 'nonPositive' } | { kind: 'runs'; sides: 'A' | 'B' | 'both' }

/** Welch's t-test between the logarithms of two sides' runs' values for a test. */
export interface LogSpread {
  kind: 'spread'
  /** `mean(ln B) - mean(ln A)`: the logarithm of the ratio of the geometric means. */
  difference: number
  /** The standard error of `difference`: 0 when neither side varies. */
  standardError: number
  /**
   * The Welch-Satterthwaite degrees of freedom, which are at least `min(nA, nB) - 1`, and so at
   * least 1. Infinite when neither side varies, where they do not matter.
   */
  df: number
  /**
   * The two-tailed p-value of `difference`. Without variance, the change is exact: 0 when there is
   * one, 1 when there is none.
   */
  pValue: number
}

/**
 * Welch's t-test between the logarithms of `a` and `b`, two sides' runs' values for a test (CP2
 * "Computation Reference"), unless a value is not positive, or a side has fewer than 2 of them,
 * checked in this order.
 */
export function logWelch(a: readonly number[], b: readonly number[]): LogSpread | NoInterval {
  if (a.some((value) => !(value > 0)) || b.some((value) => !(value > 0))) {
    return { kind: 'nonPositive' }
  }
  if (a.length < MIN_RUNS || b.length < MIN_RUNS) {
    const sides = a.length < MIN_RUNS ? (b.length < MIN_RUNS ? 'both' : 'A') : 'B'
    return { kind: 'runs', sides }
  }
  const logA = a.map(Math.log)
  const logB = b.map(Math.log)
  const meanA = mean(logA)
  const meanB = mean(logB)
  const difference = meanB - meanA
  // The variance of each side's mean.
  const spreadA = variance(logA, meanA) / a.length
  const spreadB = variance(logB, meanB) / b.length
  const spread = spreadA + spreadB
  if (spread === 0) {
    const pValue = difference === 0 ? 1 : 0
    return { kind: 'spread', difference, standardError: 0, df: Infinity, pValue }
  }
  const standardError = Math.sqrt(spread)
  const df = spread ** 2 / (spreadA ** 2 / (a.length - 1) + spreadB ** 2 / (b.length - 1))
  const pValue = twoTailed(difference / standardError, df)
  return { kind: 'spread', difference, standardError, df, pValue }
}

/**
 * The confidence interval of a test's change (CP2 "Computation Reference"), as the logarithms of
 * the ratio B / A: its estimate, the ratio of the geometric means of the two sides' runs' values,
 * and its bounds.
 */
export interface Interval {
  kind: 'interval'
  /** The confidence level, as a percentage. */
  confidence: number
  estimate: number
  low: number
  high: number
  /** The p-value of Welch's t-test between the same values (see `LogSpread`). */
  pValue: number
}

/** A test's change: its confidence interval, or why it has none. */
export type Change = Interval | NoInterval

/** The confidence interval at `confidence`, a percentage, of the change `spread` describes. */
export function intervalOf(spread: LogSpread | NoInterval, confidence: number): Change {
  if (spread.kind !== 'spread') return spread
  const { difference, standardError, df, pValue } = spread
  const half = standardError === 0 ? 0 : criticalT(confidence / 100, df) * standardError
  return {
    kind: 'interval',
    confidence,
    estimate: difference,
    low: difference - half,
    high: difference + half,
    pValue,
  }
}

/** The p-value of a change, or null when it has no interval. */
export function pValueOf(change: Change): number | null {
  return change.kind === 'interval' ? change.pValue : null
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
    return {
      test,
      statisticsA: { ...statisticsOf(ofA.flat()), runs: ofA.length },
      statisticsB: { ...statisticsOf(ofB.flat()), runs: ofB.length },
    }
  })
}

/** Each run's value of each test, of the runs that have samples of it, in the runs' order. */
export type RunValues = Map<string, number[]>

/** Each run's value of each test (CP2 "Aggregation pipeline"): `sampleAgg` combines its samples. */
export function runValues(side: SideSamples, sampleAgg: Aggregation): RunValues {
  const values: RunValues = new Map()
  for (const [test, perRun] of side) {
    values.set(test, perRun.map((ofRun) => aggregate(ofRun, sampleAgg)))
  }
  return values
}

/** A side's value of each test (CP2 "Aggregation pipeline"): `runAgg` combines its runs' values. */
export function sideValues(perRun: RunValues, runAgg: Aggregation): Map<string, number> {
  const values = new Map<string, number>()
  for (const [test, ofRuns] of perRun) values.set(test, aggregate(ofRuns, runAgg))
  return values
}

/** The change of each test, at `confidence`, a percentage, from its runs' values on each side. */
export function changes(
  tests: readonly ComparedTest[],
  a: RunValues,
  b: RunValues,
  confidence: number,
): Map<string, Change> {
  return new Map(
    tests.map(({ test }) => {
      const spread = logWelch(a.get(test) ?? [], b.get(test) ?? [])
      return [test, intervalOf(spread, confidence)]
    }),
  )
}

/** The statuses of a test whose sides can be compared, which CP4 gives the share of. */
export const COMPARABLE = ['improved', 'regressed', 'unchanged', 'inconclusive'] as const

/** The statuses of CP2, in the order the table sorts them and CP4 lists the comparable ones. */
export const STATUSES = [...COMPARABLE, 'na'] as const

export type Status = (typeof STATUSES)[number]

/** The status of a test whose sides can be compared, from its change (CP2). */
export function statusOf(change: Change, margin: number, biggerIsBetter: boolean): Status {
  if (change.kind !== 'interval') return 'inconclusive'
  // The margin's band, [1 / (1 + m), 1 + m], is symmetric around 0 in log space.
  const edge = Math.log1p(margin / 100)
  if (change.low > edge) return biggerIsBetter ? 'improved' : 'regressed'
  if (change.high < -edge) return biggerIsBetter ? 'regressed' : 'improved'
  return change.low >= -edge && change.high <= edge ? 'unchanged' : 'inconclusive'
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

/** A test of the comparison, with each side's value of it and how they differ. */
export type ValueRow = ComparedTest & Omit<Values, 'status'>

/** A row of the comparison table. */
export interface ComparisonRow extends ValueRow, Values {
  /** The test's change, from its runs' values, whatever its status. */
  change: Change
}

/** How `a` and `b`, each side's value of a test, differ (CP2 "Per-test derived columns"). */
function derive(
  a: number | null,
  b: number | null,
): Pick<Values, 'delta' | 'deltaPct' | 'ratio'> {
  if (a === null || b === null) return { delta: null, deltaPct: null, ratio: null }
  const delta = b - a
  if (a === 0) return { delta, deltaPct: null, ratio: null }
  // Over |a|, so that Delta % has the sign of Delta, even with a negative baseline.
  return { delta, deltaPct: (delta / Math.abs(a)) * 100, ratio: b / a }
}

/** The values of a row that has nothing to compare: N/A throughout. */
const NOTHING: Values = { a: null, b: null, delta: null, deltaPct: null, ratio: null, status: 'na' }

/** Delta's status, from its sign and the metric's `bigger_is_better`: the geomean row's (CP2). */
function statusOfDelta(delta: number, biggerIsBetter: boolean): Status {
  if (delta === 0) return 'unchanged'
  return delta > 0 === biggerIsBetter ? 'improved' : 'regressed'
}

export interface RowOptions {
  biggerIsBetter: boolean
  /** The margin, as a percentage (CP1). */
  margin: number
}

/** `tests`, with each side's value of them (see `sideValues`), and how they differ. */
export function valueRows(
  tests: readonly ComparedTest[],
  valuesA: ReadonlyMap<string, number>,
  valuesB: ReadonlyMap<string, number>,
): ValueRow[] {
  return tests.map((test) => {
    const a = valuesA.get(test.test) ?? null
    const b = valuesB.get(test.test) ?? null
    return { ...test, a, b, ...derive(a, b) }
  })
}

/**
 * The rows of `tests`, from each side's values (see `sideValues`) and each test's change (see
 * `changes`). A test's status is N/A when a side has no value or the baseline is 0, and comes from
 * its change otherwise.
 */
export function compareRows(
  tests: readonly ComparedTest[],
  valuesA: ReadonlyMap<string, number>,
  valuesB: ReadonlyMap<string, number>,
  changesOf: ReadonlyMap<string, Change>,
  { biggerIsBetter, margin }: RowOptions,
): ComparisonRow[] {
  return valueRows(tests, valuesA, valuesB).map((row) => {
    const change = changesOf.get(row.test)!
    const status = row.ratio === null ? 'na' : statusOf(change, margin, biggerIsBetter)
    return { ...row, status, change }
  })
}

/** The filters of CP1: |Delta %| at least, P-value at most and Absolute at least. */
export type FilterKey = 'deltaPct' | 'pValue' | 'abs'

/** Each filter's threshold, or null while it is disabled. */
export type Filters = Record<FilterKey, number | null>

/**
 * Whether `row` passes the enabled `filters` (CP1). A test that cannot be compared passes every
 * filter; one that can passes a filter only when the filter's value is defined for it and meets
 * the threshold.
 */
export function passesFilters(row: ComparisonRow, { deltaPct, pValue, abs }: Filters): boolean {
  if (row.status === 'na') return true
  if (deltaPct !== null && !(Math.abs(row.deltaPct!) >= deltaPct)) return false
  if (pValue !== null) {
    const p = pValueOf(row.change)
    if (p === null || p > pValue) return false
  }
  return abs === null || Math.max(Math.abs(row.a!), Math.abs(row.b!)) >= abs
}

/** The geometric mean of the absolute values of `values`, at least one of them, none zero. */
function geomean(values: readonly number[]): number {
  return Math.exp(mean(values.map((value) => Math.log(Math.abs(value)))))
}

/**
 * The geomean summary row of `rows`, the compared rows (CP2): over those where both sides have a
 * value and neither is 0. Its status comes from the sign of its Delta. With no such row, every
 * value is null and the status N/A.
 */
export function geomeanRow(rows: readonly Values[], biggerIsBetter: boolean): Values {
  const pairs: [number, number][] = []
  for (const { a, b } of rows) {
    if (a !== null && b !== null && a !== 0 && b !== 0) pairs.push([a, b])
  }
  if (pairs.length === 0) return NOTHING
  const a = geomean(pairs.map(([value]) => value))
  const b = geomean(pairs.map(([, value]) => value))
  // Over the same tests, the geomean of the ratios is that of B over that of A.
  const derived = derive(a, b)
  return { a, b, ...derived, status: statusOfDelta(derived.delta!, biggerIsBetter) }
}

/** The categories of the summary bar (CP4), in the order it shows them. */
export const CATEGORIES = [...COMPARABLE, 'onlyA', 'onlyB', 'zeroBaseline'] as const

export type Category = (typeof CATEGORIES)[number]

/** How the table names each status, and the summary bar each category. */
export const LABELS: Record<Status | Category, string> = {
  improved: 'Improved',
  regressed: 'Regressed',
  unchanged: 'Unchanged',
  inconclusive: 'Inconclusive',
  onlyA: 'Only in A',
  onlyB: 'Only in B',
  na: 'N/A',
  zeroBaseline: 'Zero baseline',
}

/**
 * The summary bar's category of a row: the side it has a value on, if only one, else its status,
 * with N/A as Zero baseline.
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
