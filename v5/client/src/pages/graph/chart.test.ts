import type { PlotData } from 'plotly.js'
import { describe, expect, it } from 'vitest'
import { markerOf } from '../../chart-markers'
import { metric } from '../../test/fixtures'
import { hoverText } from '../../test/hover-text'
import {
  baselineTraces,
  circlesAt,
  graphLayout,
  highlightCircles,
  highlightShape,
  plotlyTraces,
  regressionMarkers,
  regressionShapes,
  withEmphasis,
  type RegressionMark,
  type Trace,
} from './chart'

const display = (commit: string) => `<${commit}>`

describe('graphLayout', () => {
  it('spans every commit of the x-axis, labelled by its display value, escaped', () => {
    const commits = ['c1', 'c2']
    const layout = graphLayout({
      commits,
      displayValue: display,
      revision: 'm1',
      metric: 'execution_time',
      empty: false,
    })

    expect(layout.xaxis).toMatchObject({
      type: 'category',
      categoryorder: 'array',
      categoryarray: ['c1', 'c2'],
      labelalias: { c1: '&lt;c1&gt;', c2: '&lt;c2&gt;' },
      range: [-0.5, 1.5],
      autorange: false,
    })
    expect(layout.uirevision).toBe('m1')
    // A zoom of the y-axis is reset by another metric, on another scale, too.
    expect(layout.yaxis?.uirevision).toBe('m1\0execution_time')
    expect(layout.annotations).toEqual([])
  })

  it('leaves the range to Plotly without commits, and says there is nothing to plot', () => {
    const layout = graphLayout({
      commits: [],
      displayValue: display,
      revision: '',
      metric: undefined,
      empty: true,
    })

    expect(layout.xaxis).not.toHaveProperty('range')
    expect(layout.annotations).toMatchObject([{ text: 'No data to plot' }])
  })
})

describe('plotlyTraces', () => {
  const trace: Trace = {
    test: 'BM_vector<int>',
    machine: 'm&1',
    machineIndex: 1,
    color: '#123456',
    points: [
      { commit: 'c1', position: 0, value: 1.234567891, runs: 1 },
      { commit: 'c2', position: 1, value: 2, runs: 3 },
    ],
  }

  it('draws a line with markers, named after the test and the machine, escaped', () => {
    const [drawn] = plotlyTraces([trace], display, metric('execution_time')) as PlotData[]

    expect(drawn).toMatchObject({
      mode: 'lines+markers',
      name: 'BM_vector&lt;int&gt; - m&amp;1',
      x: ['c1', 'c2'],
      y: [1.234567891, 2],
      marker: { color: '#123456', symbol: markerOf(1).symbol },
    })
  })

  it("tells in its tooltip the commit's display value, the value as shown, and the runs", () => {
    const [drawn] = plotlyTraces([trace], display, metric('execution_time')) as PlotData[]

    expect(hoverText(drawn, 0)).toBe(
      '<b>BM_vector&lt;int&gt;</b><br>Machine: m&amp;1<br>Commit: &lt;c1&gt;<br>Value: 1.235<br>' +
        // GR10: the last line says what a click does.
        '1 run<br><i>Click for details</i><extra></extra>',
    )
    expect(hoverText(drawn, 1)).toContain('Commit: &lt;c2&gt;<br>Value: 2<br>3 runs<br>')
  })

  it('shows the test and the display value as they are, even with template fields in them', () => {
    const named = { ...trace, test: 'fmt/%{x}', machine: '<&>' }
    const [drawn] = plotlyTraces([named], (c) => `${c} %{y}`, metric('execution_time'))

    expect(hoverText(drawn, 0)).toContain(
      '<b>fmt/%{x}</b><br>Machine: &lt;&amp;&gt;<br>Commit: c1 %{y}<br>',
    )
  })
})

describe('withEmphasis (GR7)', () => {
  const trace = { name: 't', x: [1], y: [2], line: { color: '#123456', width: 1.5 } }

  it('widens the line of a test emphasized, and fades the others, sharing their points', () => {
    const emphasized = withEmphasis(trace, true)
    expect(emphasized.line).toEqual({ color: '#123456', width: 3 })
    expect(emphasized.x).toBe(trace.x)

    const faded = withEmphasis(trace, false)
    expect(faded.opacity).toBe(0.2)
    expect(faded.y).toBe(trace.y)
  })
})

describe('baselineTraces (GR9)', () => {
  it('draws a dashed line across the chart, on an axis of its own, with a tooltip', () => {
    const line = {
      suite: 'nts',
      machine: 'm<1>',
      commit: 'r10',
      test: 't',
      value: 1.5,
      color: '#123456',
    }
    const [drawn] = baselineTraces([line], metric('execution_time')) as PlotData[]

    expect(drawn).toMatchObject({ mode: 'lines', xaxis: 'x2', line: { dash: 'dash' } })
    expect(drawn.x).toHaveLength(101)
    expect((drawn.x as number[]).at(-1)).toBe(1)
    expect(new Set(drawn.y as number[])).toEqual(new Set([1.5]))
    expect(hoverText(drawn, 0)).toBe(
      '<b>Baseline</b><br>Suite: nts<br>Machine: m&lt;1&gt;<br>Commit: r10<br>Test: t<br>' +
        'Value: 1.5<extra></extra>',
    )
    expect(hoverText(drawn, 100)).toBe(hoverText(drawn, 0))
  })

  it("shows the test and the commit's display value as they are, even with template fields", () => {
    const line = {
      suite: 'nts',
      machine: '<&>',
      // The commit's display value, which unlike a commit string may contain a `%` (I1).
      commit: 'r10 %{x}',
      test: 'fmt/%{y}',
      value: 1.5,
      color: '#123456',
    }
    const [drawn] = baselineTraces([line], metric('execution_time'))

    expect(hoverText(drawn, 50)).toContain(
      'Machine: &lt;&amp;&gt;<br>Commit: r10 %{x}<br>Test: fmt/%{y}<br>',
    )
  })
})

describe('the regression annotations (GR15)', () => {
  const mark = (overrides: Partial<RegressionMark>): RegressionMark => ({
    uuid: 'u1',
    title: 'Slower',
    state: 'active',
    commit: 'c1',
    tests: ['a'],
    stack: 0,
    ...overrides,
  })

  it('draws a dashed line across the plot at each commit, coloured by state', () => {
    const marks = [mark({}), mark({ state: 'detected' }), mark({ state: 'fixed' })]
    const shapes = regressionShapes(marks)

    expect(shapes[0]).toMatchObject({
      xref: 'x',
      yref: 'paper',
      x0: 'c1',
      x1: 'c1',
      y0: 0,
      y1: 1,
      line: { dash: 'dash', color: '#dc2626' },
    })
    expect(shapes.map((shape) => shape.line?.color)).toEqual(['#dc2626', '#ca8a04', '#6b7280'])
  })

  it('puts a marker at the top of each line, stacked, naming the tests it affects', () => {
    const tests = Array.from({ length: 12 }, (_, i) => `t<${i}>`)
    const [first, second] = regressionMarkers([
      mark({ title: null, tests }),
      mark({ uuid: 'u2', stack: 1 }),
    ]) as PlotData[]

    expect(first).toMatchObject({ mode: 'markers', yaxis: 'y2', x: ['c1'] })
    expect((second.y as number[])[0]).toBeLessThan((first.y as number[])[0])
    expect(hoverText(first, 0)).toContain('<b>(untitled)</b><br>Affects:<br>t&lt;0&gt;<br>')
    expect(hoverText(first, 0)).toContain('t&lt;9&gt;<br>and 2 more<br><i>Click for details</i>')
  })

  it('shows the title and the tests as they are, even with template fields in them', () => {
    const [drawn] = regressionMarkers([
      mark({ title: '50%{y} <slower>', tests: ['fmt/%{x}', 'b'] }),
    ])

    expect(hoverText(drawn, 0)).toBe(
      '<b>50%{y} &lt;slower&gt;</b><br>Affects:<br>fmt/%{x}<br>b<br>' +
        '<i>Click for details</i><extra></extra>',
    )
  })

  it('draws the lines over axes of their own, which span the plot whatever its zoom', () => {
    const layout = graphLayout({
      commits: ['c1'],
      displayValue: display,
      revision: '',
      metric: undefined,
      empty: false,
      shapes: regressionShapes([mark({})]),
    })

    expect(layout.shapes).toHaveLength(1)
    expect(layout.xaxis2).toMatchObject({ overlaying: 'x', range: [0, 1], fixedrange: true })
    expect(layout.yaxis2).toMatchObject({ overlaying: 'y', range: [0, 1], visible: false })
  })
})

describe('the highlighted commit (GR16)', () => {
  const traceOf = (test: string, commits: string[]): Trace => ({
    test,
    machine: 'm1',
    machineIndex: 0,
    color: `#${test.repeat(6)}`,
    points: commits.map((commit, position) => ({ commit, position, value: position, runs: 1 })),
  })

  it('draws a band a few pixels wide at the commit, across the plot, under the traces', () => {
    expect(highlightShape('c2')).toMatchObject({
      type: 'rect',
      xref: 'x',
      xsizemode: 'pixel',
      xanchor: 'c2',
      x0: -6,
      x1: 6,
      yref: 'paper',
      y0: 0,
      y1: 1,
      layer: 'below',
    })
  })

  it('circles the point of each trace that has one at the commit', () => {
    const a = traceOf('a', ['c1', 'c2'])
    const b = traceOf('b', ['c1'])
    const c = traceOf('c', ['c2', 'c3'])

    const circles = circlesAt([a, b, c], 'c2')
    expect(circles.map(({ trace, point }) => [trace.test, point.value])).toEqual([
      ['a', 1],
      ['c', 0],
    ])
    expect(circlesAt([a, b, c], 'c9')).toEqual([])

    const [drawn] = highlightCircles(circles) as PlotData[]
    expect(drawn).toMatchObject({
      mode: 'markers',
      x: ['c2'],
      y: [1],
      // Neither hovered nor clicked: the point under it keeps its own tooltip and details.
      hoverinfo: 'skip',
      // Whole at either end of the x-axis.
      cliponaxis: false,
      marker: { color: '#aaaaaa', symbol: 'circle-open', line: { width: 2 } },
    })
  })
})
