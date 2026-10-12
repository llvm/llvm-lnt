import { useDeferredValue, useMemo, useState } from 'react'
import { useServerSearch, type ServerSearch } from './use-server-search'

interface TextFilter<Row> {
  /** The input's text, which follows the keyboard, for a `SearchInput`. */
  input: ServerSearch
  /** Whether the rows are filtered. */
  active: boolean
  /**
   * The rows the filter keeps, in order. They follow the text typed once React has had the time to
   * filter and render them, so that typing never waits for thousands of rows (AR9).
   */
  rows: Row[]
  /** Why the input's text is not a valid regex, in regex mode, for the input to say (AR11). */
  invalid?: string
}

/**
 * A filter that the rows are matched with: its trimmed text, and the regex it compiles to, in regex
 * mode, or null to match the text as a substring.
 */
interface Filter {
  term: string
  pattern: RegExp | null
}

const NO_FILTER: Filter = { term: '', pattern: null }

const INVALID_REGEX = 'Not a valid regular expression.'

/**
 * The regex `term` compiles to, case-insensitive, or null if it is not one. No `g` flag, which
 * would carry the position of a match over from one row to the next, and no `u` or `v`, which
 * change which patterns are valid. A pattern that backtracks catastrophically, like `(a+)+$`, can
 * still hold up the page while it filters: the user typed it, and can change it.
 */
function compile(term: string): RegExp | null {
  try {
    return new RegExp(term, 'i')
  } catch {
    return null
  }
}

/** The filter for `term` in the mode `regex`, or null if it is not a valid regex. */
function filterOf(term: string, regex: boolean): Filter | null {
  if (!regex) return { term, pattern: null }
  const pattern = compile(term)
  return pattern === null ? null : { term, pattern }
}

/** What a row's text must satisfy to be kept, or null to keep every row. */
function matcherOf({ term, pattern }: Filter): ((text: string) => boolean) | null {
  if (term === '') return null
  if (pattern !== null) return (text) => pattern.test(text)
  const lowered = term.toLowerCase()
  return (text) => text.toLowerCase().includes(lowered)
}

/**
 * A client-side text filter (AR9) over `rows`, matching a case-insensitive substring of what
 * `textOf` gives for each, or with `regex`, a case-insensitive regex. Its text is kept in the URL
 * as `stored`, written through `onStore` once typing pauses, trimmed, as a server-side search is
 * (see `useServerSearch`), and the rows are filtered with the same trimmed text. Pass memoized
 * `rows` and a stable `textOf`.
 *
 * While the text is not a valid regex, `invalid` says so, and the rows are filtered as they last
 * were with a valid filter: the last valid regex, or, right after switching to regex mode, the same
 * text as a substring. None at all if no valid one has been applied yet.
 */
export function useTextFilter<Row>(
  rows: Row[],
  textOf: (row: Row) => string,
  stored: string,
  onStore: (text: string) => void,
  { regex = false }: { regex?: boolean } = {},
): TextFilter<Row> {
  const input = useServerSearch(stored, onStore)
  const term = useDeferredValue(input.text.trim())

  // The filter applied: the latest valid one. Kept in state rather than derived, so that it
  // survives the text becoming invalid.
  const current = filterOf(term, regex)
  const [applied, setApplied] = useState(current ?? NO_FILTER)
  if (
    current !== null &&
    (current.term !== applied.term || (current.pattern === null) !== (applied.pattern === null))
  ) {
    setApplied(current)
  }

  const kept = useMemo(() => {
    const matches = matcherOf(applied)
    return matches === null ? rows : rows.filter((row) => matches(textOf(row)))
  }, [rows, textOf, applied])
  // Of the text as typed rather than as deferred, so that the halo follows the keyboard.
  const typed = input.text.trim()
  const valid = (typed === term ? current : filterOf(typed, regex)) !== null
  const invalid = valid ? undefined : INVALID_REGEX
  return { input, active: applied.term !== '', rows: kept, invalid }
}
