import type { ServerSearch } from './use-server-search'
import { SearchInput } from './search-input'
import styles from './regex-filter.module.css'

interface Props {
  /** The filter's input, and why its text is invalid, if it is (see `useTextFilter`). */
  filter: { input: ServerSearch; invalid?: string }
  /** The input's accessible name. */
  label: string
  placeholder: string
  /** Whether the text is matched as a regex rather than as a substring. */
  regex: boolean
  onRegexChange(regex: boolean): void
  isDisabled?: boolean
}

/**
 * The input of a client-side filter with a regex mode (AR9), such as the test filters of the Graph
 * and Compare pages: the text, and a "Regex" checkbox beside it. While the text is not a valid
 * regex, the input shows the red halo (AR11) and says why on hover.
 */
export function RegexFilter({
  filter,
  label,
  placeholder,
  regex,
  onRegexChange,
  isDisabled,
}: Props) {
  return (
    <div className={styles.root}>
      <SearchInput
        search={filter.input}
        label={label}
        placeholder={placeholder}
        invalid={filter.invalid}
        isDisabled={isDisabled}
      />
      <label className={styles.mode}>
        <input
          type="checkbox"
          checked={regex}
          disabled={isDisabled}
          onChange={(event) => onRegexChange(event.target.checked)}
        />
        Regex
      </label>
    </div>
  )
}
