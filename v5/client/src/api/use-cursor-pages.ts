import { useEffect, useMemo, useRef } from 'react'
import { hashKey, useInfiniteQuery, type QueryKey } from '@tanstack/react-query'
import { ApiError } from './client'

/** I2's cursor envelope, whichever items it carries. */
export interface CursorPage<Item> {
  items: Item[]
  cursor: { next: string | null }
}

/** What an infinite query over I2's cursor pages needs to go from one page to the next. */
export const cursorPaging = {
  initialPageParam: null as string | null,
  getNextPageParam: (last: CursorPage<unknown>) => last.cursor.next,
}

interface Options<Item> {
  /** Must cover everything `fetchPage` depends on, since the pages are cached under it. */
  queryKey: QueryKey
  /** Fetch the page at `cursor`, the first one when it is null. */
  fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<CursorPage<Item>>
  /** While false, nothing is fetched, and `isPending` stays true. */
  enabled?: boolean
  staleTime?: number
}

export interface CursorPages<Item> {
  /** Every item fetched so far, in order. */
  items: Item[]
  /** Nothing has been fetched yet. */
  isPending: boolean
  /** Every page has been fetched. */
  isComplete: boolean
  /** Why fetching stopped, if it failed. The pages fetched before then are still in `items`. */
  error: Error | null
}

/**
 * Fetch every page of a cursor-paginated endpoint, one after the other, so that a page can render
 * the items as they arrive rather than wait for all of them.
 *
 * The pages are cached under `queryKey` like any query: a page that unmounts part-way through
 * cancels the request in flight, and resumes from the pages already fetched when it mounts again.
 * A page that fails stops the sequence, and the pages before it are kept, except that a rejected
 * cursor starts it again (see `useRestartOnRejectedCursor`).
 *
 * `items` is rebuilt as each page arrives, so fetch large pages (up to I2's maximum of 10 000) when
 * there may be many items: with small ones, the copying grows with the square of their number.
 */
export function useCursorPages<Item>({
  fetchPage,
  ...options
}: Options<Item>): CursorPages<Item> {
  const query = useInfiniteQuery({
    // Spread rather than named, because an option given as `undefined` overrides the client's
    // default for it rather than leaving it in place.
    ...options,
    queryFn: ({ pageParam, signal }) => fetchPage(pageParam, signal),
    ...cursorPaging,
  })
  const { data, error, hasNextPage, isFetching, isError, isPending, fetchNextPage } = query
  const isComplete = !isPending && !hasNextPage && !isError

  // Keyed on `data` too: a page can arrive within the render that started fetching it, so that
  // `isFetching` never seems to change.
  useEffect(() => {
    if (hasNextPage && !isFetching && !isError) void fetchNextPage()
  }, [data, hasNextPage, isFetching, isError, fetchNextPage])

  useRestartOnRejectedCursor(query, options.queryKey, isComplete)

  const items = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data])
  return { items, isPending, isComplete, error }
}

/** The parts of an infinite query that restarting it after a rejected cursor needs. */
interface Restartable {
  error: Error | null
  isFetchNextPageError: boolean
  refetch: () => unknown
}

/**
 * Start the pages of `query` again from the first one when the server rejects the cursor of a
 * later one (a 400), which may only mean that the server or the suite's schema changed since it was
 * issued (I2). A refetch starts from the first page, and takes each later cursor from the page
 * before it. The query is restarted once until `settled` says that its pages are good again, so
 * that a cursor rejected for any other reason is reported rather than retried forever.
 */
export function useRestartOnRejectedCursor(
  query: Restartable,
  queryKey: QueryKey,
  settled: boolean,
): void {
  const { error, isFetchNextPageError, refetch } = query
  // The query restarted since it last settled, if any.
  const restarted = useRef<string | null>(null)
  const key = hashKey(queryKey)
  useEffect(() => {
    if (settled) {
      restarted.current = null
    } else if (rejectsCursor(isFetchNextPageError, error) && restarted.current !== key) {
      restarted.current = key
      void refetch()
    }
  }, [settled, isFetchNextPageError, error, key, refetch])
}

function rejectsCursor(isFetchNextPageError: boolean, error: Error | null): boolean {
  return isFetchNextPageError && error instanceof ApiError && error.status === 400
}
