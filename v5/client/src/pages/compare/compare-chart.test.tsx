import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { act } from 'react'
import type { PlotHoverEvent, PlotMouseEvent, PlotRelayoutEvent } from 'plotly.js'
import { describe, expect, it, vi } from 'vitest'
import { formatTimestamp, shortUuid } from '../../format'
import { cursorPage, sample, uuidOf } from '../../test/fixtures'
import { mockApi } from '../../test/mock-api'
import { gate, main, query, renderPage, search } from '../../test/page'
import { pickOption } from '../../test/select'
import { server } from '../../test/server'
import type { PlotGeometry } from '../../components/chart'
import { barsOf, chart, COMPARED, comparison, mockWorld, NOISY, runBox, showBox } from './compare-world'

// The tests check what the page hands Plotly to draw (see test/chart.tsx).
vi.mock('../../components/chart', () => import('../../test/chart'))

describe('the chart (CP3)', () => {
  it('plots a bar per compared test that can be, by ratio', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()

    // b and c have a value on one side only.
    expect(barsOf()).toEqual([Math.log2(1.005), Math.log2(1.5)])

    await userEvent.setup().click(showBox('d'))
    await waitFor(() => expect(barsOf()).toEqual([Math.log2(1.005)]))
  })

  it("draws the Delta % knob's noise band", async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&noise_pct=5`)
    await comparison()

    expect(chart().layout.shapes?.map((shape) => shape.y0)).toEqual([
      Math.log2(1.05),
      Math.log2(0.95),
    ])
  })

  it('says when there is nothing to plot', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&hidden_test=a&hidden_test=d`)
    await comparison()

    expect(chart().layout.annotations?.[0].text).toBe('No data to plot')
    expect(screen.getByRole('img', { name: 'Ratio of B to A by test: no data to plot' }))
  })

  it('labels the y-axis with the percentage changes of the range zoomed to, until reset', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()
    const ticks = () => chart().layout.yaxis?.ticktext

    expect(ticks()).toContain('+50%')
    act(() =>
      chart().onRelayout?.({
        'yaxis.range[0]': Math.log2(0.98),
        'yaxis.range[1]': Math.log2(1.02),
      } as PlotRelayoutEvent),
    )
    expect(ticks()).toContain('+1%')
    expect(ticks()).not.toContain('+50%')

    act(() => chart().onRelayout?.({ 'yaxis.autorange': true } as PlotRelayoutEvent))
    expect(ticks()).toContain('+50%')
  })

  it('keeps a zoom across settings, until the comparison is replaced', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()
    const user = userEvent.setup()
    const ticks = () => chart().layout.yaxis?.ticktext
    const zoom = () =>
      act(() =>
        chart().onRelayout?.({
          'yaxis.range[0]': Math.log2(0.98),
          'yaxis.range[1]': Math.log2(1.02),
        } as PlotRelayoutEvent),
      )

    zoom()
    const zoomed = ticks()
    const revision = chart().layout.uirevision
    await pickOption('Sample aggregation', 'max')
    search('Filter tests', 'a')
    await user.click(screen.getByRole('checkbox', { name: 'Hide noise' }))
    await waitFor(() => expect(query()).toMatchObject({ hide_noise: ['true'], test_filter: ['a'] }))
    expect(ticks()).toEqual(zoomed)
    expect(chart().layout.uirevision).toBe(revision)

    // Swapped there and back: Plotly forgets the zoom as soon as the comparison is another.
    await user.click(screen.getByRole('button', { name: 'Swap sides' }))
    await user.click(screen.getByRole('button', { name: 'Swap sides' }))
    await waitFor(() => expect(ticks()).not.toEqual(zoomed))

    zoom()
    await user.click(runBox('2', 'A'))
    await waitFor(() => expect(ticks()).not.toEqual(zoomed))
  })

  it('plots only the tests the filter keeps', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()

    search('Filter tests', 'd')

    await waitFor(() => expect(barsOf()).toEqual([Math.log2(1.5)]))
  })

  it('highlights the row of the bar hovered, and outlines the bar of the row hovered', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()
    const row = (test: string) => screen.getByRole('cell', { name: test }).closest('tr')
    const event = (index: number) =>
      ({ points: [{ data: chart().data[0], pointNumber: index }] }) as unknown as PlotMouseEvent &
        PlotHoverEvent
    // Where the plot draws, as the chart reports it once drawn: a slot of 100 pixels per bar.
    const geometry: PlotGeometry = {
      area: { left: 0, top: 0, width: 200, height: 100 },
      x: (value) => 50 + 100 * value,
      y: (value) => 50 - 50 * value,
    }
    act(() => chart().onDraw?.(geometry))
    const outline = () => document.querySelector('svg rect')

    act(() => chart().onHover?.(event(1)))
    expect(row('d')).toHaveClass('hoveredRow')
    act(() => chart().onUnhover?.(event(1)))
    expect(row('d')).not.toHaveClass('hoveredRow')

    const data = chart().data
    fireEvent.mouseEnter(screen.getByRole('cell', { name: 'a' }).closest('tr')!)
    // a's bar, the first, as wide as the bar itself.
    expect(outline()).toHaveAttribute('x', '5')
    expect(outline()).toHaveAttribute('width', '90')
    // The bars themselves are left as they are.
    expect(chart().data).toBe(data)

    // b has no bar to outline.
    fireEvent.mouseEnter(screen.getByRole('cell', { name: 'b' }).closest('tr')!)
    expect(outline()).toBeNull()
    const d = screen.getByRole('cell', { name: 'd' }).closest('tr')!
    const box = screen.getByRole('table', { name: 'Comparison' }).parentElement!
    fireEvent.mouseEnter(d)
    fireEvent.mouseLeave(box)
    expect(outline()).toBeNull()
    // Nor once the pointer moves from a row to the header, or to the box's scrollbar, whose events
    // target the box itself.
    fireEvent.mouseEnter(d)
    expect(outline()).not.toBeNull()
    fireEvent.mouseOver(screen.getByRole('columnheader', { name: 'Test' }))
    expect(outline()).toBeNull()
    fireEvent.mouseEnter(d)
    expect(outline()).not.toBeNull()
    fireEvent.mouseOver(box)
    expect(outline()).toBeNull()
    // Nor once it moves to the geomean's row, which has no bar.
    fireEvent.mouseEnter(d)
    expect(outline()).not.toBeNull()
    fireEvent.mouseOver(screen.getByRole('cell', { name: 'Geomean' }))
    expect(outline()).toBeNull()
  })
})

describe('the details of a bar (CP3)', () => {
  /**
   * COMPARED, with several samples of a test in a run: a's bar comes first, at 1.5, d's second, at
   * 3, b and c being on one side only.
   */
  const WORLD = {
    samples: {
      '1': [
        ['a', 3],
        ['a', 1],
        ['b', 2],
        ['d', 1],
      ],
      '2': [
        ['a', 2],
        ['d', 1],
      ],
      '3': [
        ['a', 4],
        ['a', 2],
        ['c', 5],
        ['d', 3],
      ],
      '4': [['a', 1]],
    } as Record<string, [string, number][]>,
  }

  /** Where the plot draws: a slot of 100 pixels per bar, the plot's middle at 100. */
  const GEOMETRY: PlotGeometry = {
    area: { left: 0, top: 10, width: 200, height: 100 },
    x: (value) => 50 + 100 * value,
    y: (value) => 50 - 10 * value,
  }

  /** A Plotly event on point `index` of the `trace`th trace: the bars, then the shadows' lines. */
  const eventOn = (index: number, trace = 0, init: MouseEventInit = {}) =>
    ({
      points: [{ data: chart().data[trace], pointNumber: index }],
      event: new MouseEvent('click', init),
    }) as unknown as PlotMouseEvent & PlotHoverEvent

  /** Click point `index` of the `trace`th trace, and say whether the click opened details. */
  function click(index: number, trace = 0, init?: MouseEventInit) {
    let opened: boolean | void = undefined
    act(() => {
      opened = chart().onClick?.(eventOn(index, trace, init))
    })
    return opened
  }

  /** Render `url`, once the comparison shows and the chart has been drawn. */
  async function shown(url = COMPARED) {
    renderPage(url)
    await comparison()
    act(() => chart().onDraw?.(GEOMETRY))
  }

  const dialog = () => screen.queryByRole('dialog')
  /** The side of its anchor that `opened` is on, from where it is moved to (see ChartDialog). */
  const sideOf = (opened: HTMLElement) =>
    opened.style.transform.startsWith('translate(12px') ? 'right' : 'left'
  const details = () => within(screen.getByRole('dialog'))
  /** The rows of the runs table of `side`, without its header, as the text of their cells. */
  const runsOf = (side: 'A' | 'B') =>
    within(details().getByRole('table', { name: `Side ${side} runs` }))
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent))

  it('opens beside the bar clicked, with its values, the runs and samples of both sides', async () => {
    const sampled = mockWorld(WORLD)
    await shown()
    const asked = sampled.length

    expect(click(0)).toBe(true)

    const opened = screen.getByRole('dialog', { name: 'a' })
    expect(opened).toHaveFocus()
    // Right of a's bar, which ends at 95, in the left half of the plot, from the top of the plot.
    expect(opened).toHaveStyle({ left: '95px', top: '10px' })
    expect(sideOf(opened)).toBe('right')
    const values = details()
      .getAllByRole('definition')
      .map((value) => value.textContent)
    expect(details().getAllByRole('term').map((label) => label.textContent)).toEqual([
      'Value A',
      'Value B',
      'Delta',
      'Delta %',
      'Ratio',
      'Status',
    ])
    expect(values).toEqual(['2', '3', '1', '+50.00%', '1.5000', 'Regressed'])
    // As the table's cells, with their tooltips.
    const valueA = details().getAllByRole('definition')[0]
    expect(within(valueA).getByText('2')).toHaveAttribute('title', '3 samples across 2 runs')
    // The runs the samples come from, in the order they were measured, each run's ascending.
    expect(runsOf('A')).toEqual([
      [formatTimestamp('2026-08-20T10:00:00Z'), shortUuid(uuidOf('1')), '1 · 3'],
      [formatTimestamp('2026-08-21T10:00:00Z'), shortUuid(uuidOf('2')), '2'],
    ])
    expect(runsOf('B')).toEqual([
      [formatTimestamp('2026-08-20T10:00:00Z'), shortUuid(uuidOf('3')), '2 · 4'],
    ])
    expect(details().getByRole('link', { name: shortUuid(uuidOf('3')) })).toHaveAttribute(
      'href',
      `/suites/libcxx/runs/${uuidOf('3')}`,
    )
    // The samples were all fetched for the comparison already.
    expect(sampled).toHaveLength(asked)
  })

  it("lists only the runs a side's samples for the test come from", async () => {
    mockWorld(WORLD)
    await shown(`${COMPARED}&hidden_test=a`)

    click(0)

    expect(screen.getByRole('dialog', { name: 'd' })).toBeInTheDocument()
    expect(runsOf('A').map(([, run]) => run)).toEqual([
      shortUuid(uuidOf('1')),
      shortUuid(uuidOf('2')),
    ])
    expect(runsOf('B').map(([, , samples]) => samples)).toEqual(['3'])
  })

  it("links to the test's history on the Graph page, in side B's context", async () => {
    mockWorld(WORLD)
    await shown(
      `${COMPARED.replace('machine_b=m1&commit_b=c2', 'machine_b=m2&commit_b=c2')}` +
        '&sample_agg=max&run_agg=min',
    )

    click(0)

    expect(details().getByRole('link', { name: 'View on graph' })).toHaveAttribute(
      'href',
      '/graph?suite=libcxx&machine=m2&metric=execution_time&test=a&run_agg=min&sample_agg=max',
    )
  })

  it('leaves out the aggregations at their default from the link to the Graph page', async () => {
    mockWorld(WORLD)
    await shown()

    click(0)

    expect(details().getByRole('link', { name: 'View on graph' })).toHaveAttribute(
      'href',
      '/graph?suite=libcxx&machine=m1&metric=execution_time&test=a',
    )
  })

  it("links to the test's profiles when its row does, as soon as they are listed", async () => {
    const listed = gate()
    mockWorld({ ...WORLD, profiles: { '1': ['a'], '3': ['a'] } })
    server.use(
      mockApi('get', '/api/suites/{testsuite}/runs/{uuid}/profiles', async () => {
        await listed.promise
      }),
    )
    await shown()

    click(0)
    expect(details().queryByRole('link', { name: 'Profile' })).not.toBeInTheDocument()
    act(() => listed.open())

    // The details stay open as the links arrive.
    const profile = await details().findByRole('link', { name: 'Profile' })
    const row = screen.getByRole('cell', { name: 'a' }).closest('tr')!
    expect(profile).toHaveAttribute(
      'href',
      within(row).getByRole('link', { name: 'Profile' }).getAttribute('href'),
    )
    expect(screen.getByRole('dialog', { name: 'a' })).toHaveFocus()

    // d has no profile.
    fireEvent.pointerDown(main().getByRole('heading', { name: 'Compare' }))
    click(1)
    expect(screen.getByRole('dialog', { name: 'd' })).toBeInTheDocument()
    expect(details().queryByRole('link', { name: 'Profile' })).not.toBeInTheDocument()
  })

  it('closes on Escape, its close button, a press outside it, and a zoom', async () => {
    mockWorld(WORLD)
    await shown()
    const user = userEvent.setup()

    // Closed from the keyboard or its button, they give the focus back to the chart.
    const area = main().getByRole('img').parentElement!
    click(0)
    await user.keyboard('{Escape}')
    expect(dialog()).not.toBeInTheDocument()
    expect(area).toHaveFocus()

    click(0)
    await user.click(details().getByRole('button', { name: 'Close' }))
    expect(dialog()).not.toBeInTheDocument()
    expect(area).toHaveFocus()

    click(0)
    // Moving the focus out does not close them, unlike a press.
    await user.tab()
    expect(dialog()).toBeInTheDocument()
    fireEvent.pointerDown(main().getByRole('heading', { name: 'Compare' }))
    expect(dialog()).not.toBeInTheDocument()

    click(0)
    act(() => chart().onRelayout?.({ 'yaxis.range[0]': 0, 'yaxis.range[1]': 1 } as PlotRelayoutEvent))
    expect(dialog()).not.toBeInTheDocument()
  })

  it('closes on a change to the compared rows, made without a press', async () => {
    mockWorld(WORLD)
    await shown()
    const user = userEvent.setup()

    click(0)
    search('Filter tests', 'a')
    await waitFor(() => expect(dialog()).not.toBeInTheDocument())
    await waitFor(() => expect(barsOf()).toHaveLength(1))
    search('Filter tests', '')
    await waitFor(() => expect(barsOf()).toHaveLength(2))

    // Hiding a test that has no bar changes the compared rows too, a's bar staying.
    click(0)
    showBox('b').focus()
    await user.keyboard(' ')
    await waitFor(() => expect(query().hidden_test).toEqual(['b']))
    expect(dialog()).not.toBeInTheDocument()

    click(0)
    showBox('a').focus()
    await user.keyboard(' ')
    await waitFor(() => expect(barsOf()).toHaveLength(1))
    expect(dialog()).not.toBeInTheDocument()
  })

  it("stays open while a shadow's line arrives", async () => {
    const arrived = gate()
    mockWorld(WORLD)
    server.use(
      mockApi('get', '/api/suites/{testsuite}/runs/{uuid}/samples', async ({ params }) => {
        if (params.uuid !== uuidOf('4')) return
        await arrived.promise
        return HttpResponse.json(cursorPage([sample('a', { execution_time: 1 })]))
      }),
    )
    await shown(`${COMPARED}&shadow=libcxx/m2/c2`)
    expect(chart().data).toHaveLength(1)

    click(0)
    act(() => arrived.open())

    await waitFor(() => expect(chart().data).toHaveLength(2))
    expect(screen.getByRole('dialog', { name: 'a' })).toHaveFocus()
    // A shadow's point has no details, and its click closes those open, as any press elsewhere.
    fireEvent.pointerDown(main().getByRole('img'))
    expect(click(0, 1)).toBe(false)
    expect(dialog()).not.toBeInTheDocument()
  })

  it('opens the details of another bar clicked instead', async () => {
    mockWorld(WORLD)
    await shown()
    click(0)

    // Plotly sees the press first, and reports the click after.
    fireEvent.pointerDown(main().getByRole('img'))
    click(1)

    const opened = screen.getByRole('dialog', { name: 'd' })
    expect(opened).toHaveFocus()
    // Left of d's bar, which starts at 105, in the right half of the plot.
    expect(opened).toHaveStyle({ left: '105px' })
    expect(sideOf(opened)).toBe('left')
  })

  it("starts from no further than the middle of the plot, beside a wide bar", async () => {
    mockWorld(WORLD)
    await shown(`${COMPARED}&hidden_test=d`)
    // a's bar alone, 180 pixels wide, centred left of the plot's middle, at 100.
    act(() => chart().onDraw?.({ ...GEOMETRY, x: (value) => 90 + 200 * value }))

    click(0)

    const opened = screen.getByRole('dialog', { name: 'a' })
    expect(opened).toHaveStyle({ left: '100px' })
    expect(sideOf(opened)).toBe('right')

    // Centred right of the middle, it opens on the left, from the middle again.
    act(() => chart().onDraw?.({ ...GEOMETRY, x: (value) => 110 + 200 * value }))
    expect(opened).toHaveStyle({ left: '100px' })
    expect(sideOf(opened)).toBe('left')
  })

  it("lists only the runs a side selects, though it keeps the others' samples", async () => {
    mockWorld(WORLD)
    await shown()

    await userEvent.setup().click(runBox('2', 'A'))
    await waitFor(() => expect(query().runs_a).toEqual([uuidOf('1')]))
    click(0)

    expect(runsOf('A').map(([, run]) => run)).toEqual([shortUuid(uuidOf('1'))])
  })

  it('opens nothing on a click of another button than the main one', async () => {
    mockWorld(WORLD)
    await shown()

    expect(click(0, 0, { button: 2 })).toBe(false)
    expect(click(0, 0, { button: 1 })).toBe(false)

    expect(dialog()).not.toBeInTheDocument()
  })
})
