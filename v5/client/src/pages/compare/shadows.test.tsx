import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PlotData, PlotHoverEvent, PlotMouseEvent } from 'plotly.js'
import { describe, expect, it, vi } from 'vitest'
import { uuidOf } from '../../test/fixtures'
import { errorResponse, mockApi } from '../../test/mock-api'
import { query, renderPage } from '../../test/page'
import { pick, pickOption } from '../../test/select'
import { server } from '../../test/server'
import { shadowLook } from './chart'
import { barsOf, chart, COMPARED, comparison, mockWorld, runBox, sideOf } from './compare-world'

// The tests check what the page hands Plotly to draw (see test/chart.tsx).
vi.mock('../../components/chart', () => import('../../test/chart'))

/** The shadows' lines drawn: each one's points' log2 ratios, their tests, and its colour. */
function lines() {
  return (chart().data.slice(1) as PlotData[]).map((trace) => ({
    y: trace.y as number[],
    tests: (trace.customdata as unknown as string[][]).map((point) => point[0]),
    color: trace.line.color,
    symbol: trace.marker.symbol,
  }))
}

/** The first shadow's line, if drawn. */
const line = () => lines()[0] as ReturnType<typeof lines>[number] | undefined

/**
 * Side A has one run, 1, at m1's c1. Side B is run 3, m1's at c2, to pin, then run 4, m2's at c2:
 * against A, the shadow's ratios are a 4, b 0.5 and c 2, and run 4's, a 2, b 2 and c 0.5.
 */
const WORLD = {
  runs: { 'm1/c1': ['1'], 'm1/c2': ['3'], 'm2/c2': ['4'] },
  samples: {
    '1': [
      ['a', 1],
      ['b', 1],
      ['c', 1],
    ] as [string, number][],
    '3': [
      ['a', 4],
      ['b', 0.5],
      ['c', 2],
    ] as [string, number][],
    '4': [
      ['a', 2],
      ['b', 2],
      ['c', 0.5],
    ] as [string, number][],
  },
}

/** The shadow of COMPARED's side B, as the URL holds it. */
const SHADOW = '&shadow=libcxx%2Fm1%2Fc2'

/** COMPARED, with side B on m2, and SHADOW pinned. */
const SHADOWED = `${COMPARED.replace('machine_b=m1', 'machine_b=m2')}${SHADOW}`

const pinButton = () => screen.queryByRole('button', { name: 'Pin as shadow' })
const chips = () =>
  within(screen.getByRole('list', { name: 'Shadows' }))
    .queryAllByRole('listitem')
    .map((chip) => chip.textContent?.replace(/×$/, ''))
const noChips = () => screen.queryByRole('list', { name: 'Shadows' }) === null
const dismissButton = (label: string) =>
  screen.getByRole('button', { name: `Dismiss the shadow ${label}` })

describe('the shadows (CP8)', () => {
  it('pins side B, drawn as a line sorted by its own ratios once side B changes', async () => {
    mockWorld(WORLD)
    renderPage(COMPARED)
    await comparison()

    const user = userEvent.setup()
    await user.click(pinButton()!)
    expect(chips()).toEqual(['●Shadow: libcxx/m1/c2 · 3 tests'])
    expect(dismissButton('libcxx/m1/c2')).toHaveFocus()
    expect(query().shadow).toEqual(['libcxx/m1/c2'])
    // Side B as it is cannot be pinned twice.
    expect(pinButton()).toBeDisabled()
    expect(pinButton()).toHaveAccessibleDescription('Side B is pinned already.')

    await pick('Machine', 'm2', sideOf('B'))
    await waitFor(() => expect(line()?.tests).toEqual(['b', 'c', 'a']))
    expect(line()?.y).toEqual([-1, 1, 2])
    expect((chart().data[1] as PlotData).hovertemplate).toContain('%{customdata[5]}')
    expect((chart().data[1] as PlotData).customdata[0]).toContain('Shadow: libcxx/m1/c2')
    // The bars are the main comparison's, which the x-axis title counts.
    expect(barsOf()).toEqual([-1, 1, 1])
    expect(chart().layout.xaxis?.title).toEqual({ text: '3 tests, by ratio' })
    expect(pinButton()).toBeEnabled()
  })

  it('pins another shadow once side B changes, each with its colour, marker and chip', async () => {
    mockWorld(WORLD)
    renderPage(SHADOWED)
    await waitFor(() => expect(line()).toBeDefined())

    const user = userEvent.setup()
    await user.click(pinButton()!)
    expect(query().shadow).toEqual(['libcxx/m1/c2', 'libcxx/m2/c2'])
    expect(chips()).toEqual(['●Shadow: libcxx/m1/c2 · 3 tests', '▲Shadow: libcxx/m2/c2 · 3 tests'])
    expect(dismissButton('libcxx/m2/c2')).toHaveFocus()

    await waitFor(() => expect(lines()).toHaveLength(2))
    expect(lines().map(({ y }) => y)).toEqual([
      [-1, 1, 2],
      [-1, 1, 1],
    ])
    expect(lines().map(({ color, symbol }) => ({ color, symbol }))).toEqual(
      [0, 1].map((i) => ({ color: shadowLook(i).color, symbol: shadowLook(i).marker.symbol })),
    )
  })

  it('pins at most five shadows', async () => {
    mockWorld({ ...WORLD, runs: { ...WORLD.runs, 'm1/c1': ['1', '2'] } })
    const [one, two] = [uuidOf('1'), uuidOf('2')]
    const pinned = ['m1/c1', `m1/c1/${one}`, `m1/c1/${two}`, 'm1/c2', 'm2/c2']
    renderPage(`${COMPARED}${pinned.map((spec) => `&shadow=libcxx/${spec}`).join('')}`)
    await comparison()

    expect(pinButton()).toBeDisabled()
    expect(pinButton()).toHaveAccessibleDescription('At most 5 shadows can be pinned.')
    expect(query().shadow).toHaveLength(5)
  })

  it('is restored from the URL, without fetching any sample twice', async () => {
    const sampled = mockWorld(WORLD)
    renderPage(SHADOWED)

    await waitFor(() => expect(line()?.y).toEqual([-1, 1, 2]))
    expect(chips()).toEqual(['●Shadow: libcxx/m1/c2 · 3 tests'])
    expect([...sampled].sort()).toEqual(['1', '3', '4'])
    // Only pinning one gives the focus to its chip.
    expect(dismissButton('libcxx/m1/c2')).not.toHaveFocus()
  })

  it('plots only the tests the chart plots', async () => {
    mockWorld(WORLD)
    renderPage(`${SHADOWED}&hidden_test=a`)

    await waitFor(() => expect(line()?.tests).toEqual(['b', 'c']))
    expect(chips()).toEqual(['●Shadow: libcxx/m1/c2 · 2 tests'])
  })

  it('counts its tests only once there is a comparison and its samples have arrived', async () => {
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    mockWorld(WORLD)
    // Holding the shadow's run back, then answering as the world does.
    server.use(
      mockApi('get', '/api/suites/{testsuite}/runs/{uuid}/samples', async ({ params }) => {
        if (params.uuid === uuidOf('3')) await held
      }),
    )
    renderPage(SHADOWED)
    await comparison()
    expect(chips()).toEqual(['●Shadow: libcxx/m1/c2'])

    release()
    await waitFor(() => expect(chips()).toEqual(['●Shadow: libcxx/m1/c2 · 3 tests']))
  })

  it('counts no test when the chart plots none', async () => {
    mockWorld(WORLD)
    renderPage(`${SHADOWED}&hidden_test=a&hidden_test=b&hidden_test=c`)

    await waitFor(() => expect(chips()).toEqual(['●Shadow: libcxx/m1/c2 · 0 tests']))
    expect(line()).toBeUndefined()
    expect(chart().layout.xaxis?.title).toEqual({ text: 'Tests, by ratio' })
  })

  it('is dismissed with its chip, which gives the focus to the pin button once none is left', async () => {
    mockWorld(WORLD)
    renderPage(SHADOWED)
    await waitFor(() => expect(line()).toBeDefined())

    await userEvent.setup().click(dismissButton('libcxx/m1/c2'))
    await waitFor(() => expect(noChips()).toBe(true))
    expect(query().shadow).toBeUndefined()
    expect(line()).toBeUndefined()
    expect(pinButton()).toHaveFocus()
  })

  it('shifts the colours and markers of the shadows after one dismissed', async () => {
    mockWorld({
      ...WORLD,
      runs: { ...WORLD.runs, 'm2/c1': ['5'] },
      samples: { ...WORLD.samples, '5': [['a', 8]] },
    })
    renderPage(`${SHADOWED}&shadow=libcxx/m2/c1&shadow=libcxx/m2/c2`)
    await waitFor(() => expect(lines()).toHaveLength(3))

    await userEvent.setup().click(dismissButton('libcxx/m2/c1'))
    await waitFor(() => expect(lines()).toHaveLength(2))
    expect(query().shadow).toEqual(['libcxx/m1/c2', 'libcxx/m2/c2'])
    expect(chips()).toEqual(['●Shadow: libcxx/m1/c2 · 3 tests', '▲Shadow: libcxx/m2/c2 · 3 tests'])
    expect(lines()[1]).toMatchObject({ y: [-1, 1, 1], color: shadowLook(1).color })
    expect(dismissButton('libcxx/m2/c2')).toHaveFocus()
  })

  it('is offered only once there is a comparison', async () => {
    mockWorld(WORLD)
    renderPage(COMPARED.replace('&metric=execution_time', ''))
    expect(await screen.findByText('Select a metric.')).toBeInTheDocument()
    expect(pinButton()).toBeNull()
  })

  it("keeps side B's runs as they were when pinned, and follows the run aggregation", async () => {
    // Side B has three runs at c2, whose a is 4, 8 and 16 against side A's 1.
    mockWorld({
      runs: { 'm1/c1': ['1'], 'm1/c2': ['3', '6', '7'] },
      samples: { '1': [['a', 1]], '3': [['a', 4]], '6': [['a', 8]], '7': [['a', 16]] },
    })
    renderPage(`${COMPARED}&run_agg=min`)
    await comparison()
    const user = userEvent.setup()
    await user.click(runBox('3', 'B'))
    await user.click(pinButton()!)
    expect(query().shadow).toEqual([`libcxx/m1/c2/${uuidOf('6')},${uuidOf('7')}`])
    await waitFor(() => expect(chips()).toEqual(['●Shadow: libcxx/m1/c2 · 2 of 3 runs · 1 test']))
    await waitFor(() => expect(line()?.y).toEqual([3]))

    // Side B changes, but not the shadow: min(8, 16), against 1. Side B with all its runs is not
    // pinned yet.
    await user.click(runBox('3', 'B'))
    await waitFor(() => expect(barsOf()).toEqual([2]))
    expect(line()?.y).toEqual([3])
    expect(pinButton()).toBeEnabled()

    // The run aggregation changes both: max(8, 16) for the shadow, max(4, 8, 16) for side B.
    await pickOption('Run aggregation', 'max')
    await waitFor(() => expect(line()?.y).toEqual([4]))
    expect(barsOf()).toEqual([4])
  })

  it('draws its line, and fits it, when no compared test has a bar', async () => {
    // Side B, run 4, has none of side A's tests, whose shadow ratio is 4.
    mockWorld({
      runs: { 'm1/c1': ['1'], 'm1/c2': ['3'], 'm2/c2': ['4'] },
      samples: { '1': [['a', 1]], '3': [['a', 4]], '4': [['z', 1]] },
    })
    renderPage(SHADOWED)

    await waitFor(() => expect(line()?.y).toEqual([2]))
    expect(chart().layout.annotations).toEqual([])
    expect(Math.max(...(chart().layout.yaxis!.tickvals as number[]))).toBeGreaterThan(1.5)
  })

  it('is kept by a swap, and compared with the new side A', async () => {
    mockWorld(WORLD)
    renderPage(SHADOWED)
    await waitFor(() => expect(line()).toBeDefined())

    // Side A is now run 4: a 2, b 2, c 0.5, against which the shadow's ratios are 2, 0.25 and 4.
    await userEvent.setup().click(screen.getByRole('button', { name: 'Swap sides' }))
    await waitFor(() => expect(line()?.tests).toEqual(['b', 'a', 'c']))
    expect(line()?.y).toEqual([-2, 1, 2])
    expect(query().shadow).toEqual(['libcxx/m1/c2'])
  })

  it("is kept when side A's commit changes, and compared with it", async () => {
    mockWorld(WORLD)
    renderPage(SHADOWED)
    await waitFor(() => expect(line()?.y).toEqual([-1, 1, 2]))

    // Side A is now the shadow's commit: every ratio is 1.
    await pick('Commit', 'c2', sideOf('A'))
    await waitFor(() => expect(line()?.y).toEqual([0, 0, 0]))
    expect(query().shadow).toEqual(['libcxx/m1/c2'])
  })

  it("is kept when the user changes side A's runs", async () => {
    mockWorld()
    renderPage(SHADOWED)
    await waitFor(() => expect(line()).toBeDefined())

    await userEvent.setup().click(runBox('2', 'A'))
    await waitFor(() => expect(query().runs_a).toEqual([uuidOf('1')]))
    expect(query().shadow).toEqual(['libcxx/m1/c2'])
    expect(chips()).toHaveLength(1)
  })

  it('is kept while side A has no commit, and drawn once it has one', async () => {
    mockWorld(WORLD)
    renderPage(SHADOWED.replace('&commit_a=c1', ''))
    expect(await screen.findByText('Select a commit for side A.')).toBeInTheDocument()
    expect(chips()).toEqual(['●Shadow: libcxx/m1/c2'])

    await pick('Commit', 'c1', sideOf('A'))
    await waitFor(() => expect(line()?.y).toEqual([-1, 1, 2]))
    expect(chips()).toEqual(['●Shadow: libcxx/m1/c2 · 3 tests'])
    expect(query().shadow).toEqual(['libcxx/m1/c2'])
  })

  it('is fixed in one go: an unusable shadow dropped, and the runs that do not exist', async () => {
    mockWorld(WORLD)
    // m2 has no run at c1, and m1 has only run 3 at c2, which leaves it every run.
    const unknown = `libcxx/m1/c2/${uuidOf('3')},${uuidOf('9')}`
    renderPage(`${COMPARED}&shadow=libcxx/m2/c1&shadow=${unknown}`)

    await waitFor(() => expect(query().shadow).toEqual(['libcxx/m1/c2']))
    await waitFor(() => expect(line()).toBeDefined())
    expect(query().shadow).toEqual(['libcxx/m1/c2'])
    expect(screen.queryByText(/could not be/)).toBeNull()
  })

  it('is dropped alone when its suite does not exist', async () => {
    mockWorld(WORLD)
    renderPage(`${SHADOWED}&shadow=bogus/m1/c2`)
    await waitFor(() => expect(query().shadow).toEqual(['libcxx/m1/c2']))
  })

  it("plots no test when its suite does not offer the metric as side A's does", async () => {
    mockWorld(WORLD)
    renderPage(`${SHADOWED}&shadow=millis/m1/c2`)
    await comparison()

    await waitFor(() =>
      expect(chips()).toEqual(['●Shadow: libcxx/m1/c2 · 3 tests', '▲Shadow: millis/m1/c2 · 0 tests']),
    )
    expect(lines()).toHaveLength(1)
    expect(lines()[0].color).toBe(shadowLook(0).color)
  })

  it('says when its samples could not be loaded, still comparing', async () => {
    mockWorld({
      ...WORLD,
      sampleAnswer: (hex) =>
        hex === '3' ? errorResponse(500, 'internal_error', 'Boom') : undefined,
    })
    renderPage(SHADOWED)

    expect(await screen.findByText(/A shadow could not be loaded: Boom/)).toBeInTheDocument()
    await comparison()
    expect(line()).toBeUndefined()
    expect(chips()).toEqual(['●Shadow: libcxx/m1/c2'])
  })

  it('says when its runs could not be listed, still comparing', async () => {
    mockWorld({
      ...WORLD,
      runsAnswer: (query) =>
        query.get('machine') === 'm1' && query.get('commit') === 'c2'
          ? errorResponse(500, 'internal_error', 'Boom')
          : undefined,
    })
    renderPage(SHADOWED)

    expect(await screen.findByText(/A shadow could not be loaded: Boom/)).toBeInTheDocument()
    await comparison()
    expect(line()).toBeUndefined()
  })

  it("reports a run side B shares with it once, as side B's", async () => {
    mockWorld({
      ...WORLD,
      sampleAnswer: (hex) =>
        hex === '3' ? errorResponse(500, 'internal_error', 'Boom') : undefined,
    })
    renderPage(`${COMPARED}${SHADOW}`)

    expect(await screen.findByText(/The samples of a run could not be loaded/)).toBeInTheDocument()
    expect(screen.queryByText(/A shadow could not be loaded/)).toBeNull()
  })

  it('asks once for what shadows of the same commit share', async () => {
    const warn = vi.spyOn(console, 'warn')
    mockWorld({
      runs: { ...WORLD.runs, 'm1/c1': ['1', '2'] },
      samples: { ...WORLD.samples, '2': [['a', 2]] },
    })
    renderPage(`${SHADOWED}&shadow=libcxx/m1/c1/${uuidOf('2')}&shadow=libcxx/m1/c1`)

    await waitFor(() => expect(lines()).toHaveLength(3))
    expect(chips()).toEqual([
      '●Shadow: libcxx/m1/c2 · 3 tests',
      '▲Shadow: libcxx/m1/c1 · 1 of 2 runs · 1 test',
      '■Shadow: libcxx/m1/c1 · 3 tests',
    ])
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/Duplicate Queries/))
    warn.mockRestore()
  })

  it('says when its commit could not be looked up, still drawing its line', async () => {
    let failing = true
    mockWorld(WORLD)
    server.use(
      mockApi('get', '/api/suites/{testsuite}/commits', ({ request }) => {
        const params = new URL(request.url).searchParams
        const ofShadow = params.get('machine') === 'm1' && params.get('commit') === 'c2'
        if (failing && ofShadow) return errorResponse(500, 'internal_error', 'Boom') as never
      }),
    )
    renderPage(SHADOWED)

    expect(await screen.findByText(/A shadow could not be loaded: Boom/)).toBeInTheDocument()
    await waitFor(() => expect(line()?.y).toEqual([-1, 1, 2]))
    expect(query().shadow).toEqual(['libcxx/m1/c2'])

    failing = false
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByText(/A shadow could not be loaded/)).toBeNull())
    expect(line()?.y).toEqual([-1, 1, 2])
  })

  it("reports a runs list side B shares with it once, as side B's", async () => {
    mockWorld({
      ...WORLD,
      runsAnswer: (query) =>
        query.get('machine') === 'm1' && query.get('commit') === 'c2'
          ? errorResponse(500, 'internal_error', 'Boom')
          : undefined,
    })
    renderPage(`${COMPARED}${SHADOW}`)

    expect(await screen.findByText(/The runs could not be listed: Boom/)).toBeInTheDocument()
    expect(screen.queryByText(/A shadow could not be loaded/)).toBeNull()
  })

  it('highlights no row when a point of a line is hovered', async () => {
    mockWorld(WORLD)
    renderPage(SHADOWED)
    await waitFor(() => expect(line()).toBeDefined())
    const row = (test: string) => screen.getByRole('cell', { name: test }).closest('tr')
    const event = (trace: number, index: number) =>
      ({
        points: [{ data: chart().data[trace], pointNumber: index }],
      }) as unknown as PlotMouseEvent & PlotHoverEvent

    act(() => chart().onHover?.(event(0, 0)))
    expect(row('c')).toHaveClass('hoveredRow')
    // From the bar straight to the line, with no unhover between.
    act(() => chart().onHover?.(event(1, 0)))
    expect(row('c')).not.toHaveClass('hoveredRow')
  })
})
