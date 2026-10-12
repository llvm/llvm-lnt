import type { PlotData } from 'plotly.js'
import { describe, expect, it } from 'vitest'
import { metric } from '../../test/fixtures'
import { graphLayout, markerOf, plotlyTraces, type Trace } from './chart'

const display = (commit: string) => `<${commit}>`

describe('graphLayout', () => {
  it('spans every commit of the x-axis, labelled by its display value, escaped', () => {
    const commits = ['c1', 'c2']
    const layout = graphLayout({ commits, displayValue: display, revision: 'm1', empty: false })

    expect(layout.xaxis).toMatchObject({
      type: 'category',
      categoryorder: 'array',
      categoryarray: ['c1', 'c2'],
      labelalias: { c1: '&lt;c1&gt;', c2: '&lt;c2&gt;' },
      range: [-0.5, 1.5],
      autorange: false,
    })
    expect(layout.uirevision).toBe('m1')
    expect(layout.annotations).toEqual([])
  })

  it('leaves the range to Plotly without commits, and says there is nothing to plot', () => {
    const layout = graphLayout({ commits: [], displayValue: display, revision: '', empty: true })

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

    expect(drawn.customdata).toEqual([
      ['&lt;c1&gt;', '1.23457', '1 run'],
      ['&lt;c2&gt;', '2', '3 runs'],
    ])
    expect(drawn.hovertemplate).toContain('<b>BM_vector&lt;int&gt;</b>')
  })
})

describe('markerOf', () => {
  it('gives each machine its own marker, starting over once all are taken', () => {
    expect(markerOf(0).symbol).toBe('circle')
    expect(markerOf(1)).toEqual({ symbol: 'triangle-up', char: '▲' })
    expect(markerOf(8)).toBe(markerOf(0))
  })
})
