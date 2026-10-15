import { useCallback, useLayoutEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PAGE_SIZE } from '../api/client'
import { fetchCommitPage, type CommitFilters } from '../api/commits'
import { queryKeys } from '../api/keys'
import type { SuiteSchema } from '../api/suites'
import type { Commit } from '../schema'
import { useDropUnusable } from '../url-state'
import { Combobox } from './combobox'
import { commitLookupKey, commitLookupQuery, suggestionOf } from './commit-lookup'
import { ErrorMessage } from './feedback'
import { useServerSuggestions, type Suggestion } from './suggestions'
import styles from './commit-picker.module.css'

interface CommonProps {
  label: string
  /** The suite to pick from, whose schema gives the commits' display values. */
  schema: SuiteSchema
  /** Which of the suite's commits the picker offers. Pass the same object while they are alike. */
  filters?: CommitFilters
  placeholder?: string
  /** What the picker says when it has no commit to offer at all (see `Combobox`). */
  emptyMessage?: string
  isDisabled?: boolean
  /** See `Combobox`. */
  isReadOnly?: boolean
  /** See `Combobox`. */
  hideLabel?: boolean
  /** Called with whether the input holds text that is not a commit picked (see `Combobox`). */
  onPendingChange?: (pending: boolean) => void
  /**
   * Whether to report a failed lookup of the given commit (AR7). Turn it off while the filters may
   * name something that does not exist, such as a machine from the URL. The page does not report
   * failures for values that it is going to drop (AR2 "State").
   */
  reportsLookupFailure?: boolean
}

/** A picker holding a commit. */
interface ValueProps {
  /** The commit string of the commit selected, or null for none. */
  value: string | null
  /**
   * A commit was picked, or the selection was cleared (null): because the input was emptied, or
   * because the commit given is not one the picker offers (AR15). The latter may be reported more
   * than once before `value` changes, so clearing must be idempotent, as a URL write is.
   */
  onChange(value: string | null): void
  onPick?: never
}

/**
 * A picker that hands the commit picked to something else, and is emptied (see `Combobox`). What it
 * knows of the commit -- that the picker offers it, and its display value -- is stored as the
 * answer to its lookup (see `commitLookupQuery`).
 */
interface PickProps {
  onPick(value: string): void
  value?: never
  onChange?: never
}

type Props = CommonProps & (ValueProps | PickProps)

/**
 * Why a form holding a commit picker cannot be submitted while the picker holds text that was not
 * picked (AR15).
 */
export const UNPICKED_COMMIT = 'Pick a commit from the list, or clear the field.'

/**
 * A combobox selecting a commit (AR15). It searches the server rather than filtering a list it
 * holds, since a suite can have tens of thousands of commits: its suggestions are the pages of
 * `GET commits?sort=-first_seen` under its filters, most recently seen first, searched with
 * `search=` once typing pauses, and the next page is loaded when the list is scrolled to its end.
 * The suggestions and the input show display values, and Enter also takes a commit string.
 *
 * A commit the picker is given rather than one picked among its suggestions -- from the URL, or
 * kept while its filters change -- is looked up with the picker's filters plus `commit=`, which
 * returns it, with its display value, only if the picker offers it. If the lookup
 * returns nothing, the commit is unusable, and the picker is cleared as if the input had been
 * emptied. If the lookup fails, the picker clears nothing (AR2 "State"). It shows the error below
 * the input, with a way to try again (AR7). If the lookup already answered once and a later
 * refetch fails, the picker shows no error and keeps showing the earlier answer.
 */
export function CommitPicker({
  label,
  schema,
  filters = NO_FILTERS,
  value = null,
  onChange,
  onPick,
  placeholder,
  emptyMessage,
  isDisabled = false,
  isReadOnly,
  hideLabel,
  onPendingChange,
  reportsLookupFailure = true,
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
  // filters change, is looked up.
  const queryClient = useQueryClient()
  const store = (suggestion: Suggestion) =>
    queryClient.setQueryData(commitLookupKey(suite, filters, suggestion.key), suggestion)
  const lookup = useQuery({
    ...commitLookupQuery(schema, filters, value ?? ''),
    enabled: value !== null,
    // While the same commit is looked up under new filters, keep showing it as it was.
    placeholderData: (previous) => (previous?.key === value ? previous : undefined),
  })
  useDropUnusable(lookup, (found) => found !== null, () => onChange?.(null))
  const selected = value === null ? null : (lookup.data ?? { key: value, text: value })

  const handlers = onPick
    ? {
        onPick: (suggestion: Suggestion) => {
          store(suggestion)
          onPick(suggestion.key)
        },
      }
    : {
        value: selected,
        onChange: (suggestion: Suggestion | null) => {
          if (suggestion) store(suggestion)
          onChange(suggestion?.key ?? null)
        },
      }
  // When a Retry succeeds, the error and its Retry button disappear. Move the focus back to the
  // input, so that it does not fall to the page, where keys such as Enter and Escape would be lost.
  const root = useRef<HTMLDivElement>(null)
  const retried = useRef(false)
  const failed = lookup.isLoadingError && reportsLookupFailure
  useLayoutEffect(() => {
    if (failed || !retried.current) return
    retried.current = false
    root.current?.querySelector('input')?.focus()
  }, [failed])

  return (
    <div ref={root} className={styles.root}>
      <Combobox
        label={label}
        {...handlers}
        suggestions={suggestions}
        placeholder={placeholder}
        emptyMessage={emptyMessage}
        isDisabled={isDisabled}
        isReadOnly={isReadOnly}
        hideLabel={hideLabel}
        onPendingChange={onPendingChange}
      />
      {failed && (
        <ErrorMessage
          context="The commit could not be looked up"
          error={lookup.error}
          onRetry={() => {
            retried.current = true
            void lookup.refetch()
          }}
        />
      )}
    </div>
  )
}

const NO_FILTERS: CommitFilters = {}
