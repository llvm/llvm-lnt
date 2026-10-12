/** What a commit picker knows of a commit (AR15), apart from the picker, for others to share. */

import { queryOptions, type QueryKey } from '@tanstack/react-query'
import { lookUpCommit, type CommitFilters } from '../api/commits'
import { queryKeys } from '../api/keys'
import type { SuiteSchema } from '../api/suites'
import { commitDisplayValue, type Commit } from '../schema'
import type { Suggestion } from './suggestions'

/** A commit as a suggestion: shown by its display value, and entered by its commit string too. */
export function suggestionOf(commit: Commit, schema: SuiteSchema): Suggestion {
  const text = commitDisplayValue(commit, schema)
  return { key: commit.value, text, aliases: text === commit.value ? undefined : [commit.value] }
}

/** The query key of the lookup of `commit` among the suite's commits under `filters`. */
export function commitLookupKey(suite: string, filters: CommitFilters, commit: string): QueryKey {
  return [...queryKeys.commits(suite), 'lookup', filters, commit]
}

/**
 * Whether the suite's commits under `filters` hold `commit`: as a suggestion, with its display
 * value, if they do, and null if not (AR15). A picker stores the answer for a commit picked, which
 * stays fresh for the default `staleTime`, so that the commit is not looked up again meanwhile.
 */
export function commitLookupQuery(schema: SuiteSchema, filters: CommitFilters, commit: string) {
  return queryOptions({
    queryKey: commitLookupKey(schema.name, filters, commit),
    queryFn: async ({ signal }): Promise<Suggestion | null> => {
      const found = await lookUpCommit(schema.name, filters, commit, signal)
      return found && suggestionOf(found, schema)
    },
  })
}
