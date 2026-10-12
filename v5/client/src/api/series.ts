/**
 * The measurements the Graph page plots (GR2), loaded from `POST /query` (E9) as they are needed.
 *
 * The selected tests of a machine are fetched in *batches*: the tests selected together, on one
 * machine, for one metric, in one request whose pages arrive one after the other, so that a range
 * of tests is one request per machine rather than one per test, and the chart fills in as pages
 * arrive. Each page of a batch is a query of its own, keyed by its cursor, added once the page
 * before it has given that cursor. Pages never change once fetched, so a batch whose machine is
 * removed is cancelled cleanly, keeping the pages it has, and resumes from there; and a page that
 * fails is fetched again on its own, without repeating the others.
 *
 * A page is never refetched otherwise: its cursor is only good for the pages before it as they
 * were fetched, so refetching them all at once could fork the chain and count samples twice.
 * Nothing invalidates these queries while the page shows them, and they never go stale.
 *
 * Which tests have a batch is read from the cache rather than kept in state, so that a batch
 * outlives the page's state -- a remount, a selection made again -- for as long as it is cached.
 */

import { useCallback, useMemo, useState } from 'react'
import { useQueries, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { compareStrings } from '../format'
import { api, MAX_PAGE_SIZE, unwrap } from './client'
import { queryKeys } from './keys'
import { rejectsCursor } from './use-cursor-pages'

/** One sample of a test, as the Graph page keeps it. */
export interface Measurement {
  commit: string
  /** The run's UUID. */
  run: string
  value: number
  /** When the run was submitted. */
  submittedAt: string
}

/** One page of a batch: the measurements of each of its tests, and the next page's cursor. */
export interface SeriesPage {
  measurements: ReadonlyMap<string, readonly Measurement[]>
  next: string | null
}

/**
 * What identifies a batch: the tests of one machine fetched together for one metric. A restart
 * after a rejected cursor is a new generation of the same batch, whose pages start afresh.
 */
interface BatchKey {
  machine: string
  metric: string
  /** Sorted, so that the same tests make the same batch. */
  tests: readonly string[]
  generation: number
}

/** A batch, as far as it is loaded. */
export interface Batch {
  machine: string
  tests: readonly string[]
  /** The pages fetched so far, in order. */
  pages: readonly SeriesPage[]
  /** Whether every page has been fetched. */
  complete: boolean
  /** Why fetching stopped, if it failed. */
  error: Error | null
}

export interface Series {
  /** The batches holding a selected test, of every machine given. */
  batches: Batch[]
  /** Why some page could not be fetched, if one could not. */
  error: Error | null
  /** Fetch again the pages that failed. */
  retry(): void
}

function pageKey(suite: string, batch: BatchKey, cursor: string | null) {
  return [...queryKeys.series(suite), batch, cursor] as const
}

async function fetchPage(
  suite: string,
  { machine, metric, tests }: BatchKey,
  cursor: string | null,
  signal: AbortSignal,
): Promise<SeriesPage> {
  const page = await unwrap(
    api.POST('/api/suites/{testsuite}/query', {
      params: { path: { testsuite: suite } },
      // By commit: the order the server serves fastest for a machine and a list of tests.
      body: { metric, machine, test: [...tests], sort: 'commit', limit: MAX_PAGE_SIZE, cursor },
      signal,
    }),
  )
  const measurements = new Map<string, Measurement[]>()
  for (const point of page.items) {
    const measurement = {
      commit: point.commit,
      run: point.run_uuid,
      // The Graph page plots numeric metrics only (GR1).
      value: point.value as number,
      submittedAt: point.submitted_at,
    }
    const ofTest = measurements.get(point.test)
    if (ofTest === undefined) measurements.set(point.test, [measurement])
    else ofTest.push(measurement)
  }
  return { measurements, next: page.cursor.next }
}

/** The batches of `machine` and `metric` in the cache, each in its latest generation. */
function cachedBatches(
  client: QueryClient,
  suite: string,
  machine: string,
  metric: string,
): BatchKey[] {
  const latest = new Map<string, BatchKey>()
  for (const query of client.getQueryCache().findAll({ queryKey: queryKeys.series(suite) })) {
    const [batch, cursor] = query.queryKey.slice(-2) as [BatchKey, string | null]
    if (cursor !== null || batch.machine !== machine || batch.metric !== metric) continue
    const tests = batch.tests.join('\0')
    const known = latest.get(tests)
    if (known === undefined || known.generation < batch.generation) latest.set(tests, batch)
  }
  return [...latest.values()]
}

/**
 * The measurements of the `selected` tests for `metric`, on each machine of `testsOf`, which gives
 * the tests each machine's list holds: a test it does not hold is not asked for, since the API
 * refuses a request naming a test that does not exist (E9).
 *
 * The selected tests that no batch of a machine holds yet become a new batch. The batches holding
 * a selected test are fetched, and the others left alone, keeping what they have.
 */
export function useSeries(
  suite: string,
  metric: string,
  selected: ReadonlySet<string>,
  testsOf: ReadonlyMap<string, ReadonlySet<string>>,
): Series {
  const client = useQueryClient()
  // Renders the page again once a restarted batch is in the cache (see `retry`).
  const [, setRestarts] = useState(0)

  const batches: BatchKey[] = []
  for (const [machine, held] of testsOf) {
    const wanted = [...selected].filter((test) => held.has(test))
    if (wanted.length === 0) continue
    const cached = cachedBatches(client, suite, machine, metric)
    batches.push(...cached.filter((batch) => batch.tests.some((test) => selected.has(test))))
    const covered = new Set(cached.flatMap((batch) => batch.tests))
    const uncovered = wanted.filter((test) => !covered.has(test)).sort(compareStrings)
    if (uncovered.length > 0) batches.push({ machine, metric, tests: uncovered, generation: 0 })
  }

  // Each batch's pages: the first, then each one the page before it has given the cursor of.
  const pages: PagePlan[] = []
  batches.forEach((batch, index) => {
    let cursor: string | null = null
    for (;;) {
      pages.push({ batch: index, cursor })
      const page: SeriesPage | undefined = client.getQueryData(pageKey(suite, batch, cursor))
      if (page === undefined || page.next === null) break
      cursor = page.next
    }
  })

  // The same plan, and so the same batches, from one render to the next until a page is added or
  // the selection changes: the plan is read back from its serialization, which stays the same.
  const serialized = JSON.stringify({ batches, pages })
  const plan = useMemo((): Plan => JSON.parse(serialized), [serialized])
  const combine = useCallback(
    (results: PageResult[]) =>
      combineBatches(plan, results, (batch) => {
        // A later page's cursor was refused, which may only mean that the server or the suite's
        // schema changed meanwhile (I2): the batch starts again, as a new generation.
        const next = { ...batch, generation: batch.generation + 1 }
        void client.prefetchQuery({
          queryKey: pageKey(suite, next, null),
          queryFn: ({ signal }) => fetchPage(suite, next, null, signal),
          staleTime: Infinity,
        })
        setRestarts((count) => count + 1)
      }),
    [plan, client, suite],
  )
  return useQueries({
    queries: plan.pages.map(({ batch, cursor }) => ({
      queryKey: pageKey(suite, plan.batches[batch], cursor),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchPage(suite, plan.batches[batch], cursor, signal),
      staleTime: Infinity,
      // A page is read whole, never compared with a previous one.
      structuralSharing: false,
    })),
    combine,
  })
}

/** A page of a batch: the batch's index in the plan, and the page's cursor. */
interface PagePlan {
  batch: number
  cursor: string | null
}

/** The batches to fetch, and their pages, in order. */
interface Plan {
  batches: BatchKey[]
  pages: PagePlan[]
}

/** The parts of a page's query result the batches are made of. */
interface PageResult {
  data?: SeriesPage
  error: Error | null
  refetch: () => unknown
}

/** The batches of `plan`, from the results of its pages' queries, in order. */
function combineBatches(
  plan: Plan,
  results: PageResult[],
  restart: (batch: BatchKey) => void,
): Series {
  const batches = plan.batches.map(({ machine, tests }) => ({
    machine,
    tests,
    pages: [] as SeriesPage[],
    complete: false,
    error: null as Error | null,
  }))
  results.forEach(({ data, error }, i) => {
    const batch = batches[plan.pages[i].batch]
    if (data !== undefined) {
      batch.pages.push(data)
      batch.complete = data.next === null
    }
    if (error !== null) batch.error = error
  })
  return {
    batches,
    error: batches.find((batch) => batch.error !== null)?.error ?? null,
    retry: () => {
      results.forEach(({ error, refetch }, i) => {
        if (error === null) return
        const { batch, cursor } = plan.pages[i]
        if (cursor !== null && rejectsCursor(error)) restart(plan.batches[batch])
        else void refetch()
      })
    },
  }
}
