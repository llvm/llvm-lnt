import { useCallback } from 'react'
import { useQueries } from '@tanstack/react-query'
import type { Commit } from '../schema'
import { MAX_PAGE_SIZE } from './client'
import { branchFilter, fetchCommitPage, type BranchName } from './commits'
import { fetchEveryPage } from './fetch-every-page'
import { queryKeys } from './keys'
import type { SuiteRef } from './suites'

/** The root of the keys of the machines' scaffolds. */
export function scaffoldKey(suite: SuiteRef) {
  return [...queryKeys.commits(suite), 'scaffold'] as const
}

/** Why a machine's commits could not be listed, and how to list them again. */
export interface ScaffoldFailure {
  machine: string
  error: Error
  retry(): void
}

/** The x-axis of the Graph page (GR3), as far as it is known. */
export interface Scaffold {
  /** The branch whose commits are listed, once it is known. */
  branch: BranchName | undefined
  /**
   * The commits of the machines whose commits are listed, each once, in ordinal order: the
   * positions on the x-axis.
   */
  commits: Commit[]
  /** The machines whose commits are listed. */
  listed: ReadonlySet<string>
  /** Whether some machine's commits are still being listed. */
  pending: boolean
  failures: ScaffoldFailure[]
}

const NO_MACHINES: string[] = []

/**
 * The x-axis scaffold of `machines` on `branch` (GR3): the union of the commits of the branch each
 * has runs at, in ordinal order, each machine's listed by a query of its own, so that adding a
 * machine lists only its commits. Nothing is listed while the branch is not known. Under the
 * suite's commits, so that a change to an ordinal or a branch marks it stale (see `commitChanged`);
 * otherwise it is kept for as long as the page shows the suite (GR8; see `forgetGraphData`).
 */
export function useScaffold(
  suite: SuiteRef,
  branch: BranchName | undefined,
  machines: readonly string[],
): Scaffold {
  const asked = branch === undefined ? NO_MACHINES : machines
  // Run again only when a result, or the machines, change, so that the commits are the same array
  // from one render to the next until then.
  const combine = useCallback(
    (results: QueryResult[]) => combineScaffolds(branch, asked, results),
    [branch, asked],
  )
  return useQueries({
    queries: asked.map((machine) => ({
      queryKey: [...scaffoldKey(suite), branch, machine],
      // Every commit of the branch at which the machine has runs, leaving out those without an
      // ordinal.
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchEveryPage((cursor) => {
          const query = {
            machine,
            ...branchFilter(branch!),
            has_ordinal: true,
            sort: 'ordinal' as const,
            cursor,
            limit: MAX_PAGE_SIZE,
          }
          return fetchCommitPage(suite, query, signal)
        }),
      staleTime: Infinity,
      gcTime: Infinity,
    })),
    combine,
  })
}

/** The parts of a machine's query result the scaffold is made of. */
interface QueryResult {
  data?: Commit[]
  error: Error | null
  refetch: () => unknown
}

/** The union of the commits of `machines` on `branch`, from the results of their queries. */
function combineScaffolds(
  branch: BranchName | undefined,
  machines: readonly string[],
  results: QueryResult[],
): Scaffold {
  const commits = new Map<string, Commit>()
  for (const { data } of results) for (const commit of data ?? []) commits.set(commit.value, commit)
  return {
    branch,
    // Every commit listed has an ordinal: `has_ordinal=true` leaves out those without one.
    commits: [...commits.values()].sort((a, b) => a.ordinal! - b.ordinal!),
    listed: new Set(machines.filter((_, i) => results[i].data !== undefined)),
    pending: results.some((result) => result.data === undefined && result.error === null),
    failures: results.flatMap(({ error, refetch }, i) =>
      error === null ? [] : [{ machine: machines[i], error, retry: () => void refetch() }],
    ),
  }
}
