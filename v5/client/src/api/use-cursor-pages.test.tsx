import { useState } from 'react'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { api, errorMessage, unwrap } from './client'
import { useCursorPages } from './use-cursor-pages'
import { sample as fixtureSample } from '../test/fixtures'
import { errorResponse, mockApi } from '../test/mock-api'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'

const SAMPLES = '/api/suites/{testsuite}/runs/{uuid}/samples' as const
const RUN = '573af861-8303-4a5b-a643-b8321e0142c4'

const sample = (test: string) => fixtureSample(test, { execution_time: 1 })

/** Pages of samples, `a` then `b` then `c`, each fetched by the cursor the previous one gave. */
const PAGES: Record<string, { items: ReturnType<typeof sample>[]; next: string | null }> = {
  first: { items: [sample('a')], next: 'p2' },
  p2: { items: [sample('b')], next: 'p3' },
  p3: { items: [sample('c')], next: null },
}

const OTHER_RUN = '2cb00c2d-8303-4a5b-a643-b8321e0142c4'

function Samples({ run = RUN }: { run?: string }) {
  const { items, isPending, isComplete, error, hasPages, retry } = useCursorPages({
    queryKey: ['samples', run],
    fetchPage: (cursor, signal) =>
      unwrap(
        api.GET(SAMPLES, {
          params: { path: { testsuite: 'nts', uuid: run }, query: { cursor } },
          signal,
        }),
      ),
  })
  if (isPending) return <p>pending</p>
  return (
    <>
      <p>{items.map((item) => item.test).join(',')}</p>
      <p>{isComplete ? 'complete' : 'loading more'}</p>
      {error && <p>{errorMessage(error)}</p>}
      {error && <p>{hasPages ? 'some pages' : 'no page'}</p>}
      <button onClick={retry}>retry</button>
    </>
  )
}

/**
 * Serves PAGES, holding back the cursors in `held` until they are released, and failing those in
 * `failing` for as long as they are in it.
 */
function servePages(held: Set<string> = new Set(), failing: Set<string> = new Set()) {
  const requested: string[] = []
  const aborted: string[] = []
  const waiting = new Map<string, () => void>()
  server.use(
    mockApi('get', SAMPLES, async ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor') ?? 'first'
      requested.push(cursor)
      if (failing.has(cursor)) return errorResponse(500, 'internal_error', 'Boom')
      if (held.has(cursor)) {
        request.signal.addEventListener('abort', () => aborted.push(cursor))
        await new Promise<void>((resolve) => waiting.set(cursor, resolve))
      }
      const page = PAGES[cursor]
      return HttpResponse.json({ items: page.items, cursor: { next: page.next, previous: null } })
    }),
  )
  const release = async (cursor: string) => {
    await waitFor(() => expect(waiting.has(cursor)).toBe(true))
    act(() => waiting.get(cursor)!())
  }
  return { requested, aborted, release }
}

describe('useCursorPages', () => {
  it('fetches every page, showing the items as they arrive', async () => {
    const { release } = servePages(new Set(['p3']))
    renderWithProviders(<Samples />)

    expect(await screen.findByText('a,b')).toBeInTheDocument()
    expect(screen.getByText('loading more')).toBeInTheDocument()

    await release('p3')
    expect(await screen.findByText('a,b,c')).toBeInTheDocument()
    expect(screen.getByText('complete')).toBeInTheDocument()
  })

  it('cancels the page in flight on unmount, and resumes from the cache on remount', async () => {
    const { requested, aborted } = servePages(new Set(['p2']))
    function Toggle() {
      const [shown, setShown] = useState(true)
      return (
        <>
          <button onClick={() => setShown(!shown)}>toggle</button>
          {shown && <Samples />}
        </>
      )
    }
    renderWithProviders(<Toggle />)
    await waitFor(() => expect(requested).toEqual(['first', 'p2']))

    fireEvent.click(screen.getByRole('button', { name: 'toggle' }))
    await waitFor(() => expect(aborted).toEqual(['p2']))

    const remounted = servePages()
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }))
    expect(await screen.findByText('a,b,c')).toBeInTheDocument()
    // The first page came from the cache: only the rest was fetched.
    expect(remounted.requested).toEqual(['p2', 'p3'])
  })

  it('stops at a page that fails, keeping the pages before it', async () => {
    server.use(
      mockApi('get', SAMPLES, ({ request }) => {
        if (new URL(request.url).searchParams.has('cursor')) {
          return errorResponse(500, 'internal_error', 'The server failed to answer this request')
        }
        return HttpResponse.json({ items: [sample('a')], cursor: { next: 'p2', previous: null } })
      }),
    )
    renderWithProviders(<Samples />)

    expect(await screen.findByText('The server failed to answer this request')).toBeInTheDocument()
    expect(screen.getByText('a')).toBeInTheDocument()
    expect(screen.getByText('loading more')).toBeInTheDocument()
  })

  it('starts again from the first page when its cursor is rejected', async () => {
    // As after a deploy: the cursor the first page handed out is no longer accepted, and the first
    // page now hands out one that is.
    const requested: string[] = []
    let firstPages = 0
    server.use(
      mockApi('get', SAMPLES, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor') ?? 'first'
        requested.push(cursor)
        if (cursor === 'first') {
          const next = ++firstPages === 1 ? 'stale' : 'fresh'
          return HttpResponse.json({ items: [sample('a')], cursor: { next, previous: null } })
        }
        if (cursor === 'stale') return errorResponse(400, 'invalid_request', 'Invalid cursor')
        return HttpResponse.json({ items: [sample('b')], cursor: { next: null, previous: null } })
      }),
    )
    renderWithProviders(<Samples />)

    expect(await screen.findByText('complete')).toBeInTheDocument()
    expect(screen.getByText('a,b')).toBeInTheDocument()
    expect(requested).toEqual(['first', 'stale', 'first', 'fresh'])
  })

  it('starts again only once', async () => {
    const requested: string[] = []
    server.use(
      mockApi('get', SAMPLES, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor')
        requested.push(cursor ?? 'first')
        if (cursor !== null) return errorResponse(400, 'invalid_request', 'Invalid cursor')
        return HttpResponse.json({ items: [sample('a')], cursor: { next: 'bad', previous: null } })
      }),
    )
    renderWithProviders(<Samples />)

    await waitFor(() => expect(requested).toEqual(['first', 'bad', 'first', 'bad']))
    expect(await screen.findByText('Invalid cursor')).toBeInTheDocument()
    expect(screen.getByText('loading more')).toBeInTheDocument()
    expect(requested).toHaveLength(4)
  })

  describe('retry', () => {
    it('resumes from the page that failed, keeping the pages before it', async () => {
      const failing = new Set(['p2'])
      const { requested } = servePages(undefined, failing)
      renderWithProviders(<Samples />)
      expect(await screen.findByText('some pages')).toBeInTheDocument()

      failing.clear()
      fireEvent.click(screen.getByRole('button', { name: 'retry' }))

      expect(await screen.findByText('a,b,c')).toBeInTheDocument()
      expect(requested).toEqual(['first', 'p2', 'p2', 'p3'])
    })

    it('fetches the first page again when it is the one that failed', async () => {
      const failing = new Set(['first'])
      const { requested } = servePages(undefined, failing)
      renderWithProviders(<Samples />)
      expect(await screen.findByText('no page')).toBeInTheDocument()

      failing.clear()
      fireEvent.click(screen.getByRole('button', { name: 'retry' }))

      expect(await screen.findByText('a,b,c')).toBeInTheDocument()
      expect(requested).toEqual(['first', 'first', 'p2', 'p3'])
    })

    it('starts from the first page when a cursor is still rejected', async () => {
      const requested: string[] = []
      let accepted = false
      server.use(
        mockApi('get', SAMPLES, ({ request }) => {
          const cursor = new URL(request.url).searchParams.get('cursor')
          requested.push(cursor ?? 'first')
          if (cursor === null) {
            const next = accepted ? 'good' : 'bad'
            return HttpResponse.json({ items: [sample('a')], cursor: { next, previous: null } })
          }
          if (cursor === 'bad') return errorResponse(400, 'invalid_request', 'Invalid cursor')
          return HttpResponse.json({ items: [sample('b')], cursor: { next: null, previous: null } })
        }),
      )
      renderWithProviders(<Samples />)
      // Once the automatic restart has been rejected too.
      await waitFor(() => expect(requested).toHaveLength(4))
      expect(await screen.findByText('Invalid cursor')).toBeInTheDocument()

      accepted = true
      fireEvent.click(screen.getByRole('button', { name: 'retry' }))

      expect(await screen.findByText('a,b')).toBeInTheDocument()
      expect(requested).toEqual(['first', 'bad', 'first', 'bad', 'first', 'good'])
    })
  })

  it('drops the sequence in flight when the query changes', async () => {
    const { aborted } = servePages(new Set(['p2']))
    const { rerender } = renderWithProviders(<Samples />)
    expect(await screen.findByText('a')).toBeInTheDocument()

    server.use(
      mockApi('get', SAMPLES, ({ params }) =>
        HttpResponse.json({
          items: [sample(`other-${params.uuid.slice(0, 4)}`)],
          cursor: { next: null, previous: null },
        }),
      ),
    )
    rerender(<Samples run={OTHER_RUN} />)

    expect(await screen.findByText('other-2cb0')).toBeInTheDocument()
    expect(screen.getByText('complete')).toBeInTheDocument()
    await waitFor(() => expect(aborted).toEqual(['p2']))
  })
})
