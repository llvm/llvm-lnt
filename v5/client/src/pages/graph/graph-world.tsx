/**
 * The world the Graph page's tests run in: a mocked API holding two suites, two machines, their
 * tests, commits and samples, and the means to read what the page shows and hands its chart.
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import type { Layout, PlotData } from 'plotly.js'
import { expect } from 'vitest'
import type { Schemas } from '../../api/client'
import type { SuiteSchema } from '../../api/suites'
import { chartProps } from '../../test/chart-props'
import { BARE_SUITE, SUITE, commit, cursorPage, machine, metric } from '../../test/fixtures'
import { mockApi } from '../../test/mock-api'
import { main, mockCommits, mockMachines, mockSuites, mockTests } from '../../test/page'
import { server } from '../../test/server'

/** libcxx, with two numeric metrics and one that cannot be plotted. */
export const GRAPH_SUITE: SuiteSchema = {
  ...SUITE,
  metrics: [
    SUITE.metrics[0],
    metric('compile_time', { display_name: 'Compile Time' }),
    metric('hash', { type: 'text' }),
  ],
}

/** A suite with a metric, but none numeric. */
export const TEXT_SUITE: SuiteSchema = {
  ...BARE_SUITE,
  name: 'text_only',
  metrics: [metric('hash', { type: 'text' })],
}

/** A sample: its commit, its run (one per letter), and its value. */
export type Sample = [commit: string, run: string, value: number, submitted?: string]

export interface World {
  machines?: string[]
  /** The tests of each machine, for any metric. */
  tests?: Record<string, string[]>
  /** The commits each machine has runs at, by ordinal. */
  commits?: Record<string, number[]>
  /** The samples of each test on each machine, under `machine/test`. */
  samples?: Record<string, Sample[]>
  /** How many points a page of `POST /query` holds. */
  pageSize?: number
  /** What the list of suites waits for before it is answered. */
  suitesWait?: () => Promise<void>
  /** The suites besides GRAPH_SUITE and TEXT_SUITE, which hold the same machines and data. */
  suites?: SuiteSchema[]
}

export const MACHINES = ['m1', 'm2']
export const TESTS = { m1: ['a', 'b', 'c'], m2: ['b', 'c', 'd'] }
export const COMMITS = { m1: [10, 20, 30], m2: [20, 30, 40] }
export const SAMPLES: Record<string, Sample[]> = {
  'm1/a': [
    ['c10', 'r1', 1],
    ['c20', 'r2', 2],
  ],
  'm1/b': [['c10', 'r1', 3]],
  'm2/b': [['c40', 'r3', 4]],
}

export const commitAt = (ordinal: number) =>
  commit(`c${ordinal}`, { ordinal, fields: { svn_revision: `r${ordinal}`, commit_info: null } })

export const pointOf = (
  machineName: string,
  test: string,
  [value, run, measured, submitted = '2026-08-25T14:22:41Z']: Sample,
) =>
  ({
    test,
    machine: machineName,
    metric: 'execution_time',
    value: measured,
    commit: value,
    ordinal: Number(value.slice(1)),
    run_uuid: run,
    submitted_at: submitted,
    tag: null,
  }) satisfies Schemas['DataPoint']

/** The bodies `POST /query` was sent, in order, and the signal of each request. */
export interface Recorded {
  queries: { body: Schemas['QueryRequest']; signal: AbortSignal }[]
}

/**
 * Mock the API for the Graph page: GRAPH_SUITE and TEXT_SUITE, and the world described, in every
 * suite. `POST /query` answers a test's data, or, without `test`, every test's, as for a baseline,
 * at `commit` if given.
 */
export function mockWorld({
  machines = MACHINES,
  tests = TESTS,
  commits = COMMITS,
  samples = SAMPLES,
  pageSize = 10_000,
  suitesWait,
  suites = [],
}: World = {}): Recorded {
  const recorded: Recorded = { queries: [] }
  mockSuites([GRAPH_SUITE, TEXT_SUITE, ...suites], { wait: suitesWait })
  mockMachines(() => ({ items: machines.map((name) => machine(name)) }))
  mockTests((query) => testPage(tests[query.get('machine')!] ?? []))
  mockCommits((query) => {
    const listed = (commits[query.get('machine')!] ?? []).map(commitAt)
    const only = query.get('commit')
    return cursorPage(only === null ? listed : listed.filter((entry) => entry.value === only))
  })
  server.use(
    mockApi('post', '/api/suites/{testsuite}/query', async ({ request }) => {
      const body = await request.json()
      recorded.queries.push({ body, signal: request.signal })
      const named = body.test ?? (tests[body.machine!] ?? [])
      const all = named.flatMap((test) =>
        (samples[`${body.machine}/${test}`] ?? [])
          .filter(([at]) => !body.commit || at === body.commit)
          .map((s) => pointOf(body.machine!, test, s)),
      )
      const start = Number(body.cursor ?? 0)
      const end = start + pageSize
      const next = end < all.length ? String(end) : null
      return HttpResponse.json(cursorPage(all.slice(start, end), next))
    }),
  )
  return recorded
}

/** A page of `GET /tests` listing `names`. */
export function testPage(names: string[]) {
  return cursorPage(names.map((name) => ({ name })))
}

/** What the page last handed the chart to draw. */
export function chart() {
  return chartProps(main().getByRole('img'))
}

/** The traces the chart was last given, as `name: commit=value...`. */
export function traces() {
  return chart().data.map((trace) => {
    const { name, x, y } = trace as PlotData
    const points = (x as string[]).map((value, i) => `${value}=${(y as number[])[i]}`)
    return `${name}: ${points.join(' ')}`
  })
}

/** The names of the traces the chart was last given, in order. */
export function drawn() {
  return (chart().data as PlotData[]).map((trace) => trace.name)
}

export function layout(): Partial<Layout> {
  return chart().layout
}

export function testTable() {
  return within(main().getByRole('table', { name: 'Tests' }))
}

/** The tests the table lists, in order. */
export function listed() {
  return testTable()
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[2].textContent)
}

export const box = (test: string) => testTable().getByRole('checkbox', { name: test })

export async function addMachine(name: string) {
  const user = userEvent.setup()
  const input = await screen.findByRole('combobox', { name: 'Machines' })
  await waitFor(() => expect(input).toBeEnabled())
  await user.type(input, name)
  await user.click(await screen.findByRole('option', { name }))
}

export const GRAPHED = '/graph?suite=libcxx&machine=m1&machine=m2&metric=execution_time'
