import type { ServerSearch } from './use-server-search'
import styles from './search-input.module.css'

interface Props {
  search: ServerSearch
  /** The input's accessible name. */
  label: string
  placeholder: string
  /** Why the input's text is invalid, if it is (AR11): it shows the red halo, and says why. */
  invalid?: string
}

/**
 * The input of a search: of the server (see `useServerSearch`), or of rows already loaded (see
 * `useTextFilter`), which decides how its text matches (AR9).
 */
export function SearchInput({ search, label, placeholder, invalid }: Props) {
  return (
    <input
      type="search"
      className={styles.input}
      aria-label={label}
      placeholder={placeholder}
      aria-invalid={invalid !== undefined || undefined}
      title={invalid}
      value={search.text}
      onChange={(event) => search.setText(event.target.value)}
      spellCheck={false}
      autoComplete="off"
    />
  )
}
