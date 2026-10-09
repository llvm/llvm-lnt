import { useDeferredValue, useMemo } from 'react'
import { useServerSearch, type ServerSearch } from './use-server-search'

interface TextFilter<Row> {
  /** The input's text, which follows the keyboard, for a `SearchInput`. */
  input: ServerSearch
  /** Whether the rows are filtered. */
  active: boolean
  /**
   * The rows the filter keeps, in order. They follow the text typed once React has had the time to
   * filter and render them, so that typing never waits for thousands of rows (AR2 "Text filtering
   * performance").
   */
  rows: Row[]
}

/**
 * A client-side text filter (AR2 "Text filtering") over `rows`, matching a case-insensitive
 * substring of what `textOf` gives for each. Its text is kept in the URL as `stored`, written
 * through `onStore` once typing pauses, trimmed, as a server-side search is (see
 * `useServerSearch`), and the rows are filtered with the same trimmed text. Pass memoized `rows`
 * and a stable `textOf`.
 */
export function useTextFilter<Row>(
  rows: Row[],
  textOf: (row: Row) => string,
  stored: string,
  onStore: (text: string) => void,
): TextFilter<Row> {
  const input = useServerSearch(stored, onStore)
  const term = useDeferredValue(input.text.trim().toLowerCase())
  const kept = useMemo(
    () => (term === '' ? rows : rows.filter((row) => textOf(row).toLowerCase().includes(term))),
    [rows, textOf, term],
  )
  return { input, active: term !== '', rows: kept }
}
