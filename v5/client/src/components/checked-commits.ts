/**
 * Commits that a page names with their suite and machine, rather than a user picking them: the
 * Graph page's baselines (GR9) and the Compare page's shadows (CP8), checked as a commit given to a
 * commit picker is (AR15).
 */

import { useMemo } from 'react'
import { skipToken, useQueries } from '@tanstack/react-query'
import { combineResults, type Failures } from '../api/failures'
import { machinesQuery } from '../api/machines'
import { findSuite, fullName, suiteRef, type Suite, type SuiteRef } from '../api/suites'
import { commitLookupKey, commitLookupQuery } from './commit-lookup'

/** A commit of a machine, in a suite. */
export interface CommitOfMachine {
  suite: SuiteRef
  machine: string
  commit: string
}

/**
 * The commit of a machine that `parts` name, a URL's value split on `/` (GR9, CP8), or null unless
 * they are four, none empty: its suite's project, its suite, its machine and itself. No name can
 * contain a `/` (D4, D7, I1).
 */
export function parseCommitOfMachine(parts: readonly string[]): CommitOfMachine | null {
  if (parts.length !== 4 || parts.some((part) => part === '')) return null
  const [project, suite, machine, commit] = parts
  return { suite: suiteRef(project, suite), machine, commit }
}

/** `entry`, as a URL spells it: `{project}/{suite}/{machine}/{commit}`. */
export function formatCommitOfMachine({ suite, machine, commit }: CommitOfMachine): string {
  return `${fullName(suite)}/${machine}/${commit}`
}

/** What is known of such a commit (see `useCheckedCommits`). */
export interface CheckedCommit {
  /** Its suite, once the suites are known to hold it. */
  schema: Suite | undefined
  /** Whether its machine is among its suite's, once they are listed. */
  machineKnown: boolean | undefined
  /** Whether the machine has runs at the commit, once that is known. */
  found: boolean | undefined
  /** The display value of the commit (AR6), or the commit string until it is known. */
  display: string
  /**
   * Whether it is known to be unusable: its suite, its machine or its commit does not exist, or
   * the machine has no run at the commit (AR2 "State").
   */
  unusable: boolean
}

/**
 * What is known of `commits`, given the suites, once they are listed: whether each is usable, and
 * its display value. The states are the same array from one render to the next until one of them
 * changes.
 *
 * Its suite must be listed, its machine among the suite's, and the machine must have runs at the
 * commit, which the lookup of the commit among the machine's says. The machine is checked first,
 * since the lookup refuses a machine that does not exist, and a request that fails shows nothing
 * (AR2 "State").
 */
export function useCheckedCommits(
  commits: readonly CommitOfMachine[],
  suites: readonly Suite[] | undefined,
): Failures & { states: CheckedCommit[] } {
  // Each commit checked once, however many entries name it, so that no query is asked for twice.
  const { distinct, at } = useMemo(() => distinctCommits(commits), [commits])
  const schemas = useMemo(
    () => distinct.map((entry) => findSuite(suites, entry.suite)),
    [distinct, suites],
  )
  // Each suite that exists once: the same object for every entry of one suite (see `suiteRef`).
  const named = useMemo(
    () => [...new Set(distinct.flatMap((entry, i) => (schemas[i] ? [entry.suite] : [])))],
    [distinct, schemas],
  )
  const machineLists = useQueries({
    queries: named.map((suite) => ({ ...machinesQuery(suite), staleTime: Infinity })),
    combine: combineResults,
  })
  const machineKnown = useMemo(
    () =>
      distinct.map((entry, i) => {
        if (schemas[i] === undefined) return undefined
        const list = machineLists.data[named.indexOf(entry.suite)]
        return list?.some((machine) => machine.name === entry.machine)
      }),
    [distinct, schemas, named, machineLists.data],
  )

  const lookups = useQueries({
    queries: distinct.map(({ suite, machine, commit }, i) => {
      const schema = schemas[i]
      return {
        queryKey: commitLookupKey(suite, { machine }, commit),
        queryFn:
          schema && machineKnown[i]
            ? commitLookupQuery(schema, { machine }, commit).queryFn
            : skipToken,
      }
    }),
    combine: combineResults,
  })

  const states = useMemo(
    () =>
      commits.map((entry, k): CheckedCommit => {
        const i = at[k]
        const lookup = lookups.data[i]
        return {
          schema: schemas[i],
          machineKnown: machineKnown[i],
          found: lookup === undefined ? undefined : lookup !== null,
          display: lookup?.text ?? entry.commit,
          unusable:
            (suites !== undefined && schemas[i] === undefined) ||
            machineKnown[i] === false ||
            lookup === null,
        }
      }),
    [commits, at, suites, schemas, machineKnown, lookups.data],
  )
  return {
    states,
    error: machineLists.error ?? lookups.error,
    retry: () => [machineLists, lookups].forEach((group) => group.retry()),
  }
}

/**
 * The commits `commits` name, each once, in the order first named, and the position among them of
 * the one each entry of `commits` names.
 */
export function distinctCommits<C extends CommitOfMachine>(
  commits: readonly C[],
): { distinct: C[]; at: number[] } {
  const positions = new Map<string, number>()
  const distinct: C[] = []
  const at = commits.map((entry) => {
    const key = formatCommitOfMachine(entry)
    let position = positions.get(key)
    if (position === undefined) {
      position = distinct.push(entry) - 1
      positions.set(key, position)
    }
    return position
  })
  return { distinct, at }
}
