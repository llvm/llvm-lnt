import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PlotData, PlotHoverEvent, PlotMouseEvent } from 'plotly.js'
import { describe, expect, it, vi } from 'vitest'
import { uuidOf } from '../../test/fixtures'
import { errorResponse } from '../../test/mock-api'
import { query, renderPage } from '../../test/page'
import { pickOption } from '../../test/select'
import { barsOf, chart, COMPARED, comparison, mockWorld, pick, runBox, sideOf } from './compare-world'

// The tests check what the page hands Plotly to draw (see test/chart.tsx).
vi.mock('../../components/chart', () => import('../../test/chart'))

/** The shadow's line, if drawn: its points' log2 ratios, and their tests. */
function line() {
  const trace = chart().data[1] as PlotData | undefined
  if (trace === undefined) return undefined
  const tests = (trace.customdata as unknown as string[][]).map((point) => point[0])
  return { y: trace.y as number[], tests }
}

/**
 * Side A has one run, 1, at m1's c1. Side B is run 3, m1's at c2, to pin, then run 4, m2's at c2:
 * against A, the shadow's ratios are a 4, b 0.5 and c 2.
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
const SHADOW = '&suite_shadow_b=libcxx&machine_shadow_b=m1&commit_shadow_b=c2'

/** COMPARED, with side B on m2, and SHADOW pinned. */
const SHADOWED = `${COMPARED.replace('machine_b=m1', 'machine_b=m2')}${SHADOW}`

const pinButton = () => screen.queryByRole('button', { name: 'Pin as shadow' })
const chip = () => screen.queryByText(/^Shadow:/)

describe('the shadow (CP8)', () => {
  it('pins side B, drawn as a line sorted by its own ratios once side B changes', async () => {
    mockWorld(WORLD)
    renderPage(COMPARED)
    await comparison()

    const user = userEvent.setup()
    await user.click(pinButton()!)
    expect(chip()).toHaveTextContent('Shadow: c2 on m1')
    expect(screen.getByRole('button', { name: 'Dismiss the shadow' })).toHaveFocus()
    expect(pinButton()).toBeNull()
    expect(query()).toMatchObject({
      suite_shadow_b: ['libcxx'],
      machine_shadow_b: ['m1'],
      commit_shadow_b: ['c2'],
    })

    await pick('Machine', 'm2', sideOf('B'))
    await waitFor(() => expect(line()?.tests).toEqual(['b', 'c', 'a']))
    expect(line()?.y).toEqual([-1, 1, 2])
    expect((chart().data[1] as PlotData).hovertemplate).toContain('(shadow)')
    // The bars are the main comparison's.
    expect(barsOf()).toEqual([-1, 1, 1])
  })

  it('is restored from the URL, without fetching any sample twice', async () => {
    const sampled = mockWorld(WORLD)
    renderPage(SHADOWED)

    await waitFor(() => expect(line()?.y).toEqual([-1, 1, 2]))
    expect(chip()).toHaveTextContent('Shadow: c2 on m1')
    expect([...sampled].sort()).toEqual(['1', '3', '4'])
    // Only pinning it gives the focus to its chip.
    expect(screen.getByRole('button', { name: 'Dismiss the shadow' })).not.toHaveFocus()
  })

  it('plots only the tests the chart plots', async () => {
    mockWorld(WORLD)
    renderPage(`${SHADOWED}&hidden_test=a`)

    await waitFor(() => expect(line()?.tests).toEqual(['b', 'c']))
  })

  it('is dismissed with its chip, which gives the focus to the pin button', async () => {
    mockWorld(WORLD)
    renderPage(SHADOWED)
    await waitFor(() => expect(line()).toBeDefined())

    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss the shadow' }))
    await waitFor(() => expect(chip()).toBeNull())
    expect(query().suite_shadow_b).toBeUndefined()
    expect(line()).toBeUndefined()
    expect(pinButton()).toHaveFocus()
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
    expect(query()).toMatchObject({ runs_shadow_b: [uuidOf('6'), uuidOf('7')] })
    await waitFor(() => expect(line()?.y).toEqual([3]))

    // Side B changes, but not the shadow: min(8, 16), against 1.
    await user.click(runBox('3', 'B'))
    await waitFor(() => expect(barsOf()).toEqual([2]))
    expect(line()?.y).toEqual([3])

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

  it('is dismissed by a swap', async () => {
    mockWorld(WORLD)
    renderPage(SHADOWED)
    await waitFor(() => expect(line()).toBeDefined())

    await userEvent.setup().click(screen.getByRole('button', { name: 'Swap sides' }))
    await waitFor(() => expect(chip()).toBeNull())
    expect(query().commit_shadow_b).toBeUndefined()
  })

  it('is dismissed by another commit on side A', async () => {
    mockWorld()
    renderPage(SHADOWED)
    await waitFor(() => expect(line()).toBeDefined())

    await pick('Commit', 'c2', sideOf('A'))
    await waitFor(() => expect(chip()).toBeNull())
    expect(query().machine_shadow_b).toBeUndefined()
  })

  it("is dismissed by another machine on side A, keeping side A's commit", async () => {
    mockWorld({ ...WORLD, runs: { ...WORLD.runs, 'm2/c1': ['5'] } })
    renderPage(SHADOWED)
    await waitFor(() => expect(line()).toBeDefined())

    await pick('Machine', 'm2', sideOf('A'))
    await waitFor(() => expect(chip()).toBeNull())
    expect(query().commit_a).toEqual(['c1'])
  })

  it("is dismissed when the user changes side A's runs", async () => {
    mockWorld()
    renderPage(SHADOWED)
    await waitFor(() => expect(line()).toBeDefined())

    await userEvent.setup().click(runBox('2', 'A'))
    await waitFor(() => expect(chip()).toBeNull())
  })

  it("is kept when runs that do not exist are dropped from side A's", async () => {
    mockWorld()
    renderPage(`${SHADOWED}&runs_a=${uuidOf('1')}&runs_a=${uuidOf('9')}`)

    await waitFor(() => expect(query().runs_a).toEqual([uuidOf('1')]))
    await waitFor(() => expect(line()).toBeDefined())
    expect(query().commit_shadow_b).toEqual(['c2'])
  })

  it('is dropped when its machine has no run at its commit', async () => {
    mockWorld(WORLD)
    renderPage(`${COMPARED}&suite_shadow_b=libcxx&machine_shadow_b=m2&commit_shadow_b=c1`)
    await waitFor(() => expect(query().suite_shadow_b).toBeUndefined())
    expect(query().machine_shadow_b).toBeUndefined()
    expect(screen.queryByText(/could not be/)).toBeNull()
  })

  it('is dropped when side A has no commit', async () => {
    mockWorld(WORLD)
    renderPage(SHADOWED.replace('&commit_a=c1', ''))
    await waitFor(() => expect(query().suite_shadow_b).toBeUndefined())
    expect(query().commit_shadow_b).toBeUndefined()
  })

  it('is dropped whole when its suite does not exist', async () => {
    mockWorld(WORLD)
    const bogus = SHADOWED.replace('suite_shadow_b=libcxx', 'suite_shadow_b=bogus')
    renderPage(bogus)
    await waitFor(() => expect(query().suite_shadow_b).toBeUndefined())
    expect(query().machine_shadow_b).toBeUndefined()
    expect(query().commit_shadow_b).toBeUndefined()
  })

  it('is dropped when the URL names only part of it', async () => {
    mockWorld(WORLD)
    renderPage(`${COMPARED}&suite_shadow_b=libcxx&runs_shadow_b=${uuidOf('3')}`)
    await waitFor(() => expect(query().suite_shadow_b).toBeUndefined())
    expect(query().runs_shadow_b).toBeUndefined()
  })

  it("draws nothing when its suite does not offer the metric as side A's does", async () => {
    mockWorld(WORLD)
    renderPage(SHADOWED.replace('suite_shadow_b=libcxx', 'suite_shadow_b=millis'))
    await comparison()

    await waitFor(() => expect(chip()).not.toBeNull())
    expect(line()).toBeUndefined()
  })

  it('says when its samples could not be loaded, still comparing', async () => {
    mockWorld({
      ...WORLD,
      sampleAnswer: (hex) =>
        hex === '3' ? errorResponse(500, 'internal_error', 'Boom') : undefined,
    })
    renderPage(SHADOWED)

    expect(
      await screen.findByText(/The samples of a run of the shadow could not be loaded: Boom/),
    ).toBeInTheDocument()
    await comparison()
    expect(line()).toBeUndefined()
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

    expect(
      await screen.findByText(/The shadow's runs could not be listed: Boom/),
    ).toBeInTheDocument()
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
    expect(screen.queryByText(/of the shadow could not be loaded/)).toBeNull()
  })

  it('highlights no row when a point of the line is hovered', async () => {
    mockWorld(WORLD)
    renderPage(SHADOWED)
    await waitFor(() => expect(line()).toBeDefined())
    const name = (test: string) => screen.getByRole('cell', { name: test }).querySelector('span')
    const event = (trace: number, index: number) =>
      ({
        points: [{ data: chart().data[trace], pointNumber: index }],
      }) as unknown as PlotMouseEvent & PlotHoverEvent

    act(() => chart().onHover?.(event(0, 0)))
    expect(name('c')).toHaveClass('hovered')
    // From the bar straight to the line, with no unhover between.
    act(() => chart().onHover?.(event(1, 0)))
    expect(name('c')).not.toHaveClass('hovered')
  })
})
