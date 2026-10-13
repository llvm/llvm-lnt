import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PlotData, PlotHoverEvent, PlotMouseEvent } from 'plotly.js'
import { describe, expect, it, vi } from 'vitest'
import { uuidOf } from '../../test/fixtures'
import { errorResponse } from '../../test/mock-api'
import { query, renderPage } from '../../test/page'
import { pickOption } from '../../test/select'
import { chart, COMPARED, comparison, mockWorld, pick, runBox } from './compare-world'

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
    expect(pinButton()).toBeNull()
    expect(query()).toMatchObject({
      suite_shadow_b: ['libcxx'],
      machine_shadow_b: ['m1'],
      commit_shadow_b: ['c2'],
    })

    await pick('Machine B', 'm2')
    await waitFor(() => expect(line()?.tests).toEqual(['b', 'c', 'a']))
    expect(line()?.y).toEqual([-1, 1, 2])
    expect((chart().data[1] as PlotData).hovertemplate).toContain('(shadow)')
    // The bars are the main comparison's.
    expect((chart().data[0] as PlotData).y).toEqual([-1, 1, 1])
  })

  it('is restored from the URL, without fetching any sample twice', async () => {
    const sampled = mockWorld(WORLD)
    renderPage(SHADOWED)

    await waitFor(() => expect(line()?.y).toEqual([-1, 1, 2]))
    expect(chip()).toHaveTextContent('Shadow: c2 on m1')
    expect([...sampled].sort()).toEqual(['1', '3', '4'])
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

  it('is dismissed by a swap', async () => {
    mockWorld(WORLD)
    renderPage(SHADOWED)
    await waitFor(() => expect(line()).toBeDefined())

    await userEvent.setup().click(screen.getByRole('button', { name: 'Swap sides' }))
    await waitFor(() => expect(chip()).toBeNull())
    expect(query().commit_shadow_b).toBeUndefined()
  })

  it("is dismissed by another commit on side A, but not by side A's run aggregation", async () => {
    mockWorld()
    renderPage(SHADOWED)
    // Side A's runs 1 and 2 give a 2, by their median, and the shadow's run 3, 4.
    await waitFor(() => expect(line()?.y).toEqual([1]))

    await pickOption('Run aggregation A', 'min')
    await waitFor(() => expect(line()?.y).toEqual([2]))
    expect(chip()).not.toBeNull()

    await pick('Commit A', 'c2')
    await waitFor(() => expect(chip()).toBeNull())
    expect(query().machine_shadow_b).toBeUndefined()
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

  it('is dropped when the URL names only part of it', async () => {
    mockWorld(WORLD)
    renderPage(`${COMPARED}&suite_shadow_b=libcxx&run_agg_shadow_b=min`)
    await waitFor(() => expect(query().suite_shadow_b).toBeUndefined())
    expect(query().run_agg_shadow_b).toBeUndefined()
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
