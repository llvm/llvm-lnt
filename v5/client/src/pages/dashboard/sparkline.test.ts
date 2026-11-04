import { describe, expect, it } from 'vitest'
import { SUITE, machine, metric, trendPoint } from '../../test/fixtures'
import {
  formatTrendValue,
  machineColor,
  plotlyTraces,
  sparklineDescription,
  sparklineTraces,
} from './sparkline'

const METRIC = SUITE.metrics[0]

/** The machines named `names`, without display names. */
const named = (...names: string[]) => names.map((name) => machine(name))

describe('sparklineTraces', () => {
  it('places points by their position among the commits any machine has data at', () => {
    const traces = sparklineTraces(
      [
        trendPoint('m2', 300, 3),
        trendPoint('m1', 100, 1),
        trendPoint('m1', 300, 1.3),
        trendPoint('m2', 200, 2),
        trendPoint('m1', 7000, 1.7),
      ],
      named('m1', 'm2'),
    )

    const placed = traces.map(({ machine, x, points }) => [machine, x, points.map((p) => p.value)])
    expect(placed).toEqual([
      // Evenly spaced, whatever the gaps between ordinals; m1 has no value at the second commit.
      ['m1', [0, 2, 3], [1, 1.3, 1.7]],
      ['m2', [1, 2], [2, 3]],
    ])
  })

  it('colours a machine by its place among the machines, even after one with no data', () => {
    const points = [trendPoint('m3', 1, 1), trendPoint('m1', 1, 1)]
    const traces = sparklineTraces(points, named('m1', 'm2', 'm3'))

    expect(traces.map((trace) => [trace.machine, trace.color])).toEqual([
      ['m1', machineColor(0)],
      ['m3', machineColor(2)],
    ])
  })

  it('names a line by its machine\'s label, keeping machines with the same label apart', () => {
    const points = [trendPoint('m1', 1, 1), trendPoint('m2', 1, 2)]
    const traces = sparklineTraces(points, [
      machine('m1', { display_name: 'Linux / x86' }),
      machine('m2', { display_name: 'Linux / x86' }),
    ])

    expect(traces.map(({ machine, label, points }) => [machine, label, points.length])).toEqual([
      ['m1', 'Linux / x86', 1],
      ['m2', 'Linux / x86', 1],
    ])
  })

  it('gives a colour of its own to each of the five machines', () => {
    expect(new Set([0, 1, 2, 3, 4].map(machineColor)).size).toBe(5)
  })
})

describe('formatTrendValue', () => {
  it("is written to 4 significant digits, with the unit's abbreviation, or else the unit", () => {
    expect(formatTrendValue(1.23456789, METRIC)).toBe('1.235 s')
    expect(formatTrendValue(42, metric('cycles', { unit: 'cycles' }))).toBe('42 cycles')
    expect(formatTrendValue(42, metric('score'))).toBe('42')
  })
})

describe('plotlyTraces', () => {
  const display = (point: { commit: string }) => `<${point.commit}>`

  it("labels each point with its machine's label, commit and value, escaped", () => {
    const traces = sparklineTraces(
      [trendPoint('m', 1, 1.5), trendPoint('m', 2, 2.5)],
      [machine('m', { display_name: 'a<b' })],
    )

    const [data] = plotlyTraces(traces, display, METRIC)
    expect(data).toMatchObject({
      mode: 'lines',
      name: 'a&lt;b',
      x: [0, 1],
      y: [1.5, 2.5],
      text: [
        '<b>a&lt;b</b><br>&lt;commit-1&gt;<br>1.5 s',
        '<b>a&lt;b</b><br>&lt;commit-2&gt;<br>2.5 s',
      ],
      hovertemplate: '%{text}<extra></extra>',
    })
  })

  it('draws a machine with a single point as a marker', () => {
    const traces = sparklineTraces([trendPoint('m1', 1, 1)], named('m1'))

    expect(plotlyTraces(traces, display, METRIC)[0]).toMatchObject({ mode: 'markers' })
  })
})

describe('sparklineDescription', () => {
  it("gives each machine's latest value and commit", () => {
    const traces = sparklineTraces(
      [trendPoint('m1', 1, 1), trendPoint('m1', 2, 1.25), trendPoint('m2', 1, 3)],
      named('m1', 'm2'),
    )

    expect(sparklineDescription(traces, (point) => point.commit, METRIC)).toBe(
      'Latest values: m1, 1.25 s at commit-2; m2, 3 s at commit-1.',
    )
  })
})
