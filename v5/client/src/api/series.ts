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
 * What a page has fetched is kept for as long as it shows the suite, even what it no longer shows
 * (GR8), and forgotten once it leaves it (see `forgetGraphData`).
 *
 * Which tests have a batch is read from the cache rather than kept in state, so that a batch
 * outlives the page's state -- a remount, a selection made again -- for as long as it is cached.
 */

import { useCallback, useMemo, useState } from 'react'
import { useQueries, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { compareStrings } from '../format'
import { api, MAX_PAGE_SIZE, unwrap } from './client'
import { queryKeys } from './keys'
import { scaffoldKey } from './scaffold'
import { rejectsCursor } from './use-cursor-pages'

/** One sample of a test, as the Graph page keeps it. */
export interface Measurement {
  commit: string
  /** The run's UUID. */
  run: string
  value: number
}

/** One page of a batch: the measurements of each of its tests, and the next page's cursor. */
interface SeriesPage {
  measurements: ReadonlyMap<string, readonly Measurement[]>
  next: string | null
}

/**
 * What identifies a batch in its pages' keys. The tests of one machine and metric are in one batch
 * at most, so the first of them, and how many there are, identify it, and the key stays short
 * however many it holds. A restart after a rejected cursor is a new generation of the same batch,
 * whose pages start afresh.
 */
interface BatchId {
  machine: string
  metric: string
  first: string
  count: number
  generation: number
}

/** A batch: the tests of one machine fetched together for one metric. */
interface BatchKey extends BatchId {
  /** Sorted, so that the same tests make the same batch. */
  tests: readonly string[]
}

/** A batch, as far as it is loaded. */
interface Batch {
  machine: string
  tests: readonly string[]
  /** The pages fetched so far, in order. */
  pages: readonly SeriesPage[]
  /** Whether every page has been fetched. */
  complete: boolean
  error: Error | null
}

export interface Series {
  /**
   * The measurements of `test` on `machine` loaded so far, in no particular order: the same array
   * until more of them arrive.
   */
  measurementsOf(machine: string, test: string): readonly Measurement[]
  /** The selected tests whose measurements are still loading on some machine. */
  loading: ReadonlySet<string>
  /** Why some page could not be fetched, if one could not. */
  error: Error | null
  /** Fetch again the pages that failed. */
  retry(): void
}

/** What the queries of a batch's pages carry, which their keys leave out. */
interface PageMeta extends Record<string, unknown> {
  tests: readonly string[]
}

function pageKey(suite: string, batch: BatchId, cursor: string | null) {
  const { machine, metric, first, count, generation } = batch
  const id = { machine, metric, first, count, generation }
  return [...queryKeys.series(suite), id, cursor] as const
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
    // The Graph page plots numeric metrics only (GR1).
    const measurement = { commit: point.commit, run: point.run_uuid, value: point.value as number }
    const ofTest = measurements.get(point.test)
    if (ofTest === undefined) measurements.set(point.test, [measurement])
    else ofTest.push(measurement)
  }
  return { measurements, next: page.cursor.next }
}

/** A generation of a batch in the cache, and whether its first page has arrived. */
interface Candidate {
  batch: BatchKey
  arrived: boolean
}

/** Whether `a` is a better generation to show than `b`: one with data, then the later one. */
function preferred(a: Candidate, b: Candidate): boolean {
  return a.arrived !== b.arrived ? a.arrived : a.batch.generation > b.batch.generation
}

/**
 * The batches of `machine` and `metric` in the cache, each in its latest generation whose first
 * page has arrived, so that a batch starting again keeps showing what it had until then, or else in
 * its latest generation.
 */
function cachedBatches(
  client: QueryClient,
  suite: string,
  machine: string,
  metric: string,
): BatchKey[] {
  const chosen = new Map<string, Candidate>()
  for (const query of client.getQueryCache().findAll({ queryKey: queryKeys.series(suite) })) {
    const [id, cursor] = query.queryKey.slice(-2) as [BatchId, string | null]
    if (cursor !== null || id.machine !== machine || id.metric !== metric) continue
    const { tests } = query.meta as PageMeta
    const candidate = { batch: { ...id, tests }, arrived: query.state.data !== undefined }
    const known = chosen.get(id.first)
    if (known === undefined || preferred(candidate, known)) chosen.set(id.first, candidate)
  }
  return [...chosen.values()].map(({ batch }) => batch)
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
  // Renders the page again once a restarted batch has its first page (see `restart`).
  const [, setRestarts] = useState(0)

  const batches: BatchKey[] = []
  for (const [machine, held] of testsOf) {
    const wanted = [...selected].filter((test) => held.has(test))
    if (wanted.length === 0) continue
    const cached = cachedBatches(client, suite, machine, metric)
    batches.push(...cached.filter((batch) => batch.tests.some((test) => selected.has(test))))
    const covered = new Set(cached.flatMap((batch) => batch.tests))
    const tests = wanted.filter((test) => !covered.has(test)).sort(compareStrings)
    if (tests.length > 0) {
      batches.push({ machine, metric, first: tests[0], count: tests.length, generation: 0, tests })
    }
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
  const restart = useCallback(
    (batch: BatchKey) => {
      // A later page's cursor was refused, which may only mean that the server or the suite's
      // schema changed meanwhile (I2): the batch starts again, as a new generation.
      // The batch keeps showing what it had until the new generation's first page arrives, which
      // the page then switches to (see `cachedBatches`).
      const next = { ...batch, generation: batch.generation + 1 }
      void client
        .prefetchQuery({
          queryKey: pageKey(suite, next, null),
          queryFn: ({ signal }) => fetchPage(suite, next, null, signal),
          meta: { tests: next.tests } satisfies PageMeta,
          staleTime: Infinity,
          gcTime: Infinity,
        })
        .then(() => setRestarts((count) => count + 1))
    },
    [client, suite],
  )
  const combine = useCallback(
    (results: PageResult[]) => combineBatches(plan, results, restart),
    [plan, restart],
  )
  const loaded = useQueries({
    queries: plan.pages.map(({ batch, cursor }) => ({
      queryKey: pageKey(suite, plan.batches[batch], cursor),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchPage(suite, plan.batches[batch], cursor, signal),
      meta: { tests: plan.batches[batch].tests } satisfies PageMeta,
      staleTime: Infinity,
      // Kept for as long as the page shows the suite, whose leaving forgets them (GR8; see
      // `forgetGraphData`).
      gcTime: Infinity,
      // A page is read whole, never compared with a previous one.
      structuralSharing: false,
    })),
    combine,
  })

  return useMemo(() => {
    const { batches: ofPlan, error, retry } = loaded
    // A selected test is loading on a machine whose list holds it until its batch is complete or
    // has failed, and while it has no batch yet.
    const settled = new Set(
      ofPlan
        .filter((batch) => batch.complete || batch.error !== null)
        .flatMap((batch) => batch.tests.map((test) => `${batch.machine}\0${test}`)),
    )
    const loading = new Set<string>()
    for (const [machine, held] of testsOf) {
      for (const test of selected) {
        if (held.has(test) && !settled.has(`${machine}\0${test}`)) loading.add(test)
      }
    }
    return {
      measurementsOf: (machine, test) => {
        const batch = ofPlan.find((b) => b.machine === machine && b.tests.includes(test))
        return batch === undefined ? NO_MEASUREMENTS : measurementsOf(batch, test)
      },
      loading,
      error,
      retry,
    }
  }, [loaded, testsOf, selected])
}

const NO_MEASUREMENTS: readonly Measurement[] = []

/**
 * The measurements of each test of each batch, gathered from its pages once per batch: the same
 * array until the batch changes. A batch keeps its identity until one of its pages changes (see
 * `combineBatches`), so a page that arrives gathers again only the tests of its own batch.
 */
const gathered = new WeakMap<Batch, Map<string, readonly Measurement[]>>()

function measurementsOf(batch: Batch, test: string): readonly Measurement[] {
  let ofBatch = gathered.get(batch)
  if (ofBatch === undefined) gathered.set(batch, (ofBatch = new Map()))
  let measurements = ofBatch.get(test)
  if (measurements === undefined) {
    // A commit's samples may span two pages, so a test's are gathered from all of them at once.
    measurements = batch.pages.flatMap((page) => page.measurements.get(test) ?? [])
    ofBatch.set(test, measurements)
  }
  return measurements
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

/**
 * The batches of `plan`, from the results of its pages' queries, in order. TanStack Query shares
 * what is unchanged with the previous result, so a batch none of whose pages changed is the same
 * object as before.
 */
function combineBatches(
  plan: Plan,
  results: PageResult[],
  restart: (batch: BatchKey) => void,
): { batches: Batch[]; error: Error | null; retry(): void } {
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

/**
 * Forget what the Graph page fetched in `suite` and no longer shows -- its measurements, its
 * scaffolds and its lists of tests, which it keeps for as long as it shows the suite (GR8) -- once
 * it has left the suite or the page. Done after the current task, and only to what nothing
 * observes then, so that a page mounted again at once, as StrictMode does in development, keeps
 * what it is still showing.
 */
export function forgetGraphData(client: QueryClient, suite: string): void {
  setTimeout(() => {
    for (const queryKey of [queryKeys.series(suite), scaffoldKey(suite), queryKeys.tests(suite)]) {
      client.removeQueries({ queryKey, predicate: (query) => query.getObserversCount() === 0 })
    }
  })
}
