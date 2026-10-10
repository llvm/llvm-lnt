import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PAGE_SIZE } from '../api/client'
import { fetchCommitPage, lookUpCommit, type CommitFilters } from '../api/commits'
import { queryKeys } from '../api/keys'
import type { SuiteSchema } from '../api/suites'
import { commitDisplayValue, type Commit } from '../schema'
import { useDropUnusable } from '../url-state'
import { Combobox } from './combobox'
import { useServerSuggestions, type Suggestion } from './suggestions'

interface Props {
  label: string
  /** The suite to pick from, whose schema gives the commits' display values. */
  schema: SuiteSchema
  /** Which of the suite's commits the picker offers. Pass the same object while they are alike. */
  filters?: CommitFilters
  /** The commit string of the commit selected, or null for none. */
  value: string | null
  /**
   * A commit was picked, or the selection was cleared (null): because the input was emptied, or
   * because the commit given is not one the picker offers (AR2). The latter may be reported more
   * than once before `value` changes, so clearing must be idempotent, as a URL write is.
   */
  onChange(value: string | null): void
  placeholder?: string
  isDisabled?: boolean
  /** See `Combobox`. */
  isReadOnly?: boolean
  /** See `Combobox`. */
  hideLabel?: boolean
  /** Called with whether the input holds text that is not a commit picked (see `Combobox`). */
  onPendingChange?: (pending: boolean) => void
}

/**
 * Why a form holding a commit picker cannot be submitted while the picker holds text that was not
 * picked (AR2 "Commit pickers").
 */
export const UNPICKED_COMMIT = 'Pick a commit from the list, or clear the field.'

/** A commit as a suggestion: shown by its display value, and entered by its commit string too. */
function suggestionOf(commit: Commit, schema: SuiteSchema): Suggestion {
  const text = commitDisplayValue(commit, schema)
  return { key: commit.value, text, aliases: text === commit.value ? undefined : [commit.value] }
}

/**
 * A combobox selecting a commit (AR2 "Commit pickers"). It searches the server rather than
 * filtering a list it holds, since a suite can have tens of thousands of commits: its suggestions
 * are the pages of `GET commits?sort=-first_seen` under its filters, most recently seen first,
 * searched with `search=` once typing pauses, and the next page is loaded when the list is
 * scrolled to its end. The suggestions and the input show display values, and Enter also takes a
 * commit string.
 *
 * A commit the picker is given rather than one picked among its suggestions -- from the URL, or
 * kept while its filters change -- is looked up with the picker's filters plus `commit=`, which
 * returns it, with its display value, only if the picker offers it. If the lookup
 * returns nothing, the commit is unusable, and the picker is cleared as if the input had been
 * emptied. A lookup that fails clears nothing (AR2 "State").
 */
export function CommitPicker({
  label,
  schema,
  filters = NO_FILTERS,
  value,
  onChange,
  placeholder,
  isDisabled = false,
  isReadOnly,
  hideLabel,
  onPendingChange,
}: Props) {
  const suite = schema.name
  const toSuggestion = useCallback((commit: Commit) => suggestionOf(commit, schema), [schema])
  const suggestions = useServerSuggestions({
    queryKey: [...queryKeys.commits(suite), 'suggestions', filters],
    fetchPage: (term, cursor, signal) =>
      fetchCommitPage(
        suite,
        { ...filters, search: term || undefined, limit: PAGE_SIZE, cursor },
        signal,
      ),
    toSuggestion,
    enabled: !isDisabled,
  })

  // The commit `value`, as a suggestion, if the picker offers it under its filters, and null if
  // not. A pick stores the answer for the commit picked, since the suggestions are those of the
  // current filters (see `useServerSuggestions`), so that only a commit given, or kept while the
  // filters change, is looked up. The stored answer is fresh for the default `staleTime`, which is
  // what keeps a pick from being looked up again.
  const queryClient = useQueryClient()
  const lookupKey = (commit: string | null) => [
    ...queryKeys.commits(suite),
    'lookup',
    filters,
    commit,
  ]
  const lookup = useQuery({
    queryKey: lookupKey(value),
    queryFn: async ({ signal }) => {
      const commit = await lookUpCommit(suite, filters, value!, signal)
      return commit && suggestionOf(commit, schema)
    },
    enabled: value !== null,
    // While the same commit is looked up under new filters, keep showing it as it was.
    placeholderData: (previous) => (previous?.key === value ? previous : undefined),
  })
  useDropUnusable(lookup, (found) => found !== null, () => onChange(null))
  const selected = value === null ? null : (lookup.data ?? { key: value, text: value })

  return (
    <Combobox
      label={label}
      value={selected}
      onChange={(suggestion) => {
        if (suggestion) queryClient.setQueryData(lookupKey(suggestion.key), suggestion)
        onChange(suggestion?.key ?? null)
      }}
      suggestions={suggestions}
      placeholder={placeholder}
      isDisabled={isDisabled}
      isReadOnly={isReadOnly}
      hideLabel={hideLabel}
      onPendingChange={onPendingChange}
    />
  )
}

const NO_FILTERS: CommitFilters = {}
