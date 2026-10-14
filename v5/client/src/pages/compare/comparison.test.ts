import { describe, expect, it } from 'vitest'
import {
  categoryOf,
  compareRows,
  formatShare,
  geomeanRow,
  joinSides,
  sideSamples,
  sideValues,
  statisticsOf,
  summaryCounts,
  welchTTest,
  type ComparedTest,
  type NoiseSettings,
  type Values,
} from './comparison'

const NO_NOISE: NoiseSettings = { pct: null, pval: null, floor: null }

/** A test with no statistics to speak of, for the steps that do not read them. */
function tested(test: string, pValue: number | null = null): ComparedTest {
  const none = statisticsOf([])
  return { test, statisticsA: { ...none, runs: 0 }, statisticsB: { ...none, runs: 0 }, pValue }
}

/** The row of a test valued `a` and `b`, the other settings as given. */
function row(
  a: number | null,
  b: number | null,
  { biggerIsBetter = false, noise = NO_NOISE, pValue = null as number | null } = {},
) {
  const values = (value: number | null) => new Map(value === null ? [] : [['t', value]])
  return compareRows([tested('t', pValue)], values(a), values(b), { biggerIsBetter, noise })[0]
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

describe('welchTTest', () => {
  it('matches the t-distribution with 1 degree of freedom', () => {
    // One side without variance leaves the other's n - 1 = 1 degree of freedom, and t = -4. The
    // two-tailed p-value of t with 1 degree of freedom is 1 - 2 atan(|t|) / π.
    expect(welchTTest([0, 2], [5, 5])).toBeCloseTo(1 - (2 * Math.atan(4)) / Math.PI, 10)
  })

  it('matches the t-distribution with 2 degrees of freedom', () => {
    // Likewise with 2 degrees of freedom and t = -2√3, whose p-value is 1 - |t| / √(2 + t²).
    const t = 2 * Math.sqrt(3)
    expect(welchTTest([0, 1, 2], [3, 3, 3])).toBeCloseTo(1 - t / Math.sqrt(2 + t * t), 10)
  })

  it("matches Wikipedia's first example of Welch's t-test", () => {
    const a = [
      27.5, 21.0, 19.0, 23.6, 17.0, 17.9, 16.9, 20.1, 21.9, 22.6, 23.1, 19.6, 19.0, 21.7, 21.4,
    ]
    const b = [
      27.1, 22.0, 20.8, 23.4, 23.4, 23.5, 25.8, 22.0, 24.8, 20.2, 21.9, 22.1, 22.9, 20.5, 24.4,
    ]
    expect(welchTTest(a, b)).toBeCloseTo(0.021, 3)
  })

  it('is the same whichever side comes first, and 1 between identical samples', () => {
    expect(welchTTest([1, 2, 4], [2, 6, 7, 9])).toBeCloseTo(welchTTest([2, 6, 7, 9], [1, 2, 4])!)
    expect(welchTTest([1, 2, 4], [1, 2, 4])).toBeCloseTo(1)
  })

  it('is skipped with fewer than 2 samples on a side', () => {
    expect(welchTTest([1], [1, 2])).toBeNull()
    expect(welchTTest([1, 2], [])).toBeNull()
  })

  it('is skipped without variance and with equal means, and 0 with different means', () => {
    expect(welchTTest([3, 3], [3, 3, 3])).toBeNull()
    expect(welchTTest([3, 3], [4, 4])).toBe(0)
  })

  it('sees no variance in equal values, even those a sum does not keep exact', () => {
    expect(welchTTest([0.1, 0.1, 0.1], [0.1, 0.1])).toBeNull()
    expect(welchTTest(Array(27).fill(0.609), Array(30).fill(0.609))).toBeNull()
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

  it("tests the two sides' pooled samples, whatever the runs they come from", () => {
    const [test] = joinSides(new Map([['t', [[1], [2, 4]]]]), new Map([['t', [[2, 6, 7, 9]]]]))
    expect(test.pValue).toBe(welchTTest([1, 2, 4], [2, 6, 7, 9]))
  })
})

describe('sideValues', () => {
  const side = new Map([['t', [[1, 2, 9], [4], [5, 7]]]])

  it("combines each run's samples, then the runs' values", () => {
    // Per run, the medians are 2, 4 and 6, whose median is 4.
    expect(sideValues(side, 'median', 'median').get('t')).toBe(4)
    // Per run, the smallest are 1, 4 and 5, whose largest is 5.
    expect(sideValues(side, 'min', 'max').get('t')).toBe(5)
    // Per run, the means are 4, 4 and 6, whose mean is 14 / 3.
    expect(sideValues(side, 'mean', 'mean').get('t')).toBeCloseTo(14 / 3)
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

  it("classifies a change by Delta's sign and whether bigger is better", () => {
    expect(row(4, 5).status).toBe('regressed')
    expect(row(5, 4).status).toBe('improved')
    expect(row(4, 5, { biggerIsBetter: true }).status).toBe('improved')
    expect(row(5, 4, { biggerIsBetter: true }).status).toBe('regressed')
    expect(row(4, 4).status).toBe('unchanged')
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

  it('classifies as noise a change below the Delta % threshold', () => {
    const noise = { ...NO_NOISE, pct: 5 }
    expect(row(100, 104, { noise })).toMatchObject({
      status: 'noise',
      noise: [{ knob: 'pct', value: 4, threshold: 5 }],
    })
    expect(row(100, 105, { noise }).status).toBe('regressed')
  })

  it('classifies as noise a change whose p-value is above the threshold, unless skipped', () => {
    const noise = { ...NO_NOISE, pval: 0.05 }
    expect(row(1, 2, { noise, pValue: 0.2 })).toMatchObject({
      status: 'noise',
      noise: [{ knob: 'pval', value: 0.2, threshold: 0.05 }],
    })
    expect(row(1, 2, { noise, pValue: 0.01 }).status).toBe('regressed')
    expect(row(1, 2, { noise, pValue: 0.05 }).status).toBe('regressed')
    expect(row(1, 2, { noise, pValue: null }).status).toBe('regressed')
    // A deterministic change.
    expect(row(1, 2, { noise, pValue: 0 }).status).toBe('regressed')
  })

  it('classifies as noise values both below the absolute floor', () => {
    const noise = { ...NO_NOISE, floor: 3 }
    expect(row(-1, 2, { noise })).toMatchObject({
      status: 'noise',
      noise: [{ knob: 'floor', value: 2, threshold: 3 }],
    })
    expect(row(1, -3, { noise }).status).toBe('improved')
  })

  it('lists every knob that triggers', () => {
    const noise = { pct: 50, pval: 0.05, floor: 10 }
    expect(row(2, 2.5, { noise, pValue: 0.5 }).noise.map((reason) => reason.knob)).toEqual([
      'pct',
      'pval',
      'floor',
    ])
  })

  it('calls identical values noise when a knob triggers for them, and unchanged otherwise', () => {
    expect(row(3, 3, { noise: { ...NO_NOISE, pct: 1 } }).status).toBe('noise')
    expect(row(3, 3, { noise: { ...NO_NOISE, pct: 0 } }).status).toBe('unchanged')
  })

  it('evaluates no knob for a test with a zero baseline, or a side without a value', () => {
    const noise = { pct: 50, pval: 0.05, floor: 10 }
    expect(row(0, 1, { noise, pValue: 0.5 })).toMatchObject({ status: 'na', noise: [] })
    expect(row(null, 1, { noise, pValue: 0.5 })).toMatchObject({ status: 'na', noise: [] })
  })

  it('keeps the p-value of a test with a zero baseline, for its column', () => {
    expect(row(0, 1, { pValue: 0.5 }).pValue).toBe(0.5)
  })
})

describe('geomeanRow', () => {
  it('takes the geometric means of the absolute values, and their ratio', () => {
    const geomean = geomeanRow([valued(1, 2), valued(-4, -2)], false)
    expect(geomean.a).toBeCloseTo(2)
    expect(geomean.b).toBeCloseTo(2)
    expect(geomean.ratio).toBeCloseTo(1)
    expect(geomean.delta).toBeCloseTo(0)
  })

  it('leaves out rows with a side without a value, or a zero on either side', () => {
    const geomean = geomeanRow(
      [valued(2, 8), valued(null, 3), valued(0, 3), valued(3, 0), valued(5, null)],
      true,
    )
    expect(geomean.a).toBeCloseTo(2)
    expect(geomean.b).toBeCloseTo(8)
    expect(geomean.delta).toBeCloseTo(6)
    expect(geomean.deltaPct).toBeCloseTo(300)
    expect(geomean.ratio).toBeCloseTo(4)
    expect(geomean.status).toBe('improved')
  })

  it('classifies its own Delta, never as noise', () => {
    expect(geomeanRow([valued(2, 8, 'noise')], false).status).toBe('regressed')
  })

  it('is N/A with no row to take', () => {
    expect(geomeanRow([valued(0, 1)], false)).toEqual(valued(null, null))
  })
})

describe('summaryCounts', () => {
  it('counts each row once, in its status or by the side it has a value on', () => {
    const counts = summaryCounts([
      valued(1, 2, 'regressed'),
      valued(2, 1, 'improved'),
      valued(2, 1, 'improved'),
      valued(1, 1, 'unchanged'),
      valued(1, 1.01, 'noise'),
      valued(1, null),
      valued(null, 1),
      valued(null, 1),
      valued(0, 1),
    ])
    expect(counts).toEqual({
      improved: 2,
      regressed: 1,
      noise: 1,
      unchanged: 1,
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

describe('formatShare', () => {
  it('gives one decimal place, and none for a whole number', () => {
    expect(formatShare(1, 3)).toBe('33.3%')
    expect(formatShare(1, 4)).toBe('25%')
    expect(formatShare(2, 2)).toBe('100%')
  })
})
