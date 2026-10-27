import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import type { PlotData, PlotHoverEvent, PlotMouseEvent, PlotRelayoutEvent } from 'plotly.js'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client'
import type { SuiteSchema } from '../../api/suites'
import type { PlotGeometry } from '../../components/chart'
import { formatTimestamp, shortUuid } from '../../format'
import { signIn } from '../../test/auth'
import {
  cursorPage,
  metric,
  NO_REPOSITORY,
  regression,
  regressionDetail,
  uuidOf,
} from '../../test/fixtures'
import { hoverText } from '../../test/hover-text'
import { errorResponse, mockApi, ndjsonResponse } from '../../test/mock-api'
import {
  currentUrl,
  gate,
  main,
  mockCommits,
  mockCreateRegression,
  mockRegressions,
  query,
  renderPage,
  search,
} from '../../test/page'
import { pickOption, selectButton } from '../../test/select'
import { server } from '../../test/server'
import {
  COMMITS,
  GRAPHED,
  GRAPH_SUITE,
  addMachine,
  answerSeries,
  chart,
  commitAt,
  drawn,
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
      ['a - baseline libcxx/m1/r10', 0.2, 1.5],
      ['b - baseline libcxx/m1/r10', undefined, 3],
      ['a - m1', 0.2, 1.5],
      ['b - m1', undefined, 3],
      ['b - m2', undefined, 3],
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
      // Measured half a second after r3, though listed first. As strings, its fraction of a
      // second would sort it before r3's whole second.
      ['c20', 'r2', 2, '2026-08-26T10:00:00.5Z'],
      // Two samples, listed in ascending order whatever the order they arrive in.
      ['c20', 'r3', 6, '2026-08-26T10:00:00Z'],
      ['c20', 'r3', 4, '2026-08-26T10:00:00Z'],
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
      '4 · 6',
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

  describe('its links into the repository', () => {
    it('lead to the commit, and to the changes since the point before, in a new tab', async () => {
      mockWorld({ samples: SAMPLES })
      renderPage(`${ONE_MACHINE}&test=a`)
      await waitFor(() => expect(dataTraces()).toHaveLength(1))
      draw()

      click('a - m1', 1)

      const viewOn = details().getByRole('link', { name: 'View on GitHub' })
      expect(viewOn).toHaveAttribute('href', 'https://github.com/llvm/llvm-project/commit/c20')
      // The same two commits as the comparison with the point before.
      const viewChanges = details().getByRole('link', { name: 'View changes on GitHub' })
      expect(viewChanges).toHaveAttribute(
        'href',
        'https://github.com/llvm/llvm-project/compare/c10...c20',
      )
      for (const shown of [viewOn, viewChanges]) {
        expect(shown).toHaveAttribute('target', '_blank')
        expect(shown).toHaveAttribute('rel', 'noopener noreferrer')
      }
    })

    it('lead to no changes from the first point of a trace, saying why', async () => {
      mockWorld({ samples: SAMPLES })
      renderPage(`${ONE_MACHINE}&test=a`)
      await waitFor(() => expect(dataTraces()).toHaveLength(1))
      draw()

      click('a - m1', 0)

      const viewChanges = details().getByRole('link', { name: 'View changes on GitHub' })
      expect(viewChanges).toHaveAttribute('aria-disabled', 'true')
      expect(viewChanges).not.toHaveAttribute('href')
      expect(viewChanges).toHaveAccessibleDescription('This is the first point of its trace.')
      expect(details().getByRole('link', { name: 'View on GitHub' })).toHaveAttribute(
        'href',
        'https://github.com/llvm/llvm-project/commit/c10',
      )
    })

    it('are not shown when the suite has no templates of their URLs', async () => {
      const bare = { ...GRAPH_SUITE, name: 'bare', repository: NO_REPOSITORY }
      mockWorld({ samples: SAMPLES, suites: [bare] })
      renderPage('/graph?suite=bare&machine=m1&metric=execution_time&test=a')
      await waitFor(() => expect(dataTraces()).toHaveLength(1))
      draw()

      click('a - m1', 1)

      expect(details().getByRole('link', { name: 'Compare with previous commit' })).toBeVisible()
      expect(details().queryByRole('link', { name: /^View/ })).not.toBeInTheDocument()
    })
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

  it('closes on a change to the regressions or machines, not the filter or baselines', async () => {
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

    // A click without a press, as from the keyboard, unlike a press outside the details.
    reopen()
    fireEvent.click(screen.getByRole('button', { name: 'Remove baseline libcxx/m1/r10' }))
    expect(query().baseline).toBeUndefined()
    // Its lines change neither the point nor what its details show (GR11).
    expect(screen.getByRole('dialog')).toBeInTheDocument()

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
 * Answer the indicator lookup with an indicator on m1 and test a for each of `regressions`, and the
 * regression list with `regressions`, as they are when asked, recording the bodies of the lookups
 * and the list's queries.
 */
function mockRegressionWorld(regressions: Schemas['Regression'][] = REGRESSIONS) {
  const lookups: Schemas['IndicatorQuery'][] = []
  server.use(
    mockApi('post', '/api/suites/{testsuite}/regressions/indicators/query', async ({ request }) => {
      const body = await request.json()
      lookups.push(body)
      const items = regressions.map(({ uuid }, i) => ({
        uuid: uuidOf(`${i}0`),
        regression_uuid: uuid,
        machine: 'm1',
        test: 'a',
        metric: 'execution_time',
      }))
      return HttpResponse.json(cursorPage(items))
    }),
  )
  const lists = mockRegressions(() => cursorPage(regressions))
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
    expect(hoverText(active, 0)).toContain('<b>a slowed down</b><br>Affects:<br>a<br>')
    expect(fixed.marker.color).toBe('#6b7280')
    expect(hoverText(fixed, 0)).toContain('<b>(untitled)</b>')
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

  it('says when the regression whose details are shown has no bug', async () => {
    mockWorld()
    mockRegressionWorld()
    renderPage(`${GRAPHED}&test=a&regressions=all`)
    await waitFor(() => expect(markers()).toHaveLength(2))
    draw()

    click(markers()[1].name!, 0)

    screen.getByRole('dialog', { name: 'Regression: (untitled)' })
    expect(details().getByText('Bug').nextElementSibling).toHaveTextContent(/^--$/)
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
    expect(hoverText(markers()[0], 0)).toContain('a slowed down')
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

const createButton = () => details().getByRole('button', { name: 'Create regression' })
const titleInput = () => details().getByRole('textbox', { name: 'Title' })
const confirmButton = () => details().getByRole('button', { name: 'Create' })

/** Open the point details of `trace` at `index`, then the form creating a regression from it. */
async function openForm(trace: string, index: number) {
  draw()
  click(trace, index)
  await waitFor(() => expect(createButton()).toBeEnabled())
  await userEvent.setup().click(createButton())
  expect(titleInput()).toHaveFocus()
}

describe('creating a regression from a point (GR11)', () => {
  it("creates one of the point's commit, machine, test and metric, titled, on Enter", async () => {
    signIn('triage')
    mockWorld()
    const requests = mockCreateRegression(regressionDetail('d', { title: 'b slowed down' }))
    renderPage(`${GRAPHED}&test=b`)
    await waitFor(() => expect(dataTraces()).toHaveLength(2))
    // The point of m2, the second machine, at c40.
    await openForm('b - m2', 0)

    // Whitespace at either end of the title is ignored.
    await userEvent.setup().type(titleInput(), '  b slowed down {Enter}')

    const status = await details().findByRole('status')
    expect(requests).toEqual([
      {
        suite: 'libcxx',
        body: {
          title: 'b slowed down',
          commit: 'c40',
          indicators: [{ machine: 'm2', test: 'b', metric: 'execution_time' }],
        },
      },
    ])
    expect(status).toHaveTextContent(/^Regression created: b slowed down$/)
    const link = within(status).getByRole('link')
    expect(link).toHaveAttribute('href', `/suites/libcxx/regressions/${uuidOf('d')}`)
    // In place of the form, which had the focus, for the dialog to keep it.
    expect(link).toHaveFocus()
    expect(details().queryByRole('form')).not.toBeInTheDocument()
    expect(details().queryByRole('button', { name: 'Create regression' })).not.toBeInTheDocument()
    expect(currentUrl()).toContain('/graph')
  })

  it('creates an untitled one, linked by its short UUID, marked on the chart at once', async () => {
    signIn('triage')
    mockWorld()
    const regressions = [...REGRESSIONS]
    mockRegressionWorld(regressions)
    const requests = mockCreateRegression(regressionDetail('4', { title: null, commit: 'c10' }))
    renderPage(`${ONE_MACHINE}&test=a&regressions=all`)
    await waitFor(() => expect(markers()).toHaveLength(2))
    await openForm('a - m1', 0)

    regressions.push(regression('4', { title: null, commit: 'c10' }))
    const user = userEvent.setup()
    // A title of only whitespace is none.
    await user.type(titleInput(), '   ')
    await user.click(confirmButton())

    await waitFor(() => expect(markers()).toHaveLength(3))
    expect(requests[0].body.title).toBeNull()
    expect(markers().map((marker) => marker.x)).toContainEqual(['c10'])
    // Marking it is no change that closes the details.
    expect(details().getByRole('status')).toHaveTextContent(/^Regression created: 44444444…$/)
  })

  it('cancels the form, forgetting its title, and gives the focus back', async () => {
    signIn('triage')
    mockWorld()
    const requests = mockCreateRegression(regressionDetail('d'))
    renderPage(`${ONE_MACHINE}&test=a`)
    await waitFor(() => expect(dataTraces()).toHaveLength(1))
    await openForm('a - m1', 1)
    const user = userEvent.setup()

    await user.type(titleInput(), 'Slow')
    await user.click(details().getByRole('button', { name: 'Cancel' }))

    expect(details().queryByRole('form')).not.toBeInTheDocument()
    expect(createButton()).toHaveFocus()
    await user.click(createButton())
    expect(titleInput()).toHaveValue('')
    expect(requests).toEqual([])
  })

  it('needs triage scope', async () => {
    signIn('submit')
    mockWorld()
    renderPage(`${ONE_MACHINE}&test=a`)
    await waitFor(() => expect(dataTraces()).toHaveLength(1))
    draw()
    click('a - m1', 1)

    await waitFor(() =>
      expect(createButton()).toHaveAttribute(
        'title',
        "Needs an API token with the 'triage' scope. The token in Settings has the 'submit' scope.",
      ),
    )
    expect(createButton()).toBeDisabled()
  })

  it('says why it failed, keeping the title and the focus; Escape cancels, then closes', async () => {
    signIn('triage')
    mockWorld()
    let tries = 0
    server.use(
      mockApi('post', '/api/suites/{testsuite}/regressions', () => {
        tries++
        return errorResponse(404, 'not_found', 'No such commit.')
      }),
    )
    renderPage(`${ONE_MACHINE}&test=a`)
    await waitFor(() => expect(dataTraces()).toHaveLength(1))
    await openForm('a - m1', 1)
    const user = userEvent.setup()

    await user.type(titleInput(), 'Slow')
    await user.click(confirmButton())

    expect(await details().findByRole('alert')).toHaveTextContent('No such commit.')
    expect(confirmButton()).toBeEnabled()
    expect(confirmButton()).toHaveFocus()
    expect(titleInput()).toHaveValue('Slow')

    // From the title, Enter tries again.
    await user.type(titleInput(), '{Enter}')
    await waitFor(() => expect(tries).toBe(2))
    expect(await details().findByRole('alert')).toBeInTheDocument()
    expect(titleInput()).toHaveFocus()

    // Escape cancels the form, rather than close the details, and forgets the failure.
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(details().queryByRole('form')).not.toBeInTheDocument()
    expect(details().queryByRole('alert')).not.toBeInTheDocument()
    expect(createButton()).toHaveFocus()
    // Another closes the details.
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

/** The chips of the baselines. */
function baselineChips() {
  return main().getByRole('list', { name: 'Baselines added' })
}

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
    // Before the traces, so that the points on a line keep their tooltips and details (GR9).
    expect(drawn()).toEqual([
      'a - baseline libcxx/m1/r10',
      'b - baseline libcxx/m1/r10',
      'a - m1',
      'b - m1',
    ])
    const line = curve('a - m1') as PlotData
    const a = curve('a - baseline libcxx/m1/r10') as PlotData
    expect(a.x).toHaveLength(101)
    expect(a.line.dash).toBe('dash')
    expect(a.line.color).toBe(line.line.color)
    expect(hoverText(a, 0)).toContain('Suite: libcxx<br>Machine: m1<br>Commit: r10<br>Test: a')
    // Every test's data at the commit, without `has_ordinal`, which leaves in commits without an
    // ordinal.
    const baseline = recorded.series.find(({ query }) => query.has('commit'))
    expect(baseline?.query.toString()).toBe('metric=execution_time&machine=m1&commit=c10')
    const chips = within(baselineChips())
    expect(chips.getByRole('listitem')).toHaveTextContent('libcxx/m1/r10')
  })

  it("does not wait for the traces' requests, even when they take every turn (GR2)", async () => {
    const held = gate()
    const names = ['a', 't1', 't2', 't3', 't4', 't5']
    const recorded = mockWorld({ machines: ['m1'], tests: { m1: names } })
    // Every trace's body held, as a large selection keeps them, and the baseline's answered.
    answerSeries(recorded, (asked) =>
      asked.has('commit')
        ? ndjsonResponse([[pointOf('m1', 'a', ['c10', 'r1', 1])]])
        : ndjsonResponse([], { wait: () => held.promise }),
    )
    const tests = names.map((name) => `&test=${name}`).join('')
    renderPage(`${ONE_MACHINE}${tests}&baseline=libcxx/m1/c10`)

    await waitFor(() => expect(baselineLines()).toEqual(['a - baseline libcxx/m1/r10: 1']))
    const traces = recorded.series.filter(({ query }) => !query.has('commit'))
    expect(traces).toHaveLength(6)
    expect(traces.every(({ signal }) => !signal.aborted)).toBe(true)
    act(() => held.open())
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
    const baselines = recorded.series.filter(({ query }) => query.has('commit'))
    expect(baselines.map(({ query }) => query.get('commit'))).toEqual(['c20'])
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

  it("is added from a point's details, and removed, which stay open with the focus", async () => {
    const recorded = mockWorld()
    renderPage(`${GRAPHED}&test=a&test=b&baseline=libcxx/m2/c40`)
    await waitFor(() => expect(baselineLines()).toEqual(['b - baseline libcxx/m2/r40: 4']))
    draw()
    const user = userEvent.setup()

    click('a - m1', 1)
    await user.click(details().getByRole('button', { name: 'Add as baseline' }))

    // Besides the baselines added before.
    expect(query().baseline).toEqual(['libcxx/m2/c40', 'libcxx/m1/c20'])
    expect(baselineChips()).toHaveTextContent(/^libcxx\/m2\/r40×libcxx\/m1\/r20×$/)
    const remove = details().getByRole('button', { name: 'Remove the baseline' })
    expect(remove).toHaveFocus()
    await waitFor(() =>
      expect(baselineLines()).toEqual([
        'b - baseline libcxx/m2/r40: 4',
        'a - baseline libcxx/m1/r20: 2',
      ]),
    )
    // Its point shows that the machine has runs at the commit, which is not looked up (GR9): only
    // its data is asked for.
    expect(recorded.lookups).not.toContain('m1/c20')
    const asked = recorded.series.filter(({ query }) => query.get('commit') === 'c20')
    expect(asked.map(({ query }) => query.get('machine'))).toEqual(['m1'])

    await user.click(remove)

    expect(query().baseline).toEqual(['libcxx/m2/c40'])
    expect(baselineLines()).toEqual(['b - baseline libcxx/m2/r40: 4'])
    expect(details().getByRole('button', { name: 'Add as baseline' })).toHaveFocus()

    // The details of a point that is a baseline already remove it.
    click('b - m2', 0)
    await user.click(details().getByRole('button', { name: 'Remove the baseline' }))
    expect(query().baseline).toBeUndefined()
    expect(details().getByRole('button', { name: 'Add as baseline' })).toHaveFocus()
  })

  it("removes a baseline from its point's details while it is still being checked", async () => {
    mockWorld()
    const checked = gate()
    mockCommits(async (query) => {
      const only = query.get('commit')
      if (only !== null) await checked.promise
      const listed = COMMITS.m1.map(commitAt)
      return cursorPage(only === null ? listed : listed.filter((entry) => entry.value === only))
    })
    renderPage(`${ONE_MACHINE}&test=a&baseline=libcxx/m1/c20`)
    await waitFor(() => expect(dataTraces()).toHaveLength(1))
    draw()

    click('a - m1', 1)
    expect(baselineChips()).toHaveTextContent('libcxx/m1/c20')
    await userEvent
      .setup()
      .click(details().getByRole('button', { name: 'Remove the baseline' }))

    expect(query().baseline).toBeUndefined()
    checked.open()
  })

  it('keeps the baselines and the regression mode on a new suite', async () => {
    mockWorld()
    renderPage(`${ONE_MACHINE}&baseline=libcxx/m1/c10&regressions=active`)
    await waitFor(() =>
      expect(baselineChips()).toHaveTextContent('r10'),
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
    answerSeries(recorded, (asked) =>
      asked.has('commit') && failing
        ? errorResponse(500, 'internal_error', 'The baseline broke.')
        : ndjsonResponse([[pointOf('m1', 'a', ['c10', 'r1', 1])]]),
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

/** The traces of the circles around the points at the highlighted commits (GR16). */
function circleTraces() {
  return (chart().data as PlotData[]).filter((trace) => trace.name.endsWith(' - highlighted'))
}

/** The circles around the points at the highlighted commits, as `name: commit=value...`. */
function highlightCircles() {
  return circleTraces().map((trace) => {
    const points = (trace.x as string[]).map((x, i) => `${x}=${(trace.y as number[])[i]}`)
    return `${trace.name}: ${points.join(' ')}`
  })
}

/** The commits of the highlighted commits' bands (GR16). */
function bands() {
  return layout()
    .shapes?.filter((shape) => shape.type === 'rect')
    .map((shape) => shape.xanchor)
}

function highlightChip() {
  return main().getByRole('list', { name: 'Highlighted commits' })
}

describe('the highlighted commits (GR16)', () => {
  const HIGHLIGHTED: Record<string, Sample[]> = {
    'm1/a': [
      ['c10', 'r1', 1],
      ['c20', 'r2', 2],
    ],
    'm1/b': [['c10', 'r1', 3]],
    'm2/b': [
      ['c20', 'r3', 4],
      ['c40', 'r4', 5],
    ],
  }

  it("draws a band at the commit, under its regressions, circling each trace's point", async () => {
    mockWorld({ samples: HIGHLIGHTED })
    mockRegressionWorld()
    renderPage(`${GRAPHED}&test=a&test=b&regressions=all&highlight=c20`)

    await waitFor(() =>
      expect(highlightCircles()).toEqual([
        'a - m1 - highlighted: c20=2',
        'b - m2 - highlighted: c20=4',
      ]),
    )
    // Over the traces, which keep their own points, tooltips and details.
    expect(drawn().slice(0, 5)).toEqual([
      'a - m1',
      'b - m1',
      'b - m2',
      'a - m1 - highlighted',
      'b - m2 - highlighted',
    ])
    await waitFor(() => expect(markers()).toHaveLength(2))
    // The band first, which the regressions' lines at its commit are drawn over.
    expect(layout().shapes?.map((shape) => [shape.type, shape.xanchor ?? shape.x0])).toEqual([
      ['rect', 'c20'],
      ['line', 'c20'],
      ['line', 'c20'],
    ])
    expect(highlightChip()).toHaveTextContent(/^Highlighted: r20×$/)

    draw()
    click('a - m1', 1)
    expect(details().getByText('r20')).toBeInTheDocument()
  })

  it('fades the circles with their trace when a test row is hovered', async () => {
    mockWorld({ samples: HIGHLIGHTED })
    renderPage(`${GRAPHED}&test=a&test=b&highlight=c20`)
    await waitFor(() => expect(highlightCircles()).toHaveLength(2))

    fireEvent.mouseEnter(testTable().getByText('b').closest('tr')!)

    expect(circleTraces().map((trace) => [trace.name, trace.opacity])).toEqual([
      ['a - m1 - highlighted', 0.2],
      ['b - m2 - highlighted', undefined],
    ])
  })

  it('is no point: the chart still has nothing to plot', async () => {
    mockWorld()
    renderPage(`${GRAPHED}&highlight=c20`)

    await waitFor(() => expect(layout().annotations?.[0]?.text).toBe('No data to plot'))
    expect(bands()).toEqual(['c20'])
    expect(highlightCircles()).toEqual([])
  })

  it('is drawn only while on the x-axis, kept as the machines and the rest change', async () => {
    mockWorld({ samples: HIGHLIGHTED })
    renderPage(`${GRAPHED}&test=b&highlight=c40`)
    await waitFor(() => expect(highlightCircles()).toEqual(['b - m2 - highlighted: c40=5']))
    expect(bands()).toEqual(['c40'])
    expect(highlightChip()).toHaveTextContent(/^Highlighted: r40×$/)
    const user = userEvent.setup()

    // Only m2 has runs at c40.
    await user.click(screen.getByRole('button', { name: 'Remove m2' }))
    await waitFor(() => expect(bands()).toEqual([]))
    expect(highlightCircles()).toEqual([])
    // Kept, by its commit string, which the x-axis no longer gives the display value of.
    expect(highlightChip()).toHaveTextContent(/^Highlighted: c40×$/)

    await pickOption('Metric', 'Compile Time')
    await pickOption('Run aggregation', 'max')
    await addMachine('m2')
    await waitFor(() => expect(bands()).toEqual(['c40']))
    expect(highlightChip()).toHaveTextContent(/^Highlighted: r40×$/)
    expect(query()).toMatchObject({
      machine: ['m1', 'm2'],
      metric: ['compile_time'],
      run_agg: ['max'],
      highlight: ['c40'],
    })
  })

  it('is removed with its chip, which gives the focus to the next chip, or before', async () => {
    mockWorld({ samples: HIGHLIGHTED })
    renderPage(`${ONE_MACHINE}&test=a&highlight=c10&highlight=c20&highlight=c30`)
    await waitFor(() => expect(highlightCircles()).toEqual(['a - m1 - highlighted: c10=1 c20=2']))
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Remove the highlight of r10' }))
    expect(query().highlight).toEqual(['c20', 'c30'])
    expect(bands()).toEqual(['c20', 'c30'])
    expect(highlightCircles()).toEqual(['a - m1 - highlighted: c20=2'])
    expect(screen.getByRole('button', { name: 'Remove the highlight of r20' })).toHaveFocus()

    // The last one gives it to the one before.
    await user.click(screen.getByRole('button', { name: 'Remove the highlight of r30' }))
    expect(query().highlight).toEqual(['c20'])
    expect(screen.getByRole('button', { name: 'Remove the highlight of r20' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Remove the highlight of r20' }))
    expect(query().highlight).toBeUndefined()
    expect(bands()).toEqual([])
    expect(highlightCircles()).toEqual([])
    expect(main().queryByRole('list', { name: 'Highlighted commits' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Add a baseline' })).toHaveFocus()
  })

  it("leaves a point's details open when its chip is removed from the keyboard", async () => {
    mockWorld({ samples: HIGHLIGHTED })
    renderPage(`${ONE_MACHINE}&test=a&highlight=c20`)
    await waitFor(() => expect(highlightCircles()).toHaveLength(1))
    draw()

    click('a - m1', 1)
    // A click without a press, as from the keyboard, unlike a press outside the details.
    fireEvent.click(screen.getByRole('button', { name: 'Remove the highlight of r20' }))

    await waitFor(() => expect(bands()).toEqual([]))
    // Its band and circles neither move nor hide a point (GR11).
    expect(details().getByRole('button', { name: 'Highlight this commit' })).toBeInTheDocument()
  })

  it("is added from a point's details, and removed, which stay open with the focus", async () => {
    mockWorld({ samples: HIGHLIGHTED })
    renderPage(`${GRAPHED}&test=a&test=b&highlight=c40`)
    await waitFor(() => expect(highlightCircles()).toEqual(['b - m2 - highlighted: c40=5']))
    draw()
    const user = userEvent.setup()

    click('a - m1', 1)
    await user.click(details().getByRole('button', { name: 'Highlight this commit' }))

    // Besides the commits highlighted before.
    expect(query().highlight).toEqual(['c40', 'c20'])
    expect(bands()).toEqual(['c40', 'c20'])
    expect(highlightCircles()).toEqual([
      'a - m1 - highlighted: c20=2',
      'b - m2 - highlighted: c20=4 c40=5',
    ])
    expect(highlightChip()).toHaveTextContent(/^Highlighted: r40×Highlighted: r20×$/)
    const remove = details().getByRole('button', { name: 'Remove the highlight' })
    expect(remove).toHaveFocus()

    await user.click(remove)

    expect(query().highlight).toEqual(['c40'])
    expect(bands()).toEqual(['c40'])
    expect(highlightCircles()).toEqual(['b - m2 - highlighted: c40=5'])
    expect(details().getByRole('button', { name: 'Highlight this commit' })).toHaveFocus()
  })

  it('highlights at most 10 commits, saying why no other can be, each once', async () => {
    mockWorld({ samples: HIGHLIGHTED })
    const others = Array.from({ length: 10 }, (_, i) => `x${i}`)
    // A commit named twice counts once, and of more than 10, only the first 10 are kept.
    const named = ['c10', 'c10', ...others].map((value) => `&highlight=${value}`).join('')
    renderPage(`${ONE_MACHINE}&test=a${named}`)
    await waitFor(() => expect(bands()).toEqual(['c10']))
    expect(query().highlight).toEqual(['c10', ...others.slice(0, 9)])
    expect(within(highlightChip()).getAllByRole('listitem')).toHaveLength(10)
    expect(highlightChip()).toHaveTextContent(/^Highlighted: r10×Highlighted: x0×.*x8×$/)
    draw()

    click('a - m1', 1)
    const add = () => details().getByRole('button', { name: 'Highlight this commit' })
    expect(add()).toBeDisabled()
    expect(add()).toHaveAccessibleDescription('At most 10 commits can be highlighted at once.')
    // Once one is removed, another can be highlighted. A click without a press leaves the
    // details open.
    fireEvent.click(screen.getByRole('button', { name: 'Remove the highlight of x0' }))
    expect(add()).toBeEnabled()

    // One highlighted already can be removed.
    click('a - m1', 0)
    await userEvent.setup().click(details().getByRole('button', { name: 'Remove the highlight' }))
    expect(query().highlight).toEqual(others.slice(1, 9))
  })

  it('shows no chip until a suite is selected, which then clears it', async () => {
    mockWorld()
    renderPage('/graph?highlight=c20')
    await waitFor(() => expect(selectButton('Suite')).toBeEnabled())
    expect(main().queryByRole('list', { name: 'Highlighted commits' })).toBeNull()
    expect(query().highlight).toEqual(['c20'])

    await pickOption('Suite', 'libcxx')

    await waitFor(() => expect(query()).toEqual({ suite: ['libcxx'] }))
  })
})

describe('the markers of the points (GR1)', () => {
  /** 201 commits on each machine: one more than are marked in view (MARKED_COMMITS). */
  const ORDINALS = Array.from({ length: 201 }, (_, i) => i + 1)
  const LONG = {
    commits: { m1: ORDINALS, m2: ORDINALS },
    tests: { m1: ['a', 'b'], m2: ['a', 'b'] },
    samples: {
      'm1/a': ORDINALS.map((i): Sample => [`c${i}`, `r${i}`, i]),
      'm2/a': ORDINALS.map((i): Sample => [`c${i}`, `s${i}`, i]),
      // A single point, which keeps its marker.
      'm1/b': [['c5', 'r5', 1]] satisfies Sample[],
    },
  }

  /** The whole x-axis in the plot, as GEOMETRY's area is: 2.5 pixels per commit. */
  const FULL: PlotGeometry = { ...GEOMETRY, x: (value) => 50 + 2.5 * value }
  /** Zoomed in on positions 10 to 15. */
  const ZOOMED: PlotGeometry = { ...GEOMETRY, x: (value) => 50 + 100 * (value - 10) }

  /** How each trace is drawn, by name. */
  function modes() {
    return Object.fromEntries(
      (chart().data as PlotData[]).map((trace) => [trace.name, trace.mode]),
    )
  }

  it("draws lines alone while more than 200 commits are in view, but a single point's marker", async () => {
    mockWorld(LONG)
    renderPage(`${ONE_MACHINE}&test=a&test=b`)
    await waitFor(() => expect(drawn()).toEqual(['a - m1', 'b - m1']))

    expect(modes()).toEqual({ 'a - m1': 'lines', 'b - m1': 'lines+markers' })
    draw(FULL)
    expect(modes()).toEqual({ 'a - m1': 'lines', 'b - m1': 'lines+markers' })

    // Drawn again with markers, from the data built already.
    const { x, customdata } = curve('a - m1') as PlotData
    draw(ZOOMED)
    expect(modes()).toEqual({ 'a - m1': 'lines+markers', 'b - m1': 'lines+markers' })
    expect((curve('a - m1') as PlotData).x).toBe(x)
    expect((curve('a - m1') as PlotData).customdata).toBe(customdata)

    draw(FULL)
    expect(modes()).toEqual({ 'a - m1': 'lines', 'b - m1': 'lines+markers' })
  })

  it('counts the commits in view on the x-axis drawn last, not on one drawn before', async () => {
    mockWorld(LONG)
    renderPage(`${ONE_MACHINE}&test=a`)
    await waitFor(() => expect(drawn()).toEqual(['a - m1']))
    draw(ZOOMED)
    expect(modes()).toEqual({ 'a - m1': 'lines+markers' })

    // Another machine's scaffold resets the zoom: every commit is in view until the chart is drawn.
    await addMachine('m2')
    await waitFor(() => expect(drawn()).toEqual(['a - m1', 'a - m2']))
    expect(modes()).toEqual({ 'a - m1': 'lines', 'a - m2': 'lines' })
    draw(ZOOMED)
    expect(modes()).toEqual({ 'a - m1': 'lines+markers', 'a - m2': 'lines+markers' })
  })

  it("builds a trace's data once, whatever other traces arrive", async () => {
    mockWorld()
    renderPage(`${ONE_MACHINE}&test=a`)
    await waitFor(() => expect(drawn()).toEqual(['a - m1']))
    const { customdata } = curve('a - m1') as PlotData

    await userEvent.setup().click(testTable().getByRole('checkbox', { name: 'b' }))
    await waitFor(() => expect(drawn()).toEqual(['a - m1', 'b - m1']))
    expect((curve('a - m1') as PlotData).customdata).toBe(customdata)
  })

  it("builds a trace's data again when its machine's symbol changes", async () => {
    // m1's commits, held: only m2's traces are drawn, on m2's commits alone.
    const held = gate()
    mockWorld()
    mockCommits(async (query) => {
      const name = query.get('machine') as 'm1' | 'm2'
      if (name === 'm1') await held.promise
      return cursorPage(COMMITS[name].map(commitAt))
    })
    renderPage(`${GRAPHED}&test=b`)
    await waitFor(() => expect(drawn()).toEqual(['b - m2']))
    const symbols = () => (chart().data as PlotData[]).map((trace) => trace.marker.symbol)
    expect(symbols()).toEqual(['triangle-up'])

    // Once m1 is removed, m2 is the first machine, on the same x-axis: its trace, whose points stay
    // the same, takes the first symbol.
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove m1' }))
    await waitFor(() => expect(symbols()).toEqual(['circle']))
    act(() => held.open())
  })

  it('keeps the data of the traces drawn only', async () => {
    mockWorld()
    renderPage(`${ONE_MACHINE}&test=a`)
    await waitFor(() => expect(drawn()).toEqual(['a - m1']))
    const { customdata } = curve('a - m1') as PlotData
    const user = userEvent.setup()

    // Selected again, the test's points are those computed already, but its data is built again,
    // since nothing kept it once it was no longer drawn.
    await user.click(testTable().getByRole('checkbox', { name: 'a' }))
    await waitFor(() => expect(drawn()).toEqual([]))
    await user.click(testTable().getByRole('checkbox', { name: 'a' }))
    await waitFor(() => expect(drawn()).toEqual(['a - m1']))
    expect((curve('a - m1') as PlotData).customdata).not.toBe(customdata)
    expect((curve('a - m1') as PlotData).customdata).toEqual(customdata)
  })
})
