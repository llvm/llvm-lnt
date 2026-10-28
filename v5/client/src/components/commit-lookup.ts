/** What a commit picker knows of a commit (AR15), apart from the picker, for others to share. */

import { queryOptions, useQuery, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { lookUpCommit, type CommitFilters } from '../api/commits'
import { queryKeys } from '../api/keys'
import type { SuiteSchema } from '../api/suites'
import { commitDisplayValue, type Commit } from '../schema'
import type { Suggestion } from './suggestions'

/** A suggestion of a commit picker, carrying the commit it is, for its card (AR21). */
export interface CommitSuggestion extends Suggestion {
  commit: Commit
}

/** A commit as a suggestion: shown by its display value, and entered by its commit string too. */
export function suggestionOf(commit: Commit, schema: SuiteSchema): CommitSuggestion {
  const text = commitDisplayValue(commit, schema)
  const aliases = text === commit.value ? undefined : [commit.value]
  return { key: commit.value, text, aliases, commit }
}

/** The query key of the lookup of `commit` among the suite's commits under `filters`. */
export function commitLookupKey(suite: string, filters: CommitFilters, commit: string): QueryKey {
  return [...queryKeys.commits(suite), 'lookup', filters, commit]
}

/**
 * Whether the suite's commits under `filters` hold `commit`: as a suggestion, with its display
 * value, if they do, and null if not (AR15). A commit known to be held, such as one picked, has its
 * answer stored (see `storeCommitLookup`), which stays fresh for the default `staleTime`, so that
 * the commit is not looked up meanwhile.
 */
export function commitLookupQuery(schema: SuiteSchema, filters: CommitFilters, commit: string) {
  return queryOptions({
    queryKey: commitLookupKey(schema.name, filters, commit),
    queryFn: async ({ signal }): Promise<CommitSuggestion | null> => {
      const found = await lookUpCommit(schema.name, filters, commit, signal)
      return found && suggestionOf(found, schema)
    },
  })
}

/** Store that the suite's commits under `filters` hold `commit`, as its lookup would answer. */
export function storeCommitLookup(
  queryClient: QueryClient,
  suite: string,
  filters: CommitFilters,
  commit: CommitSuggestion,
) {
  queryClient.setQueryData(commitLookupKey(suite, filters, commit.key), commit)
}

/**
 * The commit `commit` as a commit picker under `filters` knows it, once the picker has looked it up,
 * or stored it when picked. It reads the picker's lookup rather than asking for it again, so pass
 * the picker's own filters.
 */
export function usePickedCommit(schema: SuiteSchema, filters: CommitFilters, commit: string) {
  // The picker keeps its lookup fresh: another reader need not fetch it again when it appears.
  const lookup = useQuery({ ...commitLookupQuery(schema, filters, commit), refetchOnMount: false })
  return lookup.data ?? undefined
}

/**
 * The commit `commit` as a commit picker under `filters` shows it: by its display value once the
 * picker has looked it up, and by its commit string until then (see `usePickedCommit`).
 */
export function usePickedCommitText(schema: SuiteSchema, filters: CommitFilters, commit: string) {
  return usePickedCommit(schema, filters, commit)?.text ?? commit
}
