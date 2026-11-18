import { describe, expect, it } from 'vitest'
import { hoverText } from '../../test/hover-text'
import {
  barTrace,
  chartBars,
  chartExtent,
  compareLayout,
  ratioTicks,
  SHADOW_COLORS,
  shadowTrace,
} from './chart'
import { statisticsOf, type Change, type ComparisonRow, type Status } from './comparison'
import { MAX_SHADOWS } from './shadow-specs'

/** A change with only one run on side A. */
const ONE_RUN: Change = { kind: 'runs', sides: 'A' }

/** A change whose 90% confidence interval of the ratio is `[low, high]`. */
function within(low: number, high: number): Change {
  const [l, h] = [Math.log(low), Math.log(high)]
  return { kind: 'interval', confidence: 90, estimate: (l + h) / 2, low: l, high: h, pValue: 0 }
}

/** A compared row of `test`, valued `a` and `b`, with the ratio and Delta % they give. */
function row(
  test: string,
  a: number | null,
  b: number | null,
  status: Status = 'inconclusive',
  change: Change = ONE_RUN,
) {
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
    change,
    statisticsA: statistics,
    statisticsB: statistics,
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
  it('spans the bars from 0', () => {
    expect(chartExtent(chartBars([row('a', 1, 2), row('b', 1, 1.5)]))).toEqual([0, 1])
    expect(chartExtent(chartBars([row('a', 2, 1)]))).toEqual([-1, 0])
  })

  it("spans every shadow's points too", () => {
    const bars = chartBars([row('a', 1, 2)])
    const shadows = [chartBars([row('a', 1, 4)]), chartBars([row('b', 2, 1)])]
    expect(chartExtent(bars, shadows)).toEqual([-1, 2])
  })
})

describe('barTrace', () => {
  const bars = chartBars([
    row('<b>', 2, 1, 'improved', within(0.4, 0.6)),
    row('slow', 1, 2, 'regressed', within(1.8, 2.2)),
    row('same', 1, 1.001),
    row('flat', 1, 1.0001, 'unchanged', {
      kind: 'interval',
      confidence: 95,
      estimate: 0,
      low: Math.log(0.99),
      high: Math.log(1.02),
      pValue: 1,
    }),
  ])

  it('draws a bar per test at its log2 ratio, coloured by status', () => {
    const trace = barTrace(bars)
    expect(trace.x).toEqual([0, 1, 2, 3])
    expect(trace.y).toEqual([-1, Math.log2(1.0001), Math.log2(1.001), 1])
    expect((trace.marker as { color: string[] }).color).toEqual([
      '#15803d',
      '#9ca3af',
      '#d97706',
      '#b91c1c',
    ])
  })

  it('gives each bar its test, ratio, values, Delta % and status, the test escaped', () => {
    expect((barTrace(bars).customdata as unknown as string[][])[0]).toEqual([
      '&lt;b&gt;',
      '0.5000',
      '2',
      '1',
      '-50.00%',
      '',
      '<br>Status: Improved<br>90% CI: -51.01% [-60.00%, -40.00%], beyond the margin' +
        '<br><i>Click for details</i>',
    ])
  })

  it("says what a bar's status says of its change, and last that it has details (CP3)", () => {
    expect(hoverText(barTrace(bars), 1)).toBe(
      '<b>flat</b><br>Ratio: 1.0001<br>A: 1<br>B: 1<br>Delta %: +0.01%<br>' +
        'Status: Unchanged<br>95% CI: 0.00% [-1.00%, +2.00%], within the margin<br>' +
        '<i>Click for details</i><extra></extra>',
    )
  })
})

describe('shadowTrace', () => {
  const points = chartBars([row('a', 1, 2), row('b', 2, 1)])

  it('draws a line through the points, with the tooltip of a bar naming the shadow', () => {
    const trace = shadowTrace(points, 0, 'Shadow: s › m › c')
    expect(trace).toMatchObject({ type: 'scatter', mode: 'lines+markers', x: [0, 1], y: [-1, 1] })
    expect(hoverText(trace, 0)).toBe(
      '<b>b</b><br>Shadow: s › m › c<br>Ratio: 0.5000<br>A: 2<br>B: 1<br>Delta %: -50.00%' +
        '<extra></extra>',
    )
    // A point of a shadow has no details, and says nothing of a status or a change (CP8).
    expect(hoverText(trace, 0)).not.toMatch(/Click|Status|CI/)
  })

  it('escapes the label, and keeps it out of the template', () => {
    const trace = shadowTrace(points, 0, 'Shadow: s › <m&> › %{x}')
    expect((trace.customdata as unknown as string[][])[1][5]).toBe(
      '<br>Shadow: s › &lt;m&amp;&gt; › %{x}',
    )
    expect(trace.hovertemplate).not.toContain('%{x}')
  })

  it('gives each of the shadows a colour and a marker of its own, apart from the statuses', () => {
    const looks = SHADOW_COLORS.map((_, i) => {
      const { marker, line } = shadowTrace(points, i, '')
      expect(line?.color).toBe((marker as { color: string }).color)
      return marker as { color: string; symbol: string }
    })
    expect(new Set(looks.map((look) => look.color)).size).toBe(MAX_SHADOWS)
    expect(new Set(looks.map((look) => look.symbol)).size).toBe(MAX_SHADOWS)
    const everyStatus = [
      row('i', 2, 1, 'improved', within(0.4, 0.6)),
      row('r', 1, 2, 'regressed', within(1.8, 2.2)),
      row('u', 1, 1, 'unchanged', within(0.99, 1.01)),
      row('n', 1, 1),
    ]
    const statuses = (barTrace(chartBars(everyStatus)).marker as { color: string[] }).color
    expect(looks.some((look) => statuses.includes(look.color))).toBe(false)
  })
})

describe('compareLayout', () => {
  it('draws no band, and says when there is nothing to plot', () => {
    const layout = compareLayout({ ticks: ratioTicks(-1, 1), revision: 'r', empty: true })
    expect(layout.shapes).toBeUndefined()
    expect(layout.annotations?.[0].text).toBe('No data to plot')
    expect(layout.uirevision).toBe('r')
  })
})
