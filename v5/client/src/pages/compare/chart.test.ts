import { describe, expect, it } from 'vitest'
import {
  barTrace,
  chartBars,
  chartExtent,
  compareLayout,
  noiseBand,
  ratioTicks,
  SHADOW_COLORS,
  shadowTrace,
  type Bar,
} from './chart'
import { statisticsOf, type ComparisonRow, type Status } from './comparison'

/** A compared row of `test`, valued `a` and `b`, with the ratio and Delta % they give. */
function row(test: string, a: number | null, b: number | null, status: Status = 'regressed') {
  const statistics = { ...statisticsOf([]), runs: 0 }
  const ratio = a !== null && b !== null && a !== 0 ? b / a : null
  return {
    test,
    a,
    b,
    delta: a !== null && b !== null ? b - a : null,
    deltaPct: ratio === null ? null : ((b! - a!) / Math.abs(a!)) * 100,
    ratio,
    status,
    noise: [],
    statisticsA: statistics,
    statisticsB: statistics,
    pValue: null,
  } satisfies ComparisonRow
}

describe('chartBars', () => {
  it('keeps the rows with a positive ratio, by ratio, ties by name', () => {
    const bars = chartBars([
      row('d', 1, 3),
      row('b', 2, 1),
      row('c', 1, 2),
      row('a', 2, 4),
      row('one-sided', 1, null),
      row('zero', 0, 1),
      row('opposite', -1, 1),
    ])
    expect(bars.map((bar) => bar.test)).toEqual(['b', 'a', 'c', 'd'])
  })
})

describe('noiseBand', () => {
  it('is the log2 ratios of the threshold above and below', () => {
    expect(noiseBand(5)).toEqual({ upper: Math.log2(1.05), lower: Math.log2(0.95) })
  })

  it('is made symmetric from 100% on', () => {
    expect(noiseBand(150)).toEqual({ upper: Math.log2(2.5), lower: -Math.log2(2.5) })
  })
})

describe('ratioTicks', () => {
  it('labels a narrow range with fine percentage changes, 0% included', () => {
    const { tickvals, ticktext } = ratioTicks(Math.log2(0.97), Math.log2(1.03))
    expect(ticktext).toEqual(['-2%', '-1%', '0%', '+1%', '+2%'])
    expect(tickvals[2]).toBe(0)
    expect(tickvals[3]).toBeCloseTo(Math.log2(1.01))
  })

  it('labels a wide range with coarse ones, at most ten of them', () => {
    const { ticktext } = ratioTicks(Math.log2(0.1), Math.log2(10))
    expect(ticktext).toContain('0%')
    expect(ticktext).toContain('+100%')
    expect(ticktext).not.toContain('+1%')
    expect(ticktext.length).toBeLessThanOrEqual(10)
  })

  it('labels 0% alone when the range is 0% alone', () => {
    expect(ratioTicks(0, 0)).toEqual({ tickvals: [0], ticktext: ['0%'] })
  })

  it('labels a range away from 0% within it', () => {
    for (const [from, to] of [
      [2, 5],
      [21, 49],
      [100, 200],
    ]) {
      const [min, max] = [Math.log2(1 + from / 100), Math.log2(1 + to / 100)]
      const { tickvals, ticktext } = ratioTicks(min, max)
      expect(tickvals.length).toBeGreaterThanOrEqual(2)
      expect(tickvals.every((at) => at >= min - 0.02 * (max - min))).toBe(true)
      expect(ticktext).not.toContain('0%')
    }
  })

  it('labels extreme ratios too', () => {
    expect(ratioTicks(Math.log2(1e-4), 0).ticktext).toContain('-99.99%')
    expect(ratioTicks(0, Math.log2(2000)).ticktext.at(-1)).toMatch(/^\+\d+%$/)
  })
})

describe('chartExtent', () => {
  it('spans the bars from 0, and the noise band', () => {
    const bars = chartBars([row('a', 1, 2), row('b', 1, 1.5)])
    expect(chartExtent(bars, null)).toEqual([0, 1])
    expect(chartExtent(bars, noiseBand(10))).toEqual([Math.log2(0.9), 1])
  })

  it("spans the shadow's points too", () => {
    const bars = chartBars([row('a', 1, 2)])
    expect(chartExtent(bars, null, chartBars([row('a', 1, 4), row('b', 2, 1)]))).toEqual([-1, 2])
  })

  it("spans multiple shadows' points too", () => {
    const bars = chartBars([row('a', 1, 2)])
    const s1 = chartBars([row('a', 1, 4)])
    const s2 = chartBars([row('b', 4, 1)])
    expect(chartExtent(bars, null, [s1, s2])).toEqual([-2, 2])
  })
})

describe('barTrace', () => {
  const bars: Bar[] = chartBars([
    row('<b>', 2, 1, 'improved'),
    row('slow', 1, 2, 'regressed'),
    row('same', 1, 1.001, 'noise'),
  ])

  it('draws a bar per test at its log2 ratio, coloured by status', () => {
    const trace = barTrace(bars)
    expect(trace.x).toEqual([0, 1, 2])
    expect(trace.y).toEqual([-1, Math.log2(1.001), 1])
    expect((trace.marker as { color: string[] }).color).toEqual(['#15803d', '#9ca3af', '#b91c1c'])
  })

  it('gives each bar its test, ratio, values and Delta %, the test escaped', () => {
    expect((barTrace(bars).customdata as unknown as string[][])[0]).toEqual([
      '&lt;b&gt;',
      '0.5000',
      '2',
      '1',
      '-50.00%',
    ])
  })
})

describe('shadowTrace', () => {
  it('draws a line through the points, with the tooltip of a bar labelled as the shadow', () => {
    const trace = shadowTrace(chartBars([row('a', 1, 2), row('b', 2, 1)]))
    expect(trace).toMatchObject({ type: 'scatter', mode: 'lines+markers', x: [0, 1], y: [-1, 1] })
    expect(trace.hovertemplate).toMatch(/^<b>%\{customdata\[0\]\}<\/b> \(shadow\)<br>Ratio/)
  })

  it('draws a line using a custom color from the shadows palette', () => {
    const trace = shadowTrace(chartBars([row('a', 1, 2)]), SHADOW_COLORS[1])
    expect(trace.line).toMatchObject({ color: SHADOW_COLORS[1] })
    expect(trace.marker).toMatchObject({ color: SHADOW_COLORS[1] })
  })
})

describe('compareLayout', () => {
  it('draws the noise band, and says when there is nothing to plot', () => {
    const ticks = ratioTicks(-1, 1)
    const band = noiseBand(5)
    const layout = compareLayout({ ticks, band, revision: 'r', empty: true })
    expect(layout.shapes?.map((shape) => shape.y0)).toEqual([band.upper, band.lower])
    expect(layout.annotations?.[0].text).toBe('No data to plot')
    expect(layout.uirevision).toBe('r')
  })
})
