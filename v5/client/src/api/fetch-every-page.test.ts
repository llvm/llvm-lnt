import { describe, expect, it } from 'vitest'
import { ApiError } from './client'
import { fetchEveryPage } from './fetch-every-page'
import type { CursorPage } from './use-cursor-pages'
import { cursorPage } from '../test/fixtures'

/** Pages of letters, `a` then `b` then `c`, each fetched by the cursor the previous one gave. */
const PAGES: Record<string, CursorPage<string>> = {
  first: cursorPage(['a'], 'p2'),
  p2: cursorPage(['b'], 'p3'),
  p3: cursorPage(['c']),
}

const rejected = () => new ApiError(400, 'invalid_cursor', 'This cursor was not issued here.')

describe('fetchEveryPage', () => {
  it('fetches every page in turn, each at the cursor the previous one gave', async () => {
    const cursors: (string | null)[] = []

    const items = await fetchEveryPage(async (cursor) => {
      cursors.push(cursor)
      return PAGES[cursor ?? 'first']
    })

    expect(cursors).toEqual([null, 'p2', 'p3'])
    expect(items).toEqual(['a', 'b', 'c'])
  })

  it('fails with the first page that fails', async () => {
    const failure = new ApiError(500, 'internal_error', 'The server failed.')

    const items = fetchEveryPage(async (cursor) => {
      if (cursor === 'p2') throw failure
      return PAGES[cursor ?? 'first']
    })

    await expect(items).rejects.toBe(failure)
  })

  it('starts again from the first page, once, when a cursor is rejected (I2)', async () => {
    const cursors: (string | null)[] = []
    let rejections = 1

    const items = await fetchEveryPage(async (cursor) => {
      cursors.push(cursor)
      if (cursor === 'p3' && rejections-- > 0) throw rejected()
      return PAGES[cursor ?? 'first']
    })

    expect(cursors).toEqual([null, 'p2', 'p3', null, 'p2', 'p3'])
    expect(items).toEqual(['a', 'b', 'c'])
  })

  it('fails when a cursor is rejected again after starting again', async () => {
    const failure = rejected()
    const cursors: (string | null)[] = []

    const items = fetchEveryPage(async (cursor) => {
      cursors.push(cursor)
      if (cursor === 'p2') throw failure
      return PAGES[cursor ?? 'first']
    })

    await expect(items).rejects.toBe(failure)
    expect(cursors).toEqual([null, 'p2', null, 'p2'])
  })

  it('does not start again when the first page is refused', async () => {
    const failure = rejected()
    let calls = 0

    const items = fetchEveryPage(async () => {
      calls++
      throw failure
    })

    await expect(items).rejects.toBe(failure)
    expect(calls).toBe(1)
  })
})
