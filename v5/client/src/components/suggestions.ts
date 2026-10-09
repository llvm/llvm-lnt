/**
 * Where a `Combobox` gets its suggestions from: a list already loaded in the browser, filtered as
 * the user types (`useLocalSuggestions`), or a server-side search (`useServerSuggestions`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { hashKey, useInfiniteQuery, type QueryKey } from '@tanstack/react-query'
import { cursorPaging, useRestartOnRejectedCursor, type CursorPage } from '../api/use-cursor-pages'

export interface Suggestion {
  /** What identifies the suggestion. */
  key: string
  /** What the suggestion shows, and what the input shows once it is picked. */
  text: string
  /**
   * Other texts that find it, and that Enter picks it by (AR2), such as the commit string of a
   * commit shown by its display value.
   */
  aliases?: readonly string[]
}

export interface Suggestions {
  /** The suggestions for the latest search, or for an earlier one while it is under way. */
  items: readonly Suggestion[]
  /** Whether the suggestions for the latest search are still on their way. */
  isLoading: boolean
  /**
   * Whether there are more suggestions to load, by scrolling to the end of the list. Not after
   * loading more failed, which would otherwise be retried for as long as the end is in view.
   */
  hasMore: boolean
  isLoadingMore: boolean
  loadMore: () => void
  error: Error | null
  /**
   * Search for `text`, the empty string for every suggestion. The combobox calls it whenever the
   * text changes; `immediate` asks to search without waiting for the user to stop typing.
   */
  search: (text: string, options?: { immediate?: boolean }) => void
}

function noMore() {}

/**
 * Suggestions from `all`, filtered by case-insensitive substring (AR2). Undefined while `all` is
 * still being loaded, or if loading it failed with `error`. Memoize `all`, as the suggestions are
 * filtered again when it changes.
 */
export function useLocalSuggestions(
  all: readonly Suggestion[] | undefined,
  error: Error | null = null,
): Suggestions {
  const [text, setText] = useState('')
  const lowered = useMemo(
    () =>
      (all ?? []).map((item) => ({
        item,
        texts: [item.text, ...(item.aliases ?? [])].map((t) => t.toLowerCase()),
      })),
    [all],
  )
  const items = useMemo(() => {
    const term = text.toLowerCase()
    return lowered.filter(({ texts }) => texts.some((t) => t.includes(term))).map(({ item }) => item)
  }, [lowered, text])
  return {
    items,
    isLoading: all === undefined && error === null,
    hasMore: false,
    isLoadingMore: false,
    loadMore: noMore,
    error,
    search: setText,
  }
}

/** Whether `searched`, the key of a search, is one of a search over `queryKey`, for any term. */
function sameQuery(searched: QueryKey, queryKey: QueryKey): boolean {
  return hashKey(searched.slice(0, -1)) === hashKey(queryKey)
}

/** How long typing must pause before a server-side search is sent, here or by `useServerSearch`. */
export const SEARCH_DELAY_MS = 250

interface ServerOptions<Item> {
  /** Must cover everything `fetchPage` depends on but the search term. */
  queryKey: QueryKey
  /** Fetch the page of matches for `term` at `cursor`, the first one when it is null. */
  fetchPage: (term: string, cursor: string | null, signal: AbortSignal) => Promise<CursorPage<Item>>
  /** Declare it outside the component, or memoize it, as the suggestions are rebuilt when it changes. */
  toSuggestion: (item: Item) => Suggestion
  /** While false, nothing is fetched. */
  enabled?: boolean
  delayMs?: number
}

/**
 * Suggestions from a cursor-paginated server-side search (AR2): the first page of matches for the
 * text, searched again once the user stops typing, and the next page when the user scrolls to the
 * end of the list. A response for text the user has since changed is never shown, since each text
 * is a query of its own; the previous text's suggestions stay up until the new ones arrive.
 */
export function useServerSuggestions<Item>({
  queryKey,
  fetchPage,
  toSuggestion,
  enabled = true,
  delayMs = SEARCH_DELAY_MS,
}: ServerOptions<Item>): Suggestions {
  // The latest text, and the one searched for, which lags behind while the user types.
  const [text, setText] = useState('')
  const [term, setTerm] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const search = useCallback(
    (next: string, { immediate = false } = {}) => {
      setText(next)
      clearTimeout(timer.current)
      if (immediate) setTerm(next)
      else timer.current = setTimeout(() => setTerm(next), delayMs)
    },
    [delayMs],
  )

  const fullKey = [...queryKey, term]
  const query = useInfiniteQuery({
    queryKey: fullKey,
    queryFn: ({ pageParam, signal }) => fetchPage(term, pageParam, signal),
    ...cursorPaging,
    // The previous text's suggestions stay up while the new text's load (AR2), but not those of
    // another `queryKey`: they are not suggestions at all under its filters, and could be picked.
    placeholderData: (previous, previousQuery) =>
      previousQuery !== undefined && sameQuery(previousQuery.queryKey, queryKey)
        ? previous
        : undefined,
    enabled,
  })
  const { data, error, hasNextPage, isFetchingNextPage, isPlaceholderData, isPending } = query
  const { fetchNextPage, isFetchNextPageError } = query
  // Settled once a page after the first has loaded since: a restart only refetches the first.
  const pageCount = data?.pages.length ?? 0
  useRestartOnRejectedCursor(query, fullKey, pageCount > 1 && !isFetchNextPageError)

  const items = useMemo(
    () => data?.pages.flatMap((page) => page.items.map(toSuggestion)) ?? [],
    [data, toSuggestion],
  )
  // A placeholder is the previous text's pages: their next page would not be this text's.
  const hasMore = hasNextPage && !isPlaceholderData && !isFetchNextPageError
  const loadMore = useCallback(() => {
    if (hasMore && !isFetchingNextPage) void fetchNextPage()
  }, [hasMore, isFetchingNextPage, fetchNextPage])

  return {
    items,
    isLoading: text !== term || isPlaceholderData || isPending,
    hasMore,
    isLoadingMore: isFetchingNextPage,
    loadMore,
    error,
    search,
  }
}
