import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import type { PlotData, PlotHoverEvent, PlotMouseEvent, PlotRelayoutEvent } from 'plotly.js'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client'
import type { SuiteSchema } from '../../api/suites'
import type { PlotGeometry } from '../../components/chart'
import { formatTimestamp, shortUuid } from '../../format'
import { cursorPage, metric, regression, uuidOf } from '../../test/fixtures'
import { errorResponse, mockApi } from '../../test/mock-api'
import { currentUrl, gate, main, mockRegressions, query, renderPage, search } from '../../test/page'
import { pickOption, selectButton } from '../../test/select'
import { server } from '../../test/server'
import {
  GRAPHED,
  GRAPH_SUITE,
  chart,
  layout,
  listed,
  mockWorld,
  pointOf,
  testTable,
  type Sample,
} from './graph-world'

// The tests check what the page hands Plotly to draw (see test/chart.tsx), and play Plotly's part
// in reporting the events on the chart.
vi.mock('../../components/chart', () => import('../../test/chart'))

/** Where the chart draws: an x-axis position `v` at `50 + 100 v`, a value `v` at `400 - 10 v`. */
const GEOMETRY: PlotGeometry = {
  area: { left: 50, top: 10, width: 500, height: 400 },
  x: (value) => 50 + 100 * value,
  y: (value) => 400 - 10 * value,
}

/** Report that the chart was drawn, where `geometry` says. */
function draw(geometry: PlotGeometry = GEOMETRY) {
  act(() => chart().onDraw?.(geometry))
}

/** The trace of the chart named `name`. */
function curve(name: string) {
  const found = chart().data.find((trace) => (trace as PlotData).name === name)
  if (found === undefined) throw new Error(`No trace named ${name}`)
  return found
}

/** A Plotly event on point `index` of the trace named `name`. */
function eventOn(name: string, index: number, init: MouseEventInit = {}) {
  return {
    points: [{ data: curve(name), pointNumber: index }],
    event: new MouseEvent('click', init),
  } as unknown as PlotMouseEvent & PlotHoverEvent
}

function hover(name: string, index: number) {
  act(() => chart().onHover?.(eventOn(name, index)))
}

function unhover() {
  act(() => chart().onUnhover?.({ points: [], event: new MouseEvent('mouseout') }))
}

function click(name: string, index: number, init?: MouseEventInit) {
  act(() => chart().onClick?.(eventOn(name, index, init)))
}

/** The traces of the chart that draw the tests' data, by name. */
function dataTraces() {
  return (chart().data as PlotData[]).filter((trace) => trace.mode === 'lines+markers')
}

/** The point details shown. */
function details() {
  return within(screen.getByRole('dialog'))
}

/** The markers of the points' samples (GR10). */
function circles() {
  return [...screen.getByRole('main').querySelectorAll('circle')]
}

/** The markers of the points' samples, by their place on the chart. */
function scatter() {
  return circles().map((circle) => ({
    x: Number(circle.getAttribute('cx')),
    y: Number(circle.getAttribute('cy')),
  }))
}

const ONE_MACHINE = '/graph?suite=libcxx&machine=m1&metric=execution_time'

describe('hover (GR7, GR10)', () => {
  it("emphasizes the hovered row's test, its baseline's lines too, fading others", async () => {
    mockWorld()
    renderPage(`${GRAPHED}&test=a&test=b&baseline=libcxx/m1/c10`)
    await waitFor(() => expect(chart().data).toHaveLength(5))

    fireEvent.mouseEnter(testTable().getByText('b').closest('tr')!)

    const looks = (chart().data as PlotData[]).map((trace) => [
      trace.name,
      trace.opacity,
      trace.line.width,
    ])
    expect(looks).toEqual([
      ['a - m1', 0.2, 1.5],
      ['b - m1', undefined, 3],
      ['b - m2', undefined, 3],
      ['a - baseline libcxx/m1/r10', 0.2, 1.5],
      ['b - baseline libcxx/m1/r10', undefined, 3],
    ])

    fireEvent.mouseLeave(main().getByRole('table', { name: 'Tests' }).parentElement!)
    expect((chart().data as PlotData[]).map((trace) => trace.opacity)).toEqual(
      Array(5).fill(undefined),
    )
  })

  it("leaves the chart as it is while hovering a row whose test is not drawn", async () => {
    mockWorld()
    renderPage(`${GRAPHED}&test=a`)
    await waitFor(() => expect(dataTraces()).toHaveLength(1))
    const data = chart().data

    fireEvent.mouseEnter(testTable().getByText('c').closest('tr')!)

    expect(chart().data).toBe(data)
  })

  it('highlights the row of the test whose line is hovered, until it is left', async () => {
    mockWorld()
    renderPage(`${GRAPHED}&test=a&test=b`)
    await waitFor(() => expect(dataTraces()).toHaveLength(3))
    const name = (test: string) => testTable().getByText(test).closest('span')

    hover('b - m2', 0)
    expect(name('b')).toHaveClass('hovered')
    expect(name('a')).not.toHaveClass('hovered')

    unhover()
    expect(name('b')).not.toHaveClass('hovered')
  })

  it("highlights the row of the test whose baseline's line is hovered", async () => {
    mockWorld()
    renderPage(`${ONE_MACHINE}&test=a&test=b&baseline=libcxx/m1/c10`)
    await waitFor(() => expect(chart().data).toHaveLength(4))

    hover('b - baseline libcxx/m1/r10', 50)

    expect(testTable().getByText('b').closest('span')).toHaveClass('hovered')
  })

  it('stops emphasizing a test once the filter hides it, or the header is hovered', async () => {
    mockWorld()
    renderPage(`${GRAPHED}&test=a&test=b`)
    await waitFor(() => expect(dataTraces()).toHaveLength(3))
    const opacities = () => dataTraces().map((trace) => trace.opacity)
    fireEvent.mouseEnter(testTable().getByText('a').closest('tr')!)
    expect(opacities()).toEqual([undefined, 0.2, 0.2])

    // The filter hides a, which stays drawn, but not emphasized, nor highlighted when hovered.
    search('Filter tests', 'b')
    await waitFor(() => expect(listed()).toEqual(['b']))
    expect(dataTraces()).toHaveLength(3)
    expect(opacities()).toEqual([undefined, undefined, undefined])
    hover('a - m1', 0)
    expect(screen.getByRole('main').querySelector('.hovered')).toBeNull()
    unhover()
    // Shown again, it is still selected, and not emphasized.
    search('Filter tests', '')
    await waitFor(() => expect(listed()).toHaveLength(4))
    expect(testTable().getByRole('checkbox', { name: 'a' })).toBeChecked()
    expect(opacities()).toEqual([undefined, undefined, undefined])

    fireEvent.mouseEnter(testTable().getByText('a').closest('tr')!)
    fireEvent.mouseOver(testTable().getByRole('columnheader', { name: 'Test' }))
    expect(opacities()).toEqual([undefined, undefined, undefined])
  })

  it('shows every sample of a point hovered that has several, even from a single run', async () => {
    // c10 has one run with three samples; c20 has one run with a single sample.
    const samples: Record<string, Sample[]> = {
      'm1/a': [
        ['c10', 'r1', 1],
        ['c10', 'r1', 5],
        ['c10', 'r1', 9],
        ['c20', 'r2', 2],
      ],
    }
    mockWorld({ samples })
    renderPage(`${ONE_MACHINE}&test=a`)
    await waitFor(() => expect(dataTraces()).toHaveLength(1))
    draw()

    hover('a - m1', 0)
    // At c10's position, 0, over the plotting area, which starts at (50, 10).
    expect(scatter()).toEqual([
      { x: 0, y: 380 },
      { x: 0, y: 340 },
      { x: 0, y: 300 },
    ])
    const [circle] = circles()
    expect(circle).toHaveAttribute('fill-opacity', '0.3')
    expect(circle).toHaveAttribute('fill', (curve('a - m1') as PlotData).line.color as string)

    hover('a - m1', 1)
    expect(scatter()).toEqual([])
    hover('a - m1', 0)
    unhover()
    expect(scatter()).toEqual([])
  })

  it("shows the samples of all of a point's runs, not their per-run values", async () => {
    // At c10, run r1's median is 3, and r2's is 10: the samples are 1, 5 and 10.
    const samples: Record<string, Sample[]> = {
      'm1/a': [
        ['c10', 'r1', 1],
        ['c10', 'r1', 5],
        ['c10', 'r2', 10],
      ],
    }
    mockWorld({ samples })
    renderPage(`${ONE_MACHINE}&test=a`)
    await waitFor(() => expect(dataTraces()).toHaveLength(1))
    draw()

    hover('a - m1', 0)
    expect(scatter()).toEqual([
      { x: 0, y: 380 },
      { x: 0, y: 340 },
      { x: 0, y: 290 },
    ])
  })
})

describe('the point details (GR11)', () => {
  const SAMPLES: Record<string, Sample[]> = {
    'm1/a': [
      ['c10', 'r1', 1],
      // Measured after r3, though listed first.
      ['c20', 'r2', 2, '2026-08-26T10:00:00Z'],
      // Two samples, listed in ascending order whatever the order they arrive in.
      ['c20', 'r3', 6, '2026-08-25T10:00:00Z'],
      ['c20', 'r3', 4, '2026-08-25T10:00:00Z'],
    ],
  }

  it('opens on a click, with its runs, links, and a comparison with the point before', async () => {
    mockWorld({ samples: SAMPLES })
    renderPage(`${ONE_MACHINE}&test=a&sample_agg=max&run_agg=min`)
    await waitFor(() => expect(dataTraces()).toHaveLength(1))
    draw()

    click('a - m1', 1)

    const dialog = screen.getByRole('dialog', { name: 'a on m1 at r20' })
    expect(dialog).toHaveFocus()
    expect(details().getByRole('link', { name: 'm1' })).toHaveAttribute(
      'href',
      '/suites/libcxx/machines/m1',
    )
    expect(details().getByRole('link', { name: 'r20' })).toHaveAttribute(
      'href',
      '/suites/libcxx/commits/c20',
    )
    expect(details().getByText('2 (2 runs)')).toBeInTheDocument()
    const table = details().getByRole('table', { name: 'Runs' })
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Measured',
      'Run',
      'Samples',
    ])
    const runs = within(table).getAllByRole('row').slice(1)
    expect(runs.map((run) => within(run).getByRole('link').getAttribute('href'))).toEqual([
      '/suites/libcxx/runs/r3',
      '/suites/libcxx/runs/r2',
    ])
    expect(runs.map((run) => within(run).getAllByRole('cell').at(-1)?.textContent)).toEqual([
      '4\u00a0· 6',
      '2',
    ])
    const compare = details().getByRole('link', { name: 'Compare with previous commit' })
    expect(compare).toHaveAttribute(
      'href',
      '/compare?suite_a=libcxx&machine_a=m1&commit_a=c10' +
        '&suite_b=libcxx&machine_b=m1&commit_b=c20' +
        '&metric=execution_time&run_agg=min&sample_agg=max',
    )
    // Beside the point, at c20's position, 1, and its value, 2.
    expect(dialog).toHaveStyle({ left: '150px', top: '380px' })
  })

  it('leaves out the aggregations at their default from the comparison', async () => {
    mockWorld({ samples: SAMPLES })
    renderPage(`${ONE_MACHINE}&test=a`)
    await waitFor(() => expect(dataTraces()).toHaveLength(1))
    draw()

    click('a - m1', 1)

    const compare = details().getByRole('link', { name: 'Compare with previous commit' })
    expect(compare.getAttribute('href')).not.toMatch(/agg/)
  })

  it('cannot compare the first point of a trace, saying why', async () => {
    mockWorld({ samples: SAMPLES })
    renderPage(`${ONE_MACHINE}&test=a`)
    await waitFor(() => expect(dataTraces()).toHaveLength(1))
    draw()

    click('a - m1', 0)

    const compare = details().getByRole('link', { name: 'Compare with previous commit' })
    expect(compare).toHaveAttribute('aria-disabled', 'true')
    expect(compare).toHaveAccessibleDescription('This is the first point of its trace.')
  })

  it("cannot compare while the trace's data is loading, and can once it has arrived", async () => {
    const second = gate()
    mockWorld()
    server.use(
      mockApi('post', '/api/suites/{testsuite}/query', async ({ request }) => {
        const { cursor } = await request.json()
        if (cursor) await second.promise
        const samples: Sample[] = cursor ? [['c30', 'r3', 3]] : [['c10', 'r1', 1], ['c20', 'r2', 2]]
        const points = samples.map((sample) => pointOf('m1', 'a', sample))
        return HttpResponse.json(cursorPage(points, cursor ? null : '1'))
      }),
    )
    renderPage(`${ONE_MACHINE}&test=a`)
    await waitFor(() => expect((dataTraces()[0]?.x as string[]) ?? []).toHaveLength(2))
    draw()

    click('a - m1', 1)
    const compare = () => details().getByRole('link', { name: 'Compare with previous commit' })
    expect(compare()).toHaveAccessibleDescription("The test's data is still loading.")

    act(() => second.open())
    await waitFor(() => expect(compare()).toHaveAttribute('href'))
    expect(screen.getByRole('dialog')).toHaveAccessibleName('a on m1 at r20')
  })

  it('follows its point as the chart is drawn again', async () => {
    mockWorld({ samples: SAMPLES })
    renderPage(`${ONE_MACHINE}&test=a`)
    await waitFor(() => expect(dataTraces()).toHaveLength(1))
    draw()
    click('a - m1', 1)

    draw({ ...GEOMETRY, x: (value) => 100 + 100 * value })

    expect(screen.getByRole('dialog')).toHaveStyle({ left: '200px' })
  })

  it('closes on Escape, its close button, a press outside it, and a zoom', async () => {
    mockWorld({ samples: SAMPLES })
    renderPage(`${ONE_MACHINE}&test=a`)
    await waitFor(() => expect(dataTraces()).toHaveLength(1))
    draw()
    const user = userEvent.setup()

    // Closed from the keyboard or its button, they give the focus back to the chart.
    const area = main().getByRole('img').parentElement!
    click('a - m1', 1)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(area).toHaveFocus()

    click('a - m1', 1)
    await user.click(details().getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(area).toHaveFocus()

    click('a - m1', 1)
    // Moving the focus out does not close it, unlike a press.
    await user.tab()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.pointerDown(main().getByRole('heading', { name: 'Graph' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    click('a - m1', 1)
    act(() => chart().onRelayout?.({ 'xaxis.range[0]': 1 } as PlotRelayoutEvent))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes on a change to the regressions, machines or baselines, not the filter', async () => {
    mockWorld({ samples: SAMPLES })
    mockRegressionWorld()
    renderPage(`${GRAPHED}&test=a&baseline=libcxx/m1/c10`)
    await waitFor(() => expect(dataTraces()).toHaveLength(1))
    draw()
    const user = userEvent.setup()
    const reopen = () => {
      click('a - m1', 1)
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    }

    reopen()
    await pickOption('Regressions', 'All')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // The filter changes only the test table (GR1).
    reopen()
    search('Filter tests', 'b')
    await waitFor(() => expect(listed()).toEqual(['b']))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    search('Filter tests', '')
    await waitFor(() => expect(listed()).toHaveLength(4))

    reopen()
    await user.click(screen.getByRole('button', { name: 'Remove baseline libcxx/m1/r10' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    reopen()
    await user.click(screen.getByRole('button', { name: 'Remove m2' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('opens nothing on a click of another button than the main one', async () => {
    mockWorld({ samples: SAMPLES })
    renderPage(`${ONE_MACHINE}&test=a`)
    await waitFor(() => expect(dataTraces()).toHaveLength(1))
    draw()

    click('a - m1', 1, { button: 2 })
    click('a - m1', 1, { button: 1 })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens the details of another point clicked instead', async () => {
    mockWorld({ samples: SAMPLES })
    renderPage(`${ONE_MACHINE}&test=a`)
    await waitFor(() => expect(dataTraces()).toHaveLength(1))
    draw()
    click('a - m1', 1)

    // Plotly sees the press first, and reports the click after.
    fireEvent.pointerDown(main().getByRole('img'))
    click('a - m1', 0)

    expect(screen.getByRole('dialog')).toHaveAccessibleName('a on m1 at r10')
  })

  it('closes on a change to the chart, and stays closed once the change is undone', async () => {
    mockWorld({ samples: SAMPLES })
    renderPage(`${ONE_MACHINE}&test=a`)
    await waitFor(() => expect(dataTraces()).toHaveLength(1))
    draw()
    click('a - m1', 1)

    await pickOption('Sample aggregation', 'max')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await pickOption('Sample aggregation', 'median')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes once its point is no longer drawn', async () => {
    mockWorld({ samples: { ...SAMPLES, 'm1/b': [['c10', 'r1', 3]] } })
    renderPage(`${ONE_MACHINE}&test=a&test=b`)
    await waitFor(() => expect(dataTraces()).toHaveLength(2))
    draw()
    click('a - m1', 1)

    fireEvent.click(testTable().getByRole('checkbox', { name: 'a' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})

describe('the samples of the point whose details are open (GR10, GR11)', () => {
  const SAMPLES: Record<string, Sample[]> = {
    'm1/a': [
      ['c10', 'r1', 1],
      ['c10', 'r1', 5],
      ['c20', 'r2', 2, '2026-08-26T10:00:00Z'],
      ['c20', 'r3', 6, '2026-08-25T10:00:00Z'],
      ['c20', 'r3', 4, '2026-08-25T10:00:00Z'],
      ['c30', 'r4', 3],
    ],
  }

  async function renderOpen(index: number) {
    mockWorld({ samples: SAMPLES })
    renderPage(`${ONE_MACHINE}&test=a`)
    await waitFor(() => expect(dataTraces()).toHaveLength(1))
    draw()
    click('a - m1', index)
  }

  it("stay while the details are open, with the hovered point's, and go as they do", async () => {
    await renderOpen(1)
    const user = userEvent.setup()
    // At c20's position, 1, over the plotting area, which starts at (50, 10).
    const c20 = [
      { x: 100, y: 370 },
      { x: 100, y: 330 },
      { x: 100, y: 350 },
    ]
    expect(scatter()).toEqual(c20)

    hover('a - m1', 0)
    expect(scatter()).toEqual([{ x: 0, y: 380 }, { x: 0, y: 340 }, ...c20])
    // Not twice for the open point hovered.
    hover('a - m1', 1)
    expect(scatter()).toEqual(c20)
    unhover()
    expect(scatter()).toEqual(c20)

    await user.keyboard('{Escape}')
    expect(scatter()).toEqual([])

    click('a - m1', 1)
    fireEvent.pointerDown(main().getByRole('heading', { name: 'Graph' }))
    expect(scatter()).toEqual([])

    click('a - m1', 1)
    await pickOption('Sample aggregation', 'max')
    expect(scatter()).toEqual([])

    // A point with a single sample has none to show.
    click('a - m1', 2)
    expect(screen.getByRole('dialog')).toHaveAccessibleName('a on m1 at r30')
    expect(scatter()).toEqual([])
  })

  it("show a sample's tooltip on hover, and leave the details open when pressed", async () => {
    await renderOpen(1)
    const user = userEvent.setup()
    const circle = circles()[1]

    fireEvent.pointerEnter(circle)
    const tip = screen.getByRole('tooltip')
    // Its run, as the details list it, then its value.
    expect([...tip.children].map((line) => line.textContent)).toEqual([
      formatTimestamp('2026-08-25T10:00:00Z'),
      shortUuid('r3'),
      'Value: 6',
    ])
    // Beside the sample, at c20's position, 1, and its value, 6, away from the details.
    expect(tip).toHaveStyle({ left: '150px', top: '340px' })
    expect(tip.style.transform).toMatch(/^translate\(calc\(-100% - 8px\)/)
    fireEvent.pointerLeave(circle)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    // The details keep the focus, for Escape to close them.
    await user.click(circle)
    expect(screen.getByRole('dialog')).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

/** Regressions at c20, where m1 has test a, and one at a commit off the x-axis. */
const REGRESSIONS = [
  regression('1', {
    title: 'a slowed down',
    state: 'active',
    commit: 'c20',
    bug: 'https://example.com/bugs/1',
  }),
  regression('2', { title: null, state: 'fixed', commit: 'c20' }),
  regression('3', { title: 'Off the axis', state: 'detected', commit: 'c99' }),
]

/**
 * Answer the indicator lookup with an indicator on m1 and test a for each of REGRESSIONS, and the
 * regression list with REGRESSIONS, recording the bodies of the lookups and the list's queries.
 */
function mockRegressionWorld() {
  const lookups: Schemas['IndicatorQuery'][] = []
  server.use(
    mockApi('post', '/api/suites/{testsuite}/regressions/indicators/query', async ({ request }) => {
      const body = await request.json()
      lookups.push(body)
      const items = REGRESSIONS.map(({ uuid }, i) => ({
        uuid: uuidOf(`${i}0`),
        regression_uuid: uuid,
        machine: 'm1',
        test: 'a',
        metric: 'execution_time',
      }))
      return HttpResponse.json(cursorPage(items))
    }),
  )
  const lists = mockRegressions(() => cursorPage(REGRESSIONS))
  return { lookups, lists }
}

/** The markers of the regressions on the chart. */
function markers() {
  return (chart().data as PlotData[]).filter((trace) => trace.yaxis === 'y2')
}

describe('the regression annotations (GR15)', () => {
  it('is disabled until a suite is selected', async () => {
    mockWorld()
    renderPage('/graph')
    await waitFor(() => expect(selectButton('Suite')).toBeEnabled())
    expect(selectButton('Regressions')).toBeDisabled()
  })

  it('asks for nothing while off, the default', async () => {
    mockWorld()
    const { lookups, lists } = mockRegressionWorld()
    renderPage(`${ONE_MACHINE}&test=a`)
    await waitFor(() => expect(dataTraces()).toHaveLength(1))
    expect(selectButton('Regressions')).toHaveTextContent('Off')
    expect(lookups).toEqual([])
    expect(lists).toEqual([])
  })

  it("marks the plotted tests' regressions at their commit, by state, stacked", async () => {
    mockWorld()
    const { lookups, lists } = mockRegressionWorld()
    renderPage(`${GRAPHED}&test=a&regressions=all`)

    await waitFor(() => expect(markers()).toHaveLength(2))
    expect(lookups).toEqual([
      {
        machine: ['m1', 'm2'],
        test: ['a'],
        metric: 'execution_time',
        state: ['detected', 'active', 'not_to_be_fixed', 'fixed', 'false_positive'],
        limit: 10000,
        cursor: null,
      },
    ])
    expect(lists.at(-1)?.getAll('state')).toHaveLength(5)
    expect(lists.at(-1)?.get('metric')).toBe('execution_time')
    expect(lists.at(-1)?.get('has_commit')).toBe('true')

    const [active, fixed] = markers()
    expect(active.x).toEqual(['c20'])
    expect(active.marker.color).toBe('#dc2626')
    expect(active.hovertemplate).toContain('<b>a slowed down</b><br>Affects:<br>a<br>')
    expect(fixed.marker.color).toBe('#6b7280')
    expect(fixed.hovertemplate).toContain('<b>(untitled)</b>')
    expect((fixed.y as number[])[0]).toBeLessThan((active.y as number[])[0])
    // The lines, at the commits on the x-axis only.
    expect(layout().shapes?.map((shape) => [shape.x0, shape.line?.color])).toEqual([
      ['c20', '#dc2626'],
      ['c20', '#6b7280'],
    ])
  })

  it('asks for the states still worked on in Active mode, as the URL keeps it', async () => {
    mockWorld()
    const { lookups } = mockRegressionWorld()
    renderPage(`${GRAPHED}&test=a`)
    await waitFor(() => expect(dataTraces()).toHaveLength(1))

    await pickOption('Regressions', 'Active')

    expect(currentUrl()).toContain('regressions=active')
    await waitFor(() => expect(lookups.at(-1)?.state).toEqual(['detected', 'active']))
  })

  it("shows the details of the regression whose marker is clicked, linking to it", async () => {
    mockWorld()
    mockRegressionWorld()
    renderPage(`${GRAPHED}&test=a&regressions=all`)
    await waitFor(() => expect(markers()).toHaveLength(2))
    draw()

    click(markers()[0].name!, 0)

    const dialog = screen.getByRole('dialog', { name: 'Regression: a slowed down' })
    expect(dialog).toHaveFocus()
    expect(details().getByText('active')).toBeInTheDocument()
    expect(details().getByRole('link', { name: 'r20' })).toHaveAttribute(
      'href',
      '/suites/libcxx/commits/c20',
    )
    expect(details().getByRole('link', { name: 'https://example.com/bugs/1' })).toHaveAttribute(
      'target',
      '_blank',
    )
    const tests = details().getByRole('list', { name: 'Selected tests affected' })
    expect(within(tests).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['a'])
    const link = details().getByRole('link', { name: `${uuidOf('1').slice(0, 8)}…` })
    expect(link).toHaveAttribute('href', `/suites/libcxx/regressions/${uuidOf('1')}`)
    expect(link).toHaveAttribute('title', uuidOf('1'))
    // Beside the marker, below it: at c20's position, 1, near the top of the plot.
    expect(dialog).toHaveStyle({ left: '150px', top: '18px', transform: 'translate(12px, -12px)' })
    expect(currentUrl()).toContain('/graph')
  })

  it("shows one popover at a time, a point's or a regression's, none on right-click", async () => {
    mockWorld()
    mockRegressionWorld()
    renderPage(`${GRAPHED}&test=a&regressions=all`)
    await waitFor(() => expect(markers()).toHaveLength(2))
    draw()

    click(markers()[1].name!, 0, { button: 2 })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    click('a - m1', 1)
    fireEvent.pointerDown(main().getByRole('img'))
    click(markers()[1].name!, 0)

    expect(screen.getByRole('dialog')).toHaveAccessibleName('Regression: (untitled)')
  })

  it('keeps the regressions marked while a selection is looked up, but none it left', async () => {
    mockWorld()
    const held = gate()
    let lookups = 0
    const path = '/api/suites/{testsuite}/regressions/indicators/query'
    server.use(
      mockApi('post', path, async ({ request }) => {
        const { test } = await request.json()
        if (++lookups > 1) await held.promise
        // Regression 1 affects test a; regression 2, test b.
        const items = [
          { regression_uuid: uuidOf('1'), test: 'a' },
          { regression_uuid: uuidOf('2'), test: 'b' },
        ]
          .filter((item) => test!.includes(item.test))
          .map((item, i) => ({ ...item, uuid: uuidOf(`${i}0`), machine: 'm1', metric: 'x' }))
        return HttpResponse.json(cursorPage(items))
      }),
    )
    mockRegressions(() => cursorPage(REGRESSIONS))
    renderPage(`${ONE_MACHINE}&test=a&test=b&regressions=all`)
    await waitFor(() => expect(markers()).toHaveLength(2))

    // Deselecting b drops its regression at once, and keeps a's while the lookup is answered.
    fireEvent.click(testTable().getByRole('checkbox', { name: 'b' }))
    await waitFor(() => expect(markers()).toHaveLength(1))
    expect(markers()[0].hovertemplate).toContain('a slowed down')
    act(() => held.open())
  })

  it('asks only about the tests some machine lists, once they are all listed', async () => {
    mockWorld()
    const { lookups } = mockRegressionWorld()
    renderPage(`${GRAPHED}&test=a&test=zzz&regressions=all`)

    await waitFor(() => expect(markers()).toHaveLength(2))
    expect(lookups.map((body) => body.test)).toEqual([['a']])
  })

  it('says why the regressions could not be loaded, and tries again', async () => {
    mockWorld()
    mockRegressionWorld()
    let failing = true
    server.use(
      mockApi('get', '/api/suites/{testsuite}/regressions', () =>
        failing
          ? errorResponse(500, 'internal_error', 'The regressions broke.')
          : HttpResponse.json(cursorPage(REGRESSIONS)),
      ),
    )
    renderPage(`${GRAPHED}&test=a&regressions=all`)

    expect(
      await main().findByText(/The regressions could not be loaded: The regressions broke\./),
    ).toBeInTheDocument()
    failing = false
    fireEvent.click(within(main().getByRole('alert')).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(markers()).toHaveLength(2))
  })
})

/** The lines of the baselines on the chart, as `name: value`. */
function baselineLines() {
  return (chart().data as PlotData[])
    .filter((trace) => trace.xaxis === 'x2')
    .map((trace) => `${trace.name}: ${(trace.y as number[])[0]}`)
}

/** A suite with the same machines and data as libcxx, whose execution time has another unit. */
const OTHER_UNIT: SuiteSchema = {
  ...GRAPH_SUITE,
  name: 'other',
  metrics: [metric('execution_time', { unit: 'milliseconds' })],
}

describe('the baselines (GR9)', () => {
  it('draws a line per baseline and selected test across the chart, by display value', async () => {
    const recorded = mockWorld()
    renderPage(`${ONE_MACHINE}&test=a&test=b&baseline=libcxx/m1/c10`)

    await waitFor(() =>
      expect(baselineLines()).toEqual([
        'a - baseline libcxx/m1/r10: 1',
        'b - baseline libcxx/m1/r10: 3',
      ]),
    )
    const [line] = chart().data as PlotData[]
    expect(line.name).toBe('a - m1')
    const a = curve('a - baseline libcxx/m1/r10') as PlotData
    expect(a.x).toHaveLength(101)
    expect(a.line.dash).toBe('dash')
    expect(a.line.color).toBe(line.line.color)
    expect(a.hovertemplate).toContain('Suite: libcxx<br>Machine: m1<br>Commit: r10<br>Test: a')
    // Every test's data at the commit, in no order, which leaves in commits without an ordinal.
    expect(recorded.queries.find(({ body }) => body.commit)?.body).toEqual({
      metric: 'execution_time',
      machine: 'm1',
      commit: 'c10',
      limit: 10000,
      cursor: null,
    })
    const chips = within(main().getByRole('list', { name: 'Baselines added' }))
    expect(chips.getByRole('listitem')).toHaveTextContent('libcxx/m1/r10')
  })

  it('combines the baseline\'s samples as the traces are', async () => {
    const samples: Record<string, Sample[]> = {
      'm1/a': [
        ['c10', 'r1', 1],
        ['c10', 'r1', 5],
        ['c10', 'r2', 10],
      ],
    }
    mockWorld({ samples })
    renderPage(`${ONE_MACHINE}&test=a&baseline=libcxx/m1/c10&run_agg=max`)

    await waitFor(() => expect(baselineLines()).toEqual(['a - baseline libcxx/m1/r10: 10']))
    await pickOption('Run aggregation', 'min')
    expect(baselineLines()).toEqual(['a - baseline libcxx/m1/r10: 3'])
  })

  it("drops a baseline whose suite, machine or commit doesn't exist, or is malformed", async () => {
    mockWorld()
    const kept = 'baseline=libcxx%2Fm1%2Fc10'
    renderPage(
      `${ONE_MACHINE}&baseline=nope/m1/c10&baseline=libcxx/gone/c10&baseline=libcxx/m1/c40` +
        `&baseline=a/b&${kept}`,
    )

    await waitFor(() => expect(currentUrl()).toBe(`${ONE_MACHINE}&${kept}`))
  })

  it('draws nothing from a suite whose metric has another unit, and asks for nothing', async () => {
    const recorded = mockWorld({ suites: [OTHER_UNIT] })
    renderPage(`${ONE_MACHINE}&test=a&baseline=other/m1/c10&baseline=libcxx/m1/c20`)

    await waitFor(() => expect(baselineLines()).toEqual(['a - baseline libcxx/m1/r20: 2']))
    const baselines = recorded.queries.filter(({ body }) => body.commit)
    expect(baselines.map(({ body }) => body.commit)).toEqual(['c20'])
    expect(query().baseline).toEqual(['other/m1/c10', 'libcxx/m1/c20'])
  })

  it('says that there is nothing to plot while only a baseline is drawn (GR12)', async () => {
    mockWorld({ samples: { 'm2/b': [['c40', 'r3', 4]] } })
    renderPage(`${ONE_MACHINE}&test=b&baseline=libcxx/m2/c40`)

    await waitFor(() => expect(baselineLines()).toEqual(['b - baseline libcxx/m2/r40: 4']))
    await waitFor(() => expect(layout().annotations?.[0]?.text).toBe('No data to plot'))
  })

  it('adds a baseline from the panel, which then closes, and removes it', async () => {
    mockWorld()
    renderPage(`${ONE_MACHINE}&test=a`)
    await waitFor(() => expect(listed()).toEqual(['a', 'b', 'c']))
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Add a baseline' }))
    await pickOption('Baseline suite', 'libcxx')
    await user.type(screen.getByRole('combobox', { name: 'Baseline machine' }), 'm1')
    await user.click(await screen.findByRole('option', { name: 'm1' }))
    const commit = screen.getByRole('combobox', { name: 'Baseline commit' })
    await user.type(commit, 'r20')
    await user.click(await screen.findByRole('option', { name: 'r20' }))

    await waitFor(() => expect(query().baseline).toEqual(['libcxx/m1/c20']))
    expect(screen.queryByRole('group', { name: 'New baseline' })).not.toBeInTheDocument()
    const add = screen.getByRole('button', { name: 'Add a baseline' })
    expect(add).toHaveFocus()
    expect(add).toHaveAttribute('aria-expanded', 'false')
    await waitFor(() => expect(baselineLines()).toEqual(['a - baseline libcxx/m1/r20: 2']))

    await user.click(screen.getByRole('button', { name: 'Remove baseline libcxx/m1/r20' }))
    expect(query().baseline).toBeUndefined()
    // The focus goes to the button adding one, once none is left.
    expect(screen.getByRole('button', { name: 'Add a baseline' })).toHaveFocus()
  })

  it('keeps the baselines and the regression mode on a new suite', async () => {
    mockWorld()
    renderPage(`${ONE_MACHINE}&baseline=libcxx/m1/c10&regressions=active`)
    await waitFor(() =>
      expect(main().getByRole('list', { name: 'Baselines added' })).toHaveTextContent('r10'),
    )

    await pickOption('Suite', 'text_only')

    await waitFor(() =>
      expect(query()).toEqual({
        suite: ['text_only'],
        regressions: ['active'],
        baseline: ['libcxx/m1/c10'],
      }),
    )
  })

  it('says why a baseline could not be loaded, and tries again', async () => {
    const recorded = mockWorld()
    let failing = true
    server.use(
      mockApi('post', '/api/suites/{testsuite}/query', async ({ request }) => {
        const body = await request.json()
        recorded.queries.push({ body, signal: request.signal })
        if (body.commit && failing) {
          return errorResponse(500, 'internal_error', 'The baseline broke.')
        }
        return HttpResponse.json(cursorPage([pointOf('m1', 'a', ['c10', 'r1', 1])]))
      }),
    )
    renderPage(`${ONE_MACHINE}&test=a&baseline=libcxx/m1/c10`)

    expect(
      await main().findByText(/A baseline could not be loaded: The baseline broke\./),
    ).toBeInTheDocument()
    failing = false
    fireEvent.click(within(main().getByRole('alert')).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(baselineLines()).toEqual(['a - baseline libcxx/m1/r10: 1']))
  })
})
