import { render, screen, waitFor } from '@testing-library/react'
import type { Data, Layout, PlotHoverEvent, PlotMouseEvent } from 'plotly.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { observerCount, resize } from '../test/resize-observer'
import { Chart } from './chart'
import { PageErrorBoundary } from './page-error-boundary'

type Listener = (event: unknown) => void

/** The plot a mocked `Plotly.react` turns its container into, with the listeners it was given. */
const plotly = vi.hoisted(() => {
  const listeners = new Map<string, Listener>()
  return {
    listeners,
    react: vi.fn<(div: HTMLElement, ...drawn: unknown[]) => Promise<HTMLElement>>(async (div) =>
      Object.assign(div, {
        on: (name: string, listener: Listener) => listeners.set(name, listener),
      }),
    ),
    purge: vi.fn(),
    Plots: { resize: vi.fn(async () => {}) },
    Fx: { unhover: vi.fn() },
  }
})
vi.mock('plotly.js-basic-dist-min', () => ({ default: plotly }))

beforeEach(() => {
  plotly.listeners.clear()
  vi.clearAllMocks()
})
afterEach(() => {
  vi.restoreAllMocks()
})

const DATA: Data[] = [{ type: 'scatter', x: [0, 1], y: [2, 3] }]
const LAYOUT: Partial<Layout> = { showlegend: false }

function chart(props: Partial<Parameters<typeof Chart>[0]> = {}) {
  return <Chart label="A trend" className="plot" data={DATA} layout={LAYOUT} {...props} />
}

describe('Chart', () => {
  it('draws once Plotly has loaded, in a container named by its label', async () => {
    render(chart())

    await waitFor(() => expect(plotly.react).toHaveBeenCalledTimes(1))
    const container = screen.getByRole('img', { name: 'A trend' })
    expect(container).toHaveClass('plot')
    expect(plotly.react).toHaveBeenCalledWith(container, DATA, LAYOUT, { displaylogo: false })
    // A copy of the layout, which Plotly writes into.
    expect(plotly.react.mock.lastCall![2]).not.toBe(LAYOUT)
  })

  it('draws again only when what it draws changes', async () => {
    const { rerender } = render(chart())
    await waitFor(() => expect(plotly.react).toHaveBeenCalledTimes(1))

    rerender(chart({ onHover: () => {} }))
    const data: Data[] = [{ type: 'scatter', x: [0], y: [1] }]
    rerender(chart({ data }))

    await waitFor(() => expect(plotly.react).toHaveBeenCalledTimes(2))
    expect(plotly.react.mock.lastCall![1]).toBe(data)
  })

  it('passes hover events on to the handler it was last given', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(chart({ onHover: first }))
    await waitFor(() => expect(plotly.listeners.has('plotly_hover')).toBe(true))

    rerender(chart({ onHover: second }))
    const event = { points: [{ curveNumber: 1 }] } as PlotHoverEvent
    plotly.listeners.get('plotly_hover')!(event)

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith(event)
  })

  it('passes clicks and the end of a hover on to their handlers', async () => {
    const onUnhover = vi.fn()
    const onClick = vi.fn()
    render(chart({ onUnhover, onClick }))
    await waitFor(() => expect(plotly.listeners.has('plotly_click')).toBe(true))

    const event = { points: [{ curveNumber: 0 }] } as PlotMouseEvent
    plotly.listeners.get('plotly_click')!(event)
    plotly.listeners.get('plotly_unhover')!(event)

    expect(onClick).toHaveBeenCalledWith(event)
    expect(onUnhover).toHaveBeenCalledWith(event)
  })

  it('drops the hover label of a point clicked only when the click opened something', async () => {
    const onClick = vi.fn(() => false)
    render(chart({ onClick }))
    await waitFor(() => expect(plotly.listeners.has('plotly_click')).toBe(true))
    const event = { points: [{ curveNumber: 0 }] } as PlotMouseEvent

    plotly.listeners.get('plotly_click')!(event)
    expect(plotly.Fx.unhover).not.toHaveBeenCalled()

    onClick.mockReturnValue(true)
    plotly.listeners.get('plotly_click')!(event)
    expect(plotly.Fx.unhover).toHaveBeenCalledWith(screen.getByRole('img', { name: 'A trend' }))
  })

  it("reports where the plot draws once a draw moves it, from Plotly's layout", async () => {
    const onDraw = vi.fn()
    plotly.react.mockImplementation(async (div) =>
      Object.assign(div, {
        on: (name: string, listener: Listener) => plotly.listeners.set(name, listener),
        _fullLayout: {
          _size: { l: 70, t: 10, w: 600, h: 400 },
          xaxis: { l2p: (value: number) => 10 * value, _offset: 70 },
          yaxis: { l2p: (value: number) => 400 - value, _offset: 10 },
        },
      }),
    )
    render(chart({ onDraw }))

    await waitFor(() => expect(onDraw).toHaveBeenCalledTimes(1))
    const geometry = onDraw.mock.lastCall![0]
    expect(geometry.area).toEqual({ left: 70, top: 10, width: 600, height: 400 })
    expect(geometry.x(2)).toBe(90)
    expect(geometry.y(100)).toBe(310)
    // A draw that moves nothing reports nothing; a zoom or a resize, which moves the plot, does.
    plotly.listeners.get('plotly_afterplot')!(undefined)
    expect(onDraw).toHaveBeenCalledTimes(1)
    const div = screen.getByRole('img') as unknown as { _fullLayout: { _size: { w: number } } }
    div._fullLayout._size.w = 500
    plotly.listeners.get('plotly_afterplot')!(undefined)
    expect(onDraw).toHaveBeenCalledTimes(2)
    expect(onDraw.mock.lastCall![0].area.width).toBe(500)
  })

  it('reports nothing of a draw that ends once the plot is freed', async () => {
    const onDraw = vi.fn()
    const { unmount } = render(chart({ onDraw }))
    await waitFor(() => expect(plotly.listeners.has('plotly_afterplot')).toBe(true))
    onDraw.mockClear()

    unmount()
    plotly.listeners.get('plotly_afterplot')!(undefined)

    expect(onDraw).not.toHaveBeenCalled()
  })

  it('reports a zoom, but not the relayout of a resize', async () => {
    const onRelayout = vi.fn()
    render(chart({ onRelayout }))
    await waitFor(() => expect(plotly.listeners.has('plotly_relayout')).toBe(true))

    plotly.listeners.get('plotly_relayout')!({ autosize: true, width: 600 })
    expect(onRelayout).not.toHaveBeenCalled()
    const zoom = { 'xaxis.range[0]': 1, 'xaxis.range[1]': 4 }
    plotly.listeners.get('plotly_relayout')!(zoom)
    expect(onRelayout).toHaveBeenCalledWith(zoom)
  })

  it('says so when Plotly fails to draw, and frees the plot', async () => {
    plotly.react.mockRejectedValueOnce(new Error('no'))
    render(chart())

    expect(await screen.findByRole('alert')).toHaveTextContent('The chart could not be drawn.')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(plotly.purge).toHaveBeenCalledTimes(1)
    expect(observerCount()).toBe(0)
  })

  it('resizes the plot with its container, and frees it when unmounted', async () => {
    const { unmount } = render(chart())
    await waitFor(() => expect(plotly.listeners.size).toBeGreaterThan(0))
    const container = screen.getByRole('img', { name: 'A trend' })

    resize()
    expect(plotly.Plots.resize).toHaveBeenCalledWith(container)
    // A resize of a plot that is not displayed is rejected, which is nothing to report.
    plotly.Plots.resize.mockRejectedValueOnce(new Error('not displayed'))
    resize()

    unmount()
    expect(plotly.purge).toHaveBeenCalledWith(container)
    expect(observerCount()).toBe(0)
  })

  it("leaves it to the page's error boundary to say that Plotly could not be loaded", async () => {
    // React reports every error a boundary catches; this one is expected.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.resetModules()
    // A module that fails once imported: Vitest reports a factory that throws as its own error.
    vi.doMock('plotly.js-basic-dist-min', () => ({
      get default() {
        throw new TypeError('Failed to fetch dynamically imported module')
      },
    }))
    try {
      const fresh = await import('./chart')
      render(
        <PageErrorBoundary resetKey="">
          <fresh.Chart label="A trend" className="plot" data={DATA} layout={LAYOUT} />
        </PageErrorBoundary>,
      )

      expect(await screen.findByRole('alert')).toHaveTextContent('dynamically imported module')
      expect(screen.getByText('Reload the page to try again.')).toBeInTheDocument()
    } finally {
      vi.doUnmock('plotly.js-basic-dist-min')
    }
  })
})
