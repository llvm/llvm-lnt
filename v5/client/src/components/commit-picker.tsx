import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchCommitPage, resolveCommits, type CommitFilters } from '../api/commits'
import { queryKeys } from '../api/keys'
import type { SuiteSchema } from '../api/suites'
import { commitDisplayValue, displayValueOf, type Commit } from '../schema'
import { Combobox } from './combobox'
import { PAGE_SIZE } from './pagination'
import { useServerSuggestions, type Suggestion } from './suggestions'

interface Props {
  label: string
  /** The suite to pick from, whose schema gives the commits' display values. */
  schema: SuiteSchema
  /** Which of the suite's commits the picker offers. Pass the same object while they are alike. */
  filters?: CommitFilters
  /** The commit string of the commit selected, or null for none. */
  value: string | null
  /** A commit was picked, or the input was emptied (null), which clears the selection. */
  onChange(value: string | null): void
  placeholder?: string
  isDisabled?: boolean
  /** Called with whether the input holds text that is not a commit picked (see `Combobox`). */
  onPendingChange?: (pending: boolean) => void
}

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
 * A commit the picker is given rather than one picked among its suggestions -- from the URL, say --
 * is shown by its display value, resolved through `POST commits/resolve`.
 */
export function CommitPicker({
  label,
  schema,
  filters = NO_FILTERS,
  value,
  onChange,
  placeholder,
  isDisabled = false,
  onPendingChange,
}: Props) {
  const suite = schema.name
  const toSuggestion = useCallback((commit: Commit) => suggestionOf(commit, schema), [schema])
  const suggestions = useServerSuggestions({
    queryKey: [...queryKeys.suite(suite), 'commits', 'suggestions', filters],
    fetchPage: (term, cursor, signal) =>
      fetchCommitPage(
        suite,
        { ...filters, search: term || undefined, limit: PAGE_SIZE, cursor },
        signal,
      ),
    toSuggestion,
    enabled: !isDisabled,
  })

  // The suggestion last picked, which already shows the value's display value.
  const [picked, setPicked] = useState<Suggestion | null>(null)
  const given = value !== null && picked?.key !== value
  const resolved = useQuery({
    queryKey: [...queryKeys.suite(suite), 'commits', 'resolve', value],
    queryFn: ({ signal }) => resolveCommits(suite, [value!], signal),
    enabled: given,
  })
  let selected: Suggestion | null = null
  if (value !== null) {
    selected = given ? { key: value, text: displayValueOf(value, resolved.data, schema) } : picked
  }

  return (
    <Combobox
      label={label}
      value={selected}
      onChange={(suggestion) => {
        setPicked(suggestion)
        onChange(suggestion?.key ?? null)
      }}
      suggestions={suggestions}
      placeholder={placeholder}
      isDisabled={isDisabled}
      onPendingChange={onPendingChange}
    />
  )
}

const NO_FILTERS: CommitFilters = {}
