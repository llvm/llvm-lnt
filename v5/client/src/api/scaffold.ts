import { useCallback } from 'react'
import { useQueries } from '@tanstack/react-query'
import type { Commit } from '../schema'
import { api, MAX_PAGE_SIZE, unwrap } from './client'
import { fetchEveryPage } from './fetch-every-page'
import { queryKeys } from './keys'

/** The commits of one machine, as cached. */
interface MachineCommits {
  machine: string
  commits: Commit[]
}

/** Why a machine's commits could not be listed, and how to list them again. */
export interface ScaffoldFailure {
  machine: string
  error: Error
  retry(): void
}

/** The x-axis of the Graph page (GR3), as far as it is known. */
export interface Scaffold {
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

/** Every commit at which `machine` has runs, in ordinal order, leaving out those without one. */
async function fetchMachineCommits(
  suite: string,
  machine: string,
  signal: AbortSignal,
): Promise<MachineCommits> {
  const commits = await fetchEveryPage((cursor) =>
    unwrap(
      api.GET('/api/suites/{testsuite}/commits', {
        params: {
          path: { testsuite: suite },
          query: { machine, sort: 'ordinal', cursor, limit: MAX_PAGE_SIZE },
        },
        signal,
      }),
    ),
  )
  return { machine, commits }
}

/**
 * The x-axis scaffold of `machines` (GR3): the union of the commits each has runs at, in ordinal
 * order, each machine's listed by a query of its own, so that adding a machine lists only its
 * commits. Under the suite's commits, so that a change to an ordinal marks it stale (see
 * `commitChanged`); otherwise it is kept for as long as the page shows it.
 */
export function useScaffold(suite: string, machines: readonly string[]): Scaffold {
  // Run again only when a result, or the machines, change, so that the commits are the same array
  // from one render to the next until then.
  const combine = useCallback(
    (results: QueryResult<MachineCommits>[]) => combineScaffolds(machines, results),
    [machines],
  )
  return useQueries({
    queries: machines.map((machine) => ({
      queryKey: [...queryKeys.commits(suite), 'scaffold', machine],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchMachineCommits(suite, machine, signal),
      staleTime: Infinity,
    })),
    combine,
  })
}

/** The parts of a query's result the scaffold is made of. */
interface QueryResult<Data> {
  data?: Data
  error: Error | null
  refetch: () => unknown
}

/** The union of the commits of `machines`, from the results of their queries, in order. */
function combineScaffolds(
  machines: readonly string[],
  results: QueryResult<MachineCommits>[],
): Scaffold {
  const listed = results.flatMap((result) => (result.data ? [result.data] : []))
  const commits = new Map<string, Commit>()
  for (const { commits: ofMachine } of listed) {
    for (const commit of ofMachine) commits.set(commit.value, commit)
  }
  return {
    // Every commit listed has an ordinal: the list sorted by them leaves out those without one.
    commits: [...commits.values()].sort((a, b) => a.ordinal! - b.ordinal!),
    listed: new Set(listed.map((entry) => entry.machine)),
    pending: results.some((result) => result.data === undefined && result.error === null),
    failures: results.flatMap(({ error, refetch }, i) =>
      error === null ? [] : [{ machine: machines[i], error, retry: () => void refetch() }],
    ),
  }
}
