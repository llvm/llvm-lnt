import type { ServerSearch } from './use-server-search'
import styles from './search-input.module.css'

interface Props {
  search: ServerSearch
  /** The input's accessible name. */
  label: string
  placeholder: string
}

/**
 * The input of a server-side search (see `useServerSearch`). It matches plain substrings, so it
 * has no regex mode, unlike the client-side text filters (AR2).
 */
export function SearchInput({ search, label, placeholder }: Props) {
  return (
    <input
      type="search"
      className={styles.input}
      aria-label={label}
      placeholder={placeholder}
      value={search.text}
      onChange={(event) => search.setText(event.target.value)}
      spellCheck={false}
      autoComplete="off"
    />
  )
}
