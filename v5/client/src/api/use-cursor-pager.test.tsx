import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from './client'
import { useCursorPager } from './use-cursor-pager'
import { providers } from '../test/render'
import { cursorPage } from '../test/fixtures'

type Page = ReturnType<typeof cursorPage<string>>

/** Three pages of letters, reached through the cursors `c1` and `c2`. */
const PAGES: Record<string, Page> = {
  first: cursorPage(['a', 'b'], 'c1'),
  c1: cursorPage(['c', 'd'], 'c2'),
  c2: cursorPage(['e']),
}

function renderPager(
  fetchPage: (cursor: string | null) => Promise<Page> = async (cursor) => PAGES[cursor ?? 'first'],
) {
  const fetch = vi.fn(fetchPage)
  const { result, rerender } = renderHook(
    ({ search }) =>
      useCursorPager({ queryKey: ['letters', search], fetchPage: (cursor) => fetch(cursor) }),
    { ...providers(), initialProps: { search: '' } },
  )
  return { result, rerender, fetch }
}

describe('useCursorPager', () => {
  it('shows the first page, with only Next to offer', async () => {
    const { result } = renderPager()

    expect(result.current.isPending).toBe(true)
    await waitFor(() => expect(result.current.page?.items).toEqual(['a', 'b']))
    expect(result.current.hasPrevious).toBe(false)
    expect(result.current.hasNext).toBe(true)
  })

  it('goes forward with the cursor of the page shown, and back to pages it fetched', async () => {
    const { result, fetch } = renderPager()
    await waitFor(() => expect(result.current.hasNext).toBe(true))

    act(() => result.current.next())
    await waitFor(() => expect(result.current.page?.items).toEqual(['c', 'd']))
    act(() => result.current.next())
    await waitFor(() => expect(result.current.page?.items).toEqual(['e']))
    expect(result.current.hasNext).toBe(false)
    expect(result.current.hasPrevious).toBe(true)

    act(() => result.current.previous())
    act(() => result.current.previous())
    expect(result.current.page?.items).toEqual(['a', 'b'])
    expect(result.current.hasPrevious).toBe(false)
    expect(fetch.mock.calls).toEqual([[null], ['c1'], ['c2']])
  })

  it('keeps the page shown while the next one loads, offering no other meanwhile', async () => {
    let release = () => {}
    const { result } = renderPager(async (cursor) => {
      if (cursor === 'c1') await new Promise<void>((resolve) => (release = resolve))
      return PAGES[cursor ?? 'first']
    })
    await waitFor(() => expect(result.current.hasNext).toBe(true))

    act(() => result.current.next())
    await waitFor(() => expect(result.current.isUpdating).toBe(true))
    expect(result.current.page?.items).toEqual(['a', 'b'])
    expect(result.current.hasNext).toBe(false)
    expect(result.current.hasPrevious).toBe(false)

    act(() => release())
    await waitFor(() => expect(result.current.page?.items).toEqual(['c', 'd']))
    expect(result.current.isUpdating).toBe(false)
  })

  it('starts again from the first page for another query, even one it showed before', async () => {
    const { result, rerender } = renderPager()
    await waitFor(() => expect(result.current.hasNext).toBe(true))
    act(() => result.current.next())
    await waitFor(() => expect(result.current.page?.items).toEqual(['c', 'd']))

    rerender({ search: 'x' })
    await waitFor(() => expect(result.current.page?.items).toEqual(['a', 'b']))
    expect(result.current.hasPrevious).toBe(false)

    rerender({ search: '' })
    expect(result.current.page?.items).toEqual(['a', 'b'])
    expect(result.current.hasPrevious).toBe(false)
  })

  it('starts again from a freshly fetched first page when a cursor is rejected (I2)', async () => {
    // The first page hands out `stale` until the server changes, and `c1` afterwards.
    let firstPages = 0
    const { result, fetch } = renderPager(async (cursor) => {
      if (cursor === 'stale') throw new ApiError(400, 'invalid_request', 'Invalid cursor')
      if (cursor === null) return cursorPage(['a', 'b'], firstPages++ === 0 ? 'stale' : 'c1')
      return PAGES[cursor]
    })
    await waitFor(() => expect(result.current.hasNext).toBe(true))

    act(() => result.current.next())
    await waitFor(() => expect(fetch.mock.calls).toEqual([[null], ['stale'], [null]]))
    await waitFor(() => expect(result.current.hasNext).toBe(true))
    expect(result.current.page?.items).toEqual(['a', 'b'])
    expect(result.current.hasPrevious).toBe(false)

    act(() => result.current.next())
    await waitFor(() => expect(result.current.page?.items).toEqual(['c', 'd']))
    expect(fetch.mock.calls.at(-1)).toEqual(['c1'])
  })

  it('shows no page once one fails to load, and asks for it again on retry', async () => {
    let failures = 1
    const { result, fetch } = renderPager(async (cursor) => {
      if (cursor === 'c1' && failures-- > 0) {
        throw new ApiError(500, 'internal_error', 'The server failed')
      }
      return PAGES[cursor ?? 'first']
    })
    await waitFor(() => expect(result.current.hasNext).toBe(true))

    act(() => result.current.next())
    await waitFor(() => expect(result.current.error?.message).toBe('The server failed'))
    expect(result.current.page).toBeUndefined()
    expect(result.current.hasNext).toBe(false)

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.page?.items).toEqual(['c', 'd']))
    expect(result.current.error).toBeNull()
    expect(fetch.mock.calls).toEqual([[null], ['c1'], ['c1']])
  })

  it('shows no page once the first page of another query fails to load', async () => {
    let search = ''
    const { result, rerender } = renderPager(async (cursor) => {
      if (cursor === null && search === 'broken') {
        throw new ApiError(500, 'internal_error', 'The server failed')
      }
      return PAGES[cursor ?? 'first']
    })
    await waitFor(() => expect(result.current.page?.items).toEqual(['a', 'b']))

    search = 'broken'
    rerender({ search })

    await waitFor(() => expect(result.current.error?.message).toBe('The server failed'))
    expect(result.current.page).toBeUndefined()
  })
})
