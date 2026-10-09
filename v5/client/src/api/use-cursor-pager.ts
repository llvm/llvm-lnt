import { useState } from 'react'
import { hashKey, keepPreviousData, useQuery, type QueryKey } from '@tanstack/react-query'
import { shownData } from './shown-data'
import { rejectsCursor, type CursorPage } from './use-cursor-pages'

type Paged = CursorPage<unknown>

interface Options<Page extends Paged> {
  /**
   * Must cover everything `fetchPage` depends on but the cursor, which is added to it. When it
   * changes -- another search, say -- the pager starts again from the first page.
   */
  queryKey: QueryKey
  /** Fetch the page at `cursor`, the first one when it is null. */
  fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<Page>
  /** While false, nothing is fetched, and `isPending` stays true. */
  enabled?: boolean
}

export interface CursorPagerState<Page> {
  /**
   * The page shown: the previous one while the one asked for loads, and none when it failed or is
   * being tried again, so that the failure is not shown next to rows for another page or search.
   */
  page: Page | undefined
  /** There is no page to show, and no failure: the first page, or a retry, is on its way. */
  isPending: boolean
  /** The page shown is not the one asked for, which is on its way. */
  isUpdating: boolean
  error: Error | null
  /** Ask for the page that failed again. */
  retry(): void
  hasPrevious: boolean
  hasNext: boolean
  previous(): void
  next(): void
}

/**
 * A cursor-paginated endpoint shown a page at a time, with Previous and Next (AR2 "Paginated
 * tables"). Pagination is forward-only (I2), so Previous returns to a page already visited, which
 * comes from the cache. The position is component state rather than part of the URL, so a reload
 * shows the first page again.
 *
 * When a page fails to load, the pager has no page to show, only the error and `retry`. A cursor
 * the server rejects (see `rejectsCursor`) starts the pager again from a first page fetched afresh,
 * since a cached one would only hand out the same cursor again.
 */
export function useCursorPager<Page extends Paged>({
  queryKey,
  fetchPage,
  enabled = true,
}: Options<Page>): CursorPagerState<Page> {
  // The cursors of the pages after the first that lead to the one shown, for the query `identity`,
  // and how many times the pager started again from scratch, which every page's key includes.
  const identity = hashKey(queryKey)
  const [position, setPosition] = useState({ identity, generation: 0, cursors: [] as string[] })
  const { generation } = position
  if (position.identity !== identity) setPosition({ identity, generation, cursors: [] })
  // React renders again at once with the reset state; meanwhile, query nothing with a stale cursor.
  const cursors = position.identity === identity ? position.cursors : []
  const cursor = cursors.at(-1) ?? null

  const query = useQuery({
    queryKey: [...queryKey, { cursor, generation }],
    queryFn: ({ signal }) => fetchPage(cursor, signal),
    // Keep the page shown until the next one arrives, rather than flash a loading state.
    placeholderData: keepPreviousData,
    enabled,
  })
  const { data, error, isPlaceholderData, refetch } = query
  const page = shownData(query)

  if (cursor !== null && rejectsCursor(error)) {
    setPosition({ identity, generation: generation + 1, cursors: [] })
  }

  const moveTo = (to: string[]) => setPosition({ identity, generation, cursors: to })
  // Only the page asked for, once it has arrived, leads further.
  const nextCursor = isPlaceholderData ? null : (data?.cursor.next ?? null)
  return {
    page,
    isPending: page === undefined && error === null,
    isUpdating: isPlaceholderData,
    error,
    retry: () => void refetch(),
    hasPrevious: cursors.length > 0 && !isPlaceholderData,
    hasNext: nextCursor !== null,
    previous: () => moveTo(cursors.slice(0, -1)),
    next: () => {
      if (nextCursor !== null) moveTo([...cursors, nextCursor])
    },
  }
}
