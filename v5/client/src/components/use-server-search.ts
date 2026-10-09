import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SEARCH_DELAY_MS } from './suggestions'

export interface ServerSearch {
  /** The text in the input. */
  text: string
  setText(text: string): void
  /** The input holds text that has not been searched for yet. */
  pending: boolean
}

/**
 * The text of an input that searches the server (AR2 "Text filtering"): `search` is the text the
 * results are for, typically kept in the URL, and `onSearch` is called with the input's text once
 * typing pauses, trimmed, since spaces around it are never meant to be matched. Results for a text
 * the user has since changed are never shown, since each search is a query of its own; `pending`
 * says that the results shown are not yet for the input's text.
 *
 * The input starts with `search`, and takes it up whenever it changes for another reason than this
 * input's own search -- a page clearing it, say.
 */
export function useServerSearch(search: string, onSearch: (text: string) => void): ServerSearch {
  const [text, setText] = useState(search)
  // The `search` last seen, and the text this input searched for that has not come back as one yet.
  const [seen, setSeen] = useState(search)
  const [sent, setSent] = useState<string | null>(null)
  if (search !== seen) {
    setSeen(search)
    if (search === sent) setSent(null)
    else setText(search)
  }

  // The latest `onSearch`, so that a re-render does not restart the delay.
  const onSearchRef = useRef(onSearch)
  useLayoutEffect(() => {
    onSearchRef.current = onSearch
  })

  const term = text.trim()
  useEffect(() => {
    if (term === search) return
    const timer = setTimeout(() => {
      setSent(term)
      onSearchRef.current(term)
    }, SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [term, search])

  return { text, setText, pending: term !== search }
}
