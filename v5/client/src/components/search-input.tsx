import type { ServerSearch } from './use-server-search'
import styles from './search-input.module.css'

interface Props {
  search: ServerSearch
  /** The input's accessible name. */
  label: string
  placeholder: string
}

/**
 * The input of a search: of the server (see `useServerSearch`), or of rows already loaded (see
 * `useTextFilter`). It matches plain substrings, with no regex mode (AR2 "Text filtering").
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
