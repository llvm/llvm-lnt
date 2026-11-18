import { describe, expect, it } from 'vitest'
import {
  categoryOf,
  changes,
  compareRows,
  criticalT,
  changeOf,
  geomeanRow,
  joinSides,
  passesFilters,
  runValues,
  sideSamples,
  sideValues,
  statisticsOf,
  statusOf,
  summaryCounts,
  testRuns,
  type Change,
  type ComparedTest,
  type Filters,
  type Interval,
  type SampledRun,
  type Values,
} from './comparison'
import { interval, logInterval } from './compare-world'

/** A test with no statistics to speak of, for the steps that do not read them. */
function tested(test: string): ComparedTest {
  const none = statisticsOf([])
  return { test, statisticsA: { ...none, runs: 0 }, statisticsB: { ...none, runs: 0 } }
}

/** A change with only one run on side B, which classifies a test as inconclusive. */
const ONE_RUN: Change = { kind: 'runs', sides: 'B' }

/** The row of a test valued `a` and `b`, the other settings as given. */
function row(
  a: number | null,
  b: number | null,
  { biggerIsBetter = false, margin = 5, change = ONE_RUN } = {},
) {
  const values = (value: number | null) => new Map(value === null ? [] : [['t', value]])
  return compareRows([tested('t')], values(a), values(b), new Map([['t', change]]), {
    biggerIsBetter,
    margin,
  })[0]
}

/** The edge of a 5% margin, in log space. */
const EDGE = Math.log1p(0.05)

/** The interval `changeOf` gives, which a test expects there to be. */
function ci(a: number[], b: number[], confidence = 90): Interval {
  const change = changeOf(a, b, confidence)
  if (change.kind !== 'interval') throw new Error(`no interval: ${change.kind}`)
  return change
}

/** A row's values, with the status given and the derived values left out. */
function valued(a: number | null, b: number | null, status: Values['status'] = 'na'): Values {
  return { a, b, delta: null, deltaPct: null, ratio: null, status }
}

describe('sideSamples', () => {
  it("groups each run's values of the metric by test, a run at a time", () => {
    const side = sideSamples(
      [
        [
          { test: 'a', metrics: { time: 1, size: 10 } },
          { test: 'a', metrics: { time: 2 } },
          { test: 'b', metrics: { time: 3 } },
        ],
        [{ test: 'a', metrics: { time: 4 } }],
      ],
      'time',
    )
    expect(side).toEqual(
      new Map([
        ['a', [[1, 2], [4]]],
        ['b', [[3]]],
      ]),
    )
  })

  it('leaves out samples without a value for the metric, and runs without one for a test', () => {
    const side = sideSamples(
      [[{ test: 'a', metrics: { size: 10 } }], [{ test: 'a', metrics: { time: 4 } }]],
      'time',
    )
    expect(side).toEqual(new Map([['a', [[4]]]]))
  })
})

describe('testRuns', () => {
  const measured_at = '2026-08-20T10:00:00Z'

  it("gives each run's values of the metric for the test, ascending, in the runs' order", () => {
    const runs: SampledRun[] = [
      {
        uuid: 'r2',
        measured_at,
        samples: [
          { test: 'a', metrics: { time: 3 } },
          { test: 'b', metrics: { time: 9 } },
          { test: 'a', metrics: { time: 1, size: 10 } },
          { test: 'a', metrics: { time: 2 } },
        ],
      },
      { uuid: 'r1', measured_at, samples: [{ test: 'a', metrics: { time: 4 } }] },
    ]
    expect(testRuns(runs, 'time', 'a')).toEqual([
      { run: 'r2', measured: measured_at, samples: [1, 2, 3] },
      { run: 'r1', measured: measured_at, samples: [4] },
    ])
  })

  it('leaves out the runs without a value of the metric for the test, as sideSamples does', () => {
    const runs: SampledRun[] = [
      { uuid: 'r1', measured_at, samples: [{ test: 'a', metrics: { size: 10 } }] },
      { uuid: 'r2', measured_at, samples: [{ test: 'b', metrics: { time: 1 } }] },
      { uuid: 'r3', measured_at, samples: [{ test: 'a', metrics: { time: 'x' } }] },
    ]
    expect(testRuns(runs, 'time', 'a')).toEqual([])
  })
})

describe('statisticsOf', () => {
  it('describes the values', () => {
    expect(statisticsOf([2, 4, 4, 4, 5, 5, 7, 9])).toEqual({
      count: 8,
      mean: 5,
      median: 4.5,
      min: 2,
      max: 9,
      // The sample standard deviation, over n - 1.
      stddev: Math.sqrt(32 / 7),
      cv: (Math.sqrt(32 / 7) / 5) * 100,
    })
  })

  it('has no standard deviation, nor CV, with a single value', () => {
    expect(statisticsOf([3])).toMatchObject({ count: 1, mean: 3, stddev: null, cv: null })
  })

  it('has no deviation at all for equal values, even those a sum does not keep exact', () => {
    expect(statisticsOf([0.1, 0.1, 0.1])).toMatchObject({ mean: 0.1, stddev: 0, cv: 0 })
  })

  it('has no CV when the mean is 0, and takes it over the absolute mean', () => {
    expect(statisticsOf([-1, 1]).cv).toBeNull()
    expect(statisticsOf([-1, -3]).cv).toBeCloseTo((Math.SQRT2 / 2) * 100)
  })

  it('counts no samples, and has nothing else, without values', () => {
    expect(statisticsOf([])).toEqual({
      count: 0,
      mean: null,
      median: null,
      min: null,
      max: null,
      stddev: null,
      cv: null,
    })
  })
})

describe('criticalT', () => {
  // scipy.stats.t.ppf(1 - (1 - confidence) / 2, df).
  const REFERENCE: [df: number, values: number[]][] = [
    [1, [3.0776835371752544, 6.313751514675037, 12.706204736174694, 63.656741162871526]],
    [2.5, [1.7302509288071768, 2.5582186141359355, 3.574654842003682, 7.163728138948783]],
    [1000, [1.2823987214609243, 1.6463788172854639, 1.9623390808264078, 2.5807546980659506]],
  ]

  it.each(REFERENCE)("matches Student's t-distribution with %s degrees of freedom", (df, values) => {
    ;[0.8, 0.9, 0.95, 0.99].forEach((confidence, i) => {
      expect(criticalT(confidence, df)).toBeCloseTo(values[i], 9)
    })
  })
})

describe('changeOf', () => {
  it("matches scipy's Welch t-test on the logs, with unequal counts and variances", () => {
    const [a, b] = [
      [10, 12, 11.5],
      [13, 15, 14.2, 16.1],
    ]
    // scipy's ttest_ind(equal_var=False), and its confidence_interval(0.9) and (0.95).
    const at90 = ci(a, b, 90)
    expect(at90.pValue).toBeCloseTo(0.017683292059657702, 10)
    expect(at90.low).toBeCloseTo(0.11748929562398966, 10)
    expect(at90.high).toBeCloseTo(0.4151485831891999, 10)
    const at95 = ci(a, b, 95)
    expect(at95.low).toBeCloseTo(0.07390116260564122, 10)
    expect(at95.high).toBeCloseTo(0.45873671620754836, 10)
    expect(at90.estimate).toBeCloseTo(
      Math.log(Math.cbrt(13 * 15 * 14.2 * 16.1) ** (3 / 4) / Math.cbrt(10 * 12 * 11.5)),
      12,
    )
  })

  it("leaves one side without variance the other's degrees of freedom", () => {
    // scipy's, with 2 degrees of freedom.
    const change = ci([5, 5, 5], [6, 7, 6.5])
    expect(change.pValue).toBeCloseTo(0.02799916100654397, 10)
    expect(change.low).toBeCloseTo(0.13041611830154104, 10)
    expect(change.high).toBeCloseTo(0.39035592028689753, 10)
  })

  it('makes the interval a point without variance: p is 0 with a change, and 1 without', () => {
    const point = ci([2, 2], [3, 3, 3], 99)
    expect(point.pValue).toBe(0)
    expect(point.estimate).toBeCloseTo(Math.log(1.5), 15)
    expect([point.low, point.high]).toEqual([point.estimate, point.estimate])
    expect(ci([0.1, 0.1, 0.1], [0.1, 0.1])).toMatchObject({ low: 0, high: 0, pValue: 1 })
  })

  it('sees no variance in equal values, even those a sum does not keep exact', () => {
    expect(ci(Array(27).fill(0.609), Array(30).fill(0.609)).pValue).toBe(1)
  })

  it('is the same whichever side comes first, but for its sign', () => {
    const forth = ci([1, 2, 4], [2, 6, 7, 9])
    const back = ci([2, 6, 7, 9], [1, 2, 4])
    expect(back.pValue).toBeCloseTo(forth.pValue, 12)
    expect(back.low).toBeCloseTo(-forth.high, 12)
  })

  it('needs 2 runs on each side, and positive values, which it checks first', () => {
    expect(changeOf([1], [1, 2], 90)).toEqual({ kind: 'runs', sides: 'A' })
    expect(changeOf([1, 2], [3], 90)).toEqual({ kind: 'runs', sides: 'B' })
    expect(changeOf([1], [], 90)).toEqual({ kind: 'runs', sides: 'both' })
    expect(changeOf([1, 0], [1], 90)).toEqual({ kind: 'nonPositive' })
    expect(changeOf([1, 2], [-1], 90)).toEqual({ kind: 'nonPositive' })
  })

  it('has p below alpha exactly when the interval at 1 - alpha excludes no change', () => {
    // A deterministic stream of positive values (see synthetic.ts's `random`).
    let state = 12345
    const next = () => {
      state = (state * 1103515245 + 12345) % 2 ** 31
      return 0.5 + state / 2 ** 31
    }
    for (let i = 0; i < 200; i++) {
      const a = Array.from({ length: 2 + (i % 4) }, next)
      const b = Array.from({ length: 2 + (i % 3) }, () => next() * 1.3)
      for (const confidence of [80, 90, 95, 99]) {
        const change = ci(a, b, confidence)
        const alpha = 1 - confidence / 100
        // Away from the boundary, where rounding could tell them apart.
        if (Math.abs(change.pValue - alpha) < 1e-9) continue
        expect(change.pValue < alpha).toBe(change.low > 0 || change.high < 0)
      }
    }
  })
})

describe('statusOf', () => {
  it('is improved or regressed beyond the margin, as bigger is better or not', () => {
    expect(statusOf(interval(1.06, 1.2), 5, false)).toBe('regressed')
    expect(statusOf(interval(1.06, 1.2), 5, true)).toBe('improved')
    expect(statusOf(interval(0.8, 0.94), 5, false)).toBe('improved')
    expect(statusOf(interval(0.8, 0.94), 5, true)).toBe('regressed')
  })

  it('is unchanged within the margin, which is symmetric in log space, edges included', () => {
    expect(statusOf(interval(0.99, 1.02), 5, false)).toBe('unchanged')
    expect(statusOf(logInterval(-EDGE, EDGE), 5, false)).toBe('unchanged')
    // 0.95 is beyond 1 / 1.05.
    expect(statusOf(interval(0.95, 1), 5, false)).toBe('inconclusive')
  })

  it('is inconclusive across an edge, or touching it from beyond', () => {
    expect(statusOf(interval(1.02, 1.08), 5, false)).toBe('inconclusive')
    expect(statusOf(interval(0.5, 2), 5, true)).toBe('inconclusive')
    expect(statusOf(logInterval(EDGE, 0.2), 5, false)).toBe('inconclusive')
    expect(statusOf(logInterval(-0.2, -EDGE), 5, false)).toBe('inconclusive')
  })

  it('is inconclusive without an interval', () => {
    expect(statusOf({ kind: 'runs', sides: 'A' }, 5, false)).toBe('inconclusive')
    expect(statusOf({ kind: 'nonPositive' }, 5, false)).toBe('inconclusive')
  })

  it('makes a significance test of a margin of 0, where only an exact equality is unchanged', () => {
    expect(statusOf(interval(1.001, 1.002), 0, false)).toBe('regressed')
    expect(statusOf(interval(0.99, 1.01), 0, false)).toBe('inconclusive')
    expect(statusOf(ci([3, 3], [3, 3]), 0, false)).toBe('unchanged')
    expect(statusOf(ci([3, 3], [4, 4]), 0, true)).toBe('improved')
  })
})

describe('joinSides', () => {
  it('holds every test with a value on either side, in order, with each side described', () => {
    const tests = joinSides(
      new Map([
        ['b', [[1, 3], [5]]],
        ['a', [[2]]],
      ]),
      new Map([['c', [[4, 6]]]]),
    )
    expect(tests.map((entry) => entry.test)).toEqual(['a', 'b', 'c'])
    expect(tests[1].statisticsA).toMatchObject({ count: 3, runs: 2, mean: 3, min: 1, max: 5 })
    expect(tests[1].statisticsB).toMatchObject({ count: 0, runs: 0, mean: null })
    expect(tests[2].statisticsB).toMatchObject({ count: 2, runs: 1, mean: 5 })
  })

})

describe('runValues and sideValues', () => {
  const side = new Map([['t', [[1, 2, 9], [4], [5, 7]]]])
  const valueOf = (sampleAgg: 'median' | 'min' | 'mean', runAgg: 'median' | 'max' | 'mean') =>
    sideValues(runValues(side, sampleAgg), runAgg).get('t')

  it("combines each run's samples, then the runs' values", () => {
    expect(runValues(side, 'median').get('t')).toEqual([2, 4, 6])
    // Per run, the medians are 2, 4 and 6, whose median is 4.
    expect(valueOf('median', 'median')).toBe(4)
    // Per run, the smallest are 1, 4 and 5, whose largest is 5.
    expect(valueOf('min', 'max')).toBe(5)
    // Per run, the means are 4, 4 and 6, whose mean is 14 / 3.
    expect(valueOf('mean', 'mean')).toBeCloseTo(14 / 3)
  })
})

describe('changes', () => {
  it("compare each test's runs' values, not their pooled samples", () => {
    const tests = [tested('t'), tested('u')]
    const a = runValues(
      new Map([
        ['t', [[1, 9], [2]]],
        ['u', [[1]]],
      ]),
      'min',
    )
    const b = runValues(new Map([['t', [[2], [4, 5]]]]), 'min')
    const changed = changes(tests, a, b, 95)
    expect(changed.get('t')).toEqual(changeOf([1, 2], [2, 4], 95))
    expect(changed.get('u')).toEqual({ kind: 'runs', sides: 'both' })
  })
})

describe('compareRows', () => {
  it('derives Delta, Delta % and Ratio from the two values', () => {
    expect(row(4, 5)).toMatchObject({ a: 4, b: 5, delta: 1, deltaPct: 25, ratio: 1.25 })
  })

  it('gives Delta % the sign of Delta, even with a negative baseline', () => {
    expect(row(-4, -3)).toMatchObject({ delta: 1, deltaPct: 25, ratio: 0.75 })
    expect(row(-4, -5)).toMatchObject({ delta: -1, deltaPct: -25 })
  })

  it('classifies a test from its change, whatever its values, with the margin', () => {
    const change = interval(1.02, 1.04)
    expect(row(4, 5, { change }).status).toBe('unchanged')
    expect(row(4, 5, { change, margin: 1 }).status).toBe('regressed')
    expect(row(4, 5, { change, margin: 1, biggerIsBetter: true }).status).toBe('improved')
    expect(row(4, 4).status).toBe('inconclusive')
  })

  it('leaves everything N/A when a side has no value', () => {
    for (const unvalued of [row(null, 5), row(4, null)]) {
      expect(unvalued).toMatchObject({ delta: null, deltaPct: null, ratio: null, status: 'na' })
    }
    expect(row(null, 5).b).toBe(5)
  })

  it('computes Delta only, with a zero baseline', () => {
    expect(row(0, 5)).toMatchObject({ delta: 5, deltaPct: null, ratio: null, status: 'na' })
  })

  it('keeps the change of a test that cannot be compared, for its columns', () => {
    expect(row(0, 1, { change: interval(1, 2) })).toMatchObject({
      status: 'na',
      change: interval(1, 2),
    })
  })
})

describe('passesFilters', () => {
  const NONE: Filters = { deltaPct: null, pValue: null, abs: null }
  const passes = (filters: Partial<Filters>, ...args: Parameters<typeof row>) =>
    passesFilters(row(...args), { ...NONE, ...filters })

  it('passes every test while no filter is enabled', () => {
    expect(passes({}, 1, 1.001)).toBe(true)
  })

  it('passes |Delta %| at least the threshold, either way', () => {
    expect(passes({ deltaPct: 5 }, 100, 105)).toBe(true)
    expect(passes({ deltaPct: 5 }, 100, 95)).toBe(true)
    expect(passes({ deltaPct: 5 }, 100, 104)).toBe(false)
  })

  it('passes a p-value at most the threshold, and fails a test without one', () => {
    const at = (pValue: number) => ({ change: interval(1, 2, pValue) })
    expect(passes({ pValue: 0.05 }, 1, 2, at(0.05))).toBe(true)
    expect(passes({ pValue: 0.05 }, 1, 2, at(0.06))).toBe(false)
    expect(passes({ pValue: 0.05 }, 1, 2, { change: ONE_RUN })).toBe(false)
    expect(passes({ pValue: 0.05 }, 1, 2, { change: { kind: 'nonPositive' } })).toBe(false)
  })

  it('passes a larger absolute value at least the threshold', () => {
    expect(passes({ abs: 3 }, 1, -3)).toBe(true)
    expect(passes({ abs: 3 }, -1, 2.9)).toBe(false)
  })

  it('needs every filter enabled to pass', () => {
    expect(passes({ deltaPct: 5, abs: 10 }, 100, 110)).toBe(true)
    expect(passes({ deltaPct: 5, abs: 200 }, 100, 110)).toBe(false)
  })

  it('passes every test that cannot be compared', () => {
    const all = { deltaPct: 50, pValue: 0.01, abs: 1000 }
    expect(passes(all, null, 5)).toBe(true)
    expect(passes(all, 5, null)).toBe(true)
    expect(passes(all, 0, 5)).toBe(true)
  })
})

describe('geomeanRow', () => {
  const OPTIONS = { biggerIsBetter: false, margin: 5 }

  it('takes the geometric means of the absolute values, and their ratio', () => {
    const geomean = geomeanRow([valued(1, 2), valued(-4, -2)], OPTIONS)
    expect(geomean.a).toBeCloseTo(2)
    expect(geomean.b).toBeCloseTo(2)
    expect(geomean.ratio).toBeCloseTo(1)
    expect(geomean.delta).toBeCloseTo(0)
  })

  it('leaves out rows with a side without a value, or a zero on either side', () => {
    const geomean = geomeanRow(
      [valued(2, 8), valued(null, 3), valued(0, 3), valued(3, 0), valued(5, null)],
      { ...OPTIONS, biggerIsBetter: true },
    )
    expect(geomean.a).toBeCloseTo(2)
    expect(geomean.b).toBeCloseTo(8)
    expect(geomean.delta).toBeCloseTo(6)
    expect(geomean.deltaPct).toBeCloseTo(300)
    expect(geomean.ratio).toBeCloseTo(4)
    expect(geomean.status).toBe('improved')
  })

  it("classifies its Ratio against the margin, edges included, whatever the rows' statuses", () => {
    const statusAt = (b: number, options = OPTIONS) =>
      geomeanRow([valued(100, b, 'inconclusive')], options).status
    expect(statusAt(108)).toBe('regressed')
    expect(statusAt(108, { biggerIsBetter: true, margin: 5 })).toBe('improved')
    expect(statusAt(92)).toBe('improved')
    expect(statusAt(98.41)).toBe('unchanged')
    expect(statusAt(104.9)).toBe('unchanged')
    expect(statusAt(108, { biggerIsBetter: false, margin: 10 })).toBe('unchanged')
    expect(statusAt(100.1, { biggerIsBetter: false, margin: 0 })).toBe('regressed')
  })

  it('is N/A with no row to take', () => {
    expect(geomeanRow([valued(0, 1)], OPTIONS)).toEqual(valued(null, null))
  })
})

describe('summaryCounts', () => {
  it('counts each row once, in its status or by the side it has a value on', () => {
    const counts = summaryCounts([
      valued(1, 2, 'regressed'),
      valued(2, 1, 'improved'),
      valued(2, 1, 'improved'),
      valued(1, 1, 'unchanged'),
      valued(1, 1.01, 'inconclusive'),
      valued(1, null),
      valued(null, 1),
      valued(null, 1),
      valued(0, 1),
    ])
    expect(counts).toEqual({
      improved: 2,
      regressed: 1,
      unchanged: 1,
      inconclusive: 1,
      onlyA: 1,
      onlyB: 2,
      zeroBaseline: 1,
    })
  })

  it('puts a zero baseline in its category only when both sides have a value', () => {
    expect(categoryOf(valued(0, 1))).toBe('zeroBaseline')
    expect(categoryOf(valued(0, null))).toBe('onlyA')
  })
})
