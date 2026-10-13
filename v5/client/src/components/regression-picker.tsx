import { PAGE_SIZE } from '../api/client'
import { queryKeys } from '../api/keys'
import { fetchRegressions } from '../api/regressions'
import { shortUuid } from '../format'
import { Combobox } from './combobox'
import { useServerSuggestions, type Suggestion } from './suggestions'

/** A regression, as far as a picker names it. */
export interface PickedRegression {
  uuid: string
  title: string | null
}

/** A suggestion of the picker, carrying the regression it is, to hand it back once picked. */
interface RegressionSuggestion extends Suggestion {
  regression: PickedRegression
}

/** A regression's suggestion: its title, or `(untitled)` and its short UUID, found by its UUID. */
function suggestionOf({ uuid, title }: PickedRegression): RegressionSuggestion {
  return {
    key: uuid,
    text: title ?? `(untitled) ${shortUuid(uuid)}`,
    aliases: [uuid],
    regression: { uuid, title },
  }
}

/**
 * Why a form holding a regression picker cannot be submitted while the picker holds text that was
 * not picked (AR15).
 */
export const UNPICKED_REGRESSION = 'Pick a regression from the list, or clear the field.'

interface Props {
  label: string
  suite: string
  /** The regression picked, or null for none. */
  value: PickedRegression | null
  onChange(value: PickedRegression | null): void
  placeholder?: string
  isDisabled?: boolean
  /** Called with whether the input holds text that is not a regression picked (see `Combobox`). */
  onPendingChange?: (pending: boolean) => void
}

/**
 * A combobox selecting one of the suite's regressions (CP9). It searches the server (AR9): its
 * suggestions are the pages of `GET regressions?sort=-created_at`, the newest first, searched by
 * title or UUID prefix with `search=` once typing pauses.
 */
export function RegressionPicker({
  label,
  suite,
  value,
  onChange,
  placeholder,
  isDisabled = false,
  onPendingChange,
}: Props) {
  const suggestions = useServerSuggestions({
    queryKey: [...queryKeys.regressions(suite), 'suggestions'],
    fetchPage: (term, cursor, signal) =>
      fetchRegressions(
        suite,
        { sort: '-created_at', search: term || undefined, limit: PAGE_SIZE, cursor },
        signal,
      ),
    toSuggestion: suggestionOf,
    enabled: !isDisabled,
  })
  return (
    <Combobox
      label={label}
      suggestions={suggestions}
      value={value && suggestionOf(value)}
      // Every suggestion is one of `suggestionOf`'s.
      onChange={(picked) => onChange(picked && (picked as RegressionSuggestion).regression)}
      placeholder={placeholder}
      isDisabled={isDisabled}
      onPendingChange={onPendingChange}
    />
  )
}
