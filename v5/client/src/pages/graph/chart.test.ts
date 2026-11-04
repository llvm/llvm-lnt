import type { PlotData } from 'plotly.js'
import { describe, expect, it } from 'vitest'
import { markerOf } from '../../chart-markers'
import { metric } from '../../test/fixtures'
import { hoverText } from '../../test/hover-text'
import {
  baselineTraces,
  circlesAt,
  commitsInView,
  graphLayout,
  highlightCircles,
  highlightShape,
  MARKED_COMMITS,
  panelAxes,
  panelTitle,
  plotlyTrace,
  regressionMarkers,
  regressionShapes,
  traceMode,
  withEmphasis,
  type RegressionMark,
  type Trace,
} from './chart'

const display = (commit: string) => `<${commit}>`

/** Execution Time, in seconds, as a panel shows it. */
const SECONDS = metric('execution_time', { unit: 'seconds', unit_abbrev: 's' })

/** A panel of the layout, with nothing to say. */
const panel = (name: string | undefined, title: string | null = null) => ({
  metric: name,
  title,
  empty: false,
})

describe('graphLayout', () => {
  it('spans every commit of the x-axis, labelled by its display value, escaped', () => {
    const commits = ['c1', 'c2']
    const layout = graphLayout({
      commits,
      displayValue: display,
      revision: 'm1',
      panels: [panel('execution_time')],
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
    expect(layout.yaxis).toMatchObject({ domain: [0, 1] })
    expect(layout.yaxis).not.toHaveProperty('title')
    expect(layout.xaxis).toMatchObject({ anchor: 'y' })
    expect(layout.annotations).toEqual([])
  })

  it('leaves the range to Plotly without commits, and says there is nothing to plot', () => {
    const layout = graphLayout({
      commits: [],
      displayValue: display,
      revision: '',
      panels: [{ metric: undefined, title: null, empty: true }],
    })

    expect(layout.xaxis).not.toHaveProperty('range')
    expect(layout.annotations).toMatchObject([{ text: 'No data to plot', y: 0.5 }])
  })

  it('stacks a panel per metric, each with a y-axis of its own, sharing the x-axis', () => {
    const layout = graphLayout({
      commits: ['c1'],
      displayValue: display,
      revision: 'm1',
      panels: [
        panel('execution_time', 'Execution <Time>'),
        { metric: 'compile_time', title: 'Compile Time', empty: true },
      ],
    }) as Record<string, Record<string, unknown>>

    expect(panelAxes(0)).toEqual({ values: 'y', markers: 'y2' })
    expect(panelAxes(1)).toEqual({ values: 'y3', markers: 'y4' })
    const [top, bottom] = [layout.yaxis.domain, layout.yaxis3.domain] as number[][]
    expect(top[1]).toBe(1)
    expect(bottom[0]).toBe(0)
    // As tall as one another, a gap between them.
    expect(top[1] - top[0]).toBeCloseTo(bottom[1] - bottom[0])
    expect(top[0]).toBeGreaterThan(bottom[1])
    expect(layout.yaxis).toMatchObject({ title: { text: 'Execution &lt;Time&gt;' } })
    expect(layout.yaxis3).toMatchObject({ title: { text: 'Compile Time' } })
    // A zoom of a panel's y-axis is reset by another metric at its place.
    expect(layout.yaxis3.uirevision).toBe('m1\0compile_time')
    // Each panel's markers' axis over its values'.
    expect(layout.yaxis4).toMatchObject({ overlaying: 'y3', range: [0, 1], visible: false })
    // The commits' labels under the bottom panel.
    expect(layout.xaxis).toMatchObject({ anchor: 'y3' })
    // Only the empty panel says so, in its middle.
    expect(layout.annotations).toMatchObject([{ text: 'No data to plot' }])
    const [said] = layout.annotations as unknown as { y: number }[]
    expect(said.y).toBeCloseTo((bottom[0] + bottom[1]) / 2)
  })

  it("titles a panel with its metric's label and unit", () => {
    expect(panelTitle(metric('execution_time', { display_name: 'Execution Time' }))).toBe(
      'Execution Time',
    )
    expect(panelTitle({ ...SECONDS, display_name: 'Execution Time' })).toBe(
      'Execution Time — seconds (s)',
    )
  })
})

describe('plotlyTrace', () => {
  const trace: Trace = {
    metric: SECONDS,
    panel: 0,
    test: 'BM_vector<int>',
    machine: 'm1',
    machineLabel: 'm&1',
    machineIndex: 1,
    color: '#123456',
    points: [
      { commit: 'c1', position: 0, value: 1.234567891, runs: 1 },
      { commit: 'c2', position: 1, value: 2, runs: 3 },
    ],
  }

  it("draws a line, with its machine's markers, named after the test and machine, escaped", () => {
    const drawn = plotlyTrace(trace, display)

    expect(drawn).toMatchObject({
      name: 'BM_vector&lt;int&gt; - m&amp;1',
      x: ['c1', 'c2'],
      y: [1.234567891, 2],
      marker: { color: '#123456', symbol: markerOf(1).symbol },
    })
  })

  it("tells in its tooltip the commit's display value, the value as shown, and the runs", () => {
    const drawn = plotlyTrace(trace, display)

    expect(hoverText(drawn, 0)).toBe(
      '<b>BM_vector&lt;int&gt;</b><br>Machine: m&amp;1<br>Commit: &lt;c1&gt;<br>' +
        // GR10: labelled with the metric, with its unit's abbreviation.
        'execution_time: 1.235 s (1 run)<br>' +
        // GR10: the last line says what a click does.
        '<i>Click for details</i><extra></extra>',
    )
    expect(hoverText(drawn, 1)).toContain('Commit: &lt;c2&gt;<br>execution_time: 2 s (3 runs)<br>')
  })

  it('labels the value with the metric, and its unit when it has no abbreviation', () => {
    const counted = { ...trace, metric: metric('instructions', { unit: 'instructions' }) }
    expect(hoverText(plotlyTrace(counted, display), 1)).toContain(
      '<br>instructions: 2 instructions (3 runs)<br>',
    )
    const bare = { ...trace, metric: metric('score', { display_name: 'S<core>' }) }
    expect(hoverText(plotlyTrace(bare, display), 1)).toContain('<br>S&lt;core&gt;: 2 (3 runs)<br>')
  })

  it('shows the test and the display value as they are, even with template fields in them', () => {
    const named = { ...trace, test: 'fmt/%{x}', machineLabel: '<&>' }
    const drawn = plotlyTrace(named, (c) => `${c} %{y}`)

    expect(hoverText(drawn, 0)).toContain(
      '<b>fmt/%{x}</b><br>Machine: &lt;&amp;&gt;<br>Commit: c1 %{y}<br>',
    )
  })
})

describe('markers (GR1)', () => {
  it('draws a line alone without markers, but keeps the marker of a single point', () => {
    expect(traceMode(2, true)).toBe('lines+markers')
    expect(traceMode(2, false)).toBe('lines')
    expect(traceMode(1, false)).toBe('lines+markers')
  })

  it('counts the commits of the x-axis between the edges of the plot', () => {
    // Commit i at 100 + 10 * i pixels, in a plot from 100 to 300 pixels.
    const geometry = {
      area: { left: 100, top: 0, width: 200, height: 100 },
      x: (value: number) => 100 + 10 * value,
      y: (value: number) => value,
      yAxes: new Map(),
    }
    expect(commitsInView(geometry, 50)).toBe(21)
    // Fewer commits than room for them.
    expect(commitsInView(geometry, 5)).toBe(5)
    // Zoomed in between commits 4.5 and 6.5, then panned past the last commit.
    expect(commitsInView({ ...geometry, x: (value) => 100 + 100 * (value - 4.5) }, 50)).toBe(2)
    expect(commitsInView({ ...geometry, x: (value) => 100 + 10 * (value - 48) }, 50)).toBe(2)
  })

  it('counts them right far from the first commit, though Plotly rounds pixels', () => {
    // Positions 325.95 to 526.25 of 600 in view, in a plot 1014 pixels wide, each position placed
    // to a hundredth of a pixel, as Plotly does: 326 to 526 are in view.
    const [from, to] = [325.9483905287492, 526.2466917324643]
    const pixels = 1014 / (to - from)
    const geometry = {
      area: { left: 70, top: 0, width: 1014, height: 100 },
      x: (value: number) => 70 + Math.round(pixels * (value - from) * 100) / 100,
      y: (value: number) => value,
      yAxes: new Map(),
    }
    expect(commitsInView(geometry, 600)).toBe(201)
  })

  it('leaves Plotly room to draw the marker of every point in view', () => {
    const { marker } = plotlyTrace(
      {
        metric: SECONDS,
        panel: 0,
        test: 't',
        machine: 'm',
        machineLabel: 'm',
        machineIndex: 0,
        color: '#123456',
        points: [],
      },
      display,
    )
    // One more than are marked in view, which a count one off at an edge may still mark.
    expect((marker as { maxdisplayed: number }).maxdisplayed).toBeGreaterThan(MARKED_COMMITS + 1)
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
      metric: SECONDS,
      panel: 1,
      label: 'nts › m › r10',
      suiteLabel: 'nts',
      machineLabel: 'm<1>',
      commit: 'r10',
      test: 't',
      value: 1.5,
      color: '#123456',
    }
    const [drawn] = baselineTraces([line]) as PlotData[]

    expect(drawn).toMatchObject({ mode: 'lines', xaxis: 'x2', yaxis: 'y3', line: { dash: 'dash' } })
    expect(drawn.x).toHaveLength(101)
    expect((drawn.x as number[]).at(-1)).toBe(1)
    expect(new Set(drawn.y as number[])).toEqual(new Set([1.5]))
    expect(hoverText(drawn, 0)).toBe(
      '<b>Baseline</b><br>Suite: nts<br>Machine: m&lt;1&gt;<br>Commit: r10<br>Test: t<br>' +
        'execution_time: 1.5 s<extra></extra>',
    )
    expect(hoverText(drawn, 100)).toBe(hoverText(drawn, 0))
  })

  it("shows the test and the commit's display value as they are, even with template fields", () => {
    const line = {
      metric: SECONDS,
      panel: 0,
      label: 'nts › <&> › r10 %{x}',
      suiteLabel: 'nts',
      machineLabel: '<&>',
      // The commit's display value, which unlike a commit string may contain a `%` (I1).
      commit: 'r10 %{x}',
      test: 'fmt/%{y}',
      value: 1.5,
      color: '#123456',
    }
    const [drawn] = baselineTraces([line])

    expect(hoverText(drawn, 50)).toContain(
      'Machine: &lt;&amp;&gt;<br>Commit: r10 %{x}<br>Test: fmt/%{y}<br>',
    )
    expect((drawn as PlotData).name).toBe('fmt/%{y} - baseline nts › &lt;&amp;&gt; › r10 %{x}')
  })
})

describe('the regression annotations (GR15)', () => {
  const mark = (overrides: Partial<RegressionMark>): RegressionMark => ({
    metric: 'execution_time',
    panel: 0,
    uuid: 'u1',
    title: 'Slower',
    state: 'active',
    commit: 'c1',
    tests: ['a'],
    stack: 0,
    ...overrides,
  })

  it('draws a dashed line across its panel at each commit, coloured by state', () => {
    const marks = [mark({}), mark({ state: 'detected' }), mark({ state: 'fixed', panel: 1 })]
    const shapes = regressionShapes(marks)

    expect(shapes[2]).toMatchObject({ yref: 'y3 domain' })
    expect(shapes[0]).toMatchObject({
      xref: 'x',
      yref: 'y domain',
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
    expect(regressionMarkers([mark({ panel: 1 })])[0]).toMatchObject({ yaxis: 'y4' })
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
      panels: [panel(undefined)],
      shapes: regressionShapes([mark({})]),
    })

    expect(layout.shapes).toHaveLength(1)
    expect(layout.xaxis2).toMatchObject({ overlaying: 'x', range: [0, 1], fixedrange: true })
    expect(layout.yaxis2).toMatchObject({ overlaying: 'y', range: [0, 1], visible: false })
  })
})

describe('the highlighted commits (GR16)', () => {
  const traceOf = (test: string, commits: string[]): Trace => ({
    metric: SECONDS,
    panel: test === 'c' ? 1 : 0,
    test,
    machine: 'm1',
    machineLabel: 'm1',
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

  it('circles the points of each trace that has any at the commits', () => {
    const a = traceOf('a', ['c1', 'c2', 'c3'])
    const b = traceOf('b', ['c1'])
    const c = traceOf('c', ['c2', 'c4'])

    const circles = circlesAt([a, b, c], ['c2', 'c3'])
    expect(circles.map(({ trace, points }) => [trace.test, points.map((p) => p.value)])).toEqual([
      ['a', [1, 2]],
      ['c', [0]],
    ])
    expect(circlesAt([a, b, c], ['c9'])).toEqual([])

    const [drawn, other] = highlightCircles(circles) as PlotData[]
    // In the panel of each trace.
    expect(other).toMatchObject({ yaxis: 'y3' })
    expect(drawn).toMatchObject({
      mode: 'markers',
      yaxis: 'y',
      x: ['c2', 'c3'],
      y: [1, 2],
      // Neither hovered nor clicked: the point under it keeps its own tooltip and details.
      hoverinfo: 'skip',
      // Whole at either end of the x-axis.
      cliponaxis: false,
      marker: { color: '#aaaaaa', symbol: 'circle-open', line: { width: 2 } },
    })
  })
})
