import { describe, expect, it } from 'vitest'
import { MAX_DISPLAYED_MARKERS } from '../../chart-markers'
import { hoverText } from '../../test/hover-text'
import {
  barTrace,
  chartBars,
  chartExtent,
  compareLayout,
  ratioTicks,
  SHADOW_COLORS,
  shadowLook,
  shadowTrace,
} from './chart'
import { comparedRow, interval } from './compare-world'
import { MAX_SHADOWS } from './shadow-specs'

describe('chartBars', () => {
  it('keeps the rows with a positive ratio, by ratio, ties by name', () => {
    const bars = chartBars([
      comparedRow('d', 1, 3),
      comparedRow('b', 2, 1),
      comparedRow('c', 1, 2),
      comparedRow('a', 2, 4),
      comparedRow('one-sided', 1, null),
      comparedRow('zero', 0, 1),
      comparedRow('opposite', -1, 1),
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
    expect(chartExtent(chartBars([comparedRow('a', 1, 2), comparedRow('b', 1, 1.5)]))).toEqual([0, 1])
    expect(chartExtent(chartBars([comparedRow('a', 2, 1)]))).toEqual([-1, 0])
  })

  it("spans every shadow's points too", () => {
    const bars = chartBars([comparedRow('a', 1, 2)])
    const shadows = [chartBars([comparedRow('a', 1, 4)]), chartBars([comparedRow('b', 2, 1)])]
    expect(chartExtent(bars, shadows)).toEqual([-1, 2])
  })
})

describe('barTrace', () => {
  const bars = chartBars([
    comparedRow('<b>', 2, 1, 'improved', interval(0.4, 0.6)),
    comparedRow('slow', 1, 2, 'regressed', interval(1.8, 2.2)),
    comparedRow('same', 1, 1.001),
    comparedRow('flat', 1, 1.0001, 'unchanged', interval(0.99, 1.02, 1)),
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
      '<br>Status: Improved, 90% CI is [-60.00%, -40.00%]<br><i>Click for details</i>',
    ])
  })

  it("gives a bar's status, with its interval or why it has none, then its details (CP3)", () => {
    expect(hoverText(barTrace(bars), 1)).toBe(
      '<b>flat</b><br>Ratio: 1.0001<br>A: 1<br>B: 1<br>Delta %: +0.01%<br>' +
        'Status: Unchanged, 90% CI is [-1.00%, +2.00%]<br>' +
        '<i>Click for details</i><extra></extra>',
    )
    expect(hoverText(barTrace(bars), 2)).toMatch(
      /<br>Status: Inconclusive, only 1 run on side A<br><i>Click for details<\/i>/,
    )
  })
})

describe('shadowTrace', () => {
  const points = chartBars([comparedRow('a', 1, 2), comparedRow('b', 2, 1)])

  it('draws a line through the points, with the tooltip of a bar naming the shadow', () => {
    const trace = shadowTrace(points, 0, 'Shadow: s › m › c', true)
    expect(trace).toMatchObject({ type: 'scatter', mode: 'lines+markers', x: [0, 1], y: [-1, 1] })
    expect(trace.marker).toMatchObject({ maxdisplayed: MAX_DISPLAYED_MARKERS })
    expect(hoverText(trace, 0)).toBe(
      '<b>b</b><br>Shadow: s › m › c<br>Ratio: 0.5000<br>A: 2<br>B: 1<br>Delta %: -50.00%' +
        '<extra></extra>',
    )
    // A point of a shadow has no details, and says nothing of a status or a change (CP8).
    expect(hoverText(trace, 0)).not.toMatch(/Click|Status|CI/)
  })

  it('escapes the label, and keeps it out of the template', () => {
    const trace = shadowTrace(points, 0, 'Shadow: s › <m&> › %{x}', true)
    expect((trace.customdata as unknown as string[][])[1][5]).toBe(
      '<br>Shadow: s › &lt;m&amp;&gt; › %{x}',
    )
    expect(trace.hovertemplate).not.toContain('%{x}')
  })

  it('gives each of the shadows a colour, a marker and a dash of its own, apart from the statuses', () => {
    const looks = SHADOW_COLORS.map((_, i) => {
      const { marker, line } = shadowTrace(points, i, '', true)
      expect(line?.color).toBe((marker as { color: string }).color)
      return { ...(marker as { color: string; symbol: string }), dash: line?.dash }
    })
    expect(new Set(looks.map((look) => look.color)).size).toBe(MAX_SHADOWS)
    expect(new Set(looks.map((look) => look.symbol)).size).toBe(MAX_SHADOWS)
    expect(new Set(looks.map((look) => look.dash)).size).toBe(MAX_SHADOWS)
    expect(looks.map((look) => look.dash)).toEqual(looks.map((_, i) => shadowLook(i).dash))
    const everyStatus = [
      comparedRow('i', 2, 1, 'improved', interval(0.4, 0.6)),
      comparedRow('r', 1, 2, 'regressed', interval(1.8, 2.2)),
      comparedRow('u', 1, 1, 'unchanged', interval(0.99, 1.01)),
      comparedRow('n', 1, 1),
    ]
    const statuses = (barTrace(chartBars(everyStatus)).marker as { color: string[] }).color
    expect(looks.some((look) => statuses.includes(look.color))).toBe(false)
  })
})

describe('compareLayout', () => {
  it('says when there is nothing to plot', () => {
    const layout = compareLayout({ ticks: ratioTicks(-1, 1), revision: 'r', empty: true })
    expect(layout.annotations?.[0].text).toBe('No data to plot')
    expect(layout.uirevision).toBe('r')
  })
})
