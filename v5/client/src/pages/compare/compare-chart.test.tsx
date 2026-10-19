import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import type { PlotHoverEvent, PlotMouseEvent, PlotRelayoutEvent } from 'plotly.js'
import { describe, expect, it, vi } from 'vitest'
import { query, renderPage, search } from '../../test/page'
import { pickOption } from '../../test/select'
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
