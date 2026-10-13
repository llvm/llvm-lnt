/**
 * The world the Compare page's tests run in: a mocked API holding a few suites, two machines, their
 * commits and runs, and the runs' samples, and the means to read what the page shows.
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { expect } from 'vitest'
import type { Schemas } from '../../api/client'
import type { SuiteSchema } from '../../api/suites'
import {
  BARE_SUITE,
  SUITE,
  commit,
  cursorPage,
  machine,
  metric,
  run,
  sample,
  uuidOf,
} from '../../test/fixtures'
import { uuidPrefix } from '../../format'
import { mockApi } from '../../test/mock-api'
import { mockCommits, mockMachines, mockRuns, mockSuites, rowsOf, table } from '../../test/page'
import { server } from '../../test/server'

/** A suite declaring libcxx's metric alike, and one of its own. */
const OTHER_SUITE: SuiteSchema = {
  ...BARE_SUITE,
  name: 'other',
  metrics: [SUITE.metrics[0], metric('compile_time', { display_name: 'Compile Time' })],
}

/** A suite declaring libcxx's metric with another unit, so that it cannot be compared with it. */
const MILLIS_SUITE: SuiteSchema = {
  ...BARE_SUITE,
  name: 'millis',
  metrics: [{ ...SUITE.metrics[0], unit: 'milliseconds', unit_abbrev: 'ms' }],
}

const MACHINES = ['m1', 'm2']

/** The runs of each machine at each commit, under `machine/commit`, by the hex of their UUIDs. */
const RUNS: Record<string, string[]> = {
  'm1/c1': ['1', '2'],
  'm1/c2': ['3'],
  'm2/c2': ['4'],
}

/** Each run's samples, by the hex of its UUID: each test's values of `execution_time`. */
const SAMPLES: Record<string, [test: string, value: number][]> = {
  '1': [
    ['a', 1],
    ['b', 2],
  ],
  '2': [['a', 3]],
  '3': [
    ['a', 4],
    ['c', 5],
  ],
  '4': [['a', 1]],
}

/** Every suite's runs and samples are the same: their machines, commits and tests. */
interface World {
  suites?: SuiteSchema[]
  runs?: Record<string, string[]>
  samples?: Record<string, [string, number][]>
  /** How `GET runs/{uuid}/samples` answers a run, by its UUID's hex, if not with its samples. */
  sampleAnswer?: (hex: string) => Response | undefined
  /** How `GET runs` answers a query, if not with the runs it names. */
  runsAnswer?: (query: URLSearchParams) => Response | undefined
}

/** The hex a run's UUID is made of (see `uuidOf`). */
const hexOf = (uuid: string) => uuid[0]

/**
 * Mock the API for the Compare page: the suites, and the world described in each of them. Returns
 * the hex of each run whose samples were asked for, in order.
 */
export function mockWorld({
  suites = [SUITE, OTHER_SUITE, MILLIS_SUITE],
  runs = RUNS,
  samples = SAMPLES,
  sampleAnswer,
  runsAnswer,
}: World = {}) {
  const sampled: string[] = []
  mockSuites(suites)
  mockMachines(() => ({ items: MACHINES.map((name) => machine(name)) }))
  // The commits a machine has runs at, as a commit picker lists or looks them up (AR15).
  mockCommits((query) => {
    const machineName = query.get('machine')
    const held = Object.keys(runs)
      .filter((key) => machineName === null || key.startsWith(`${machineName}/`))
      .map((key) => key.split('/')[1])
    const only = query.get('commit')
    return cursorPage(
      [...new Set(held)]
        .filter((value) => only === null || value === only)
        .map((value) => commit(value)),
    )
  })
  mockRuns((query) => {
    const key = `${query.get('machine')}/${query.get('commit')}`
    return cursorPage(
      (runs[key] ?? []).map((hex, i) =>
        run(hex, {
          machine: query.get('machine')!,
          commit: query.get('commit')!,
          submitted_at: `2026-08-2${i}T10:00:00Z`,
        }),
      ),
    )
  })
  // After `mockRuns`, whose answers it takes precedence over, falling back on them.
  server.use(
    mockApi('get', '/api/suites/{testsuite}/runs', ({ request }) => {
      const answer = runsAnswer?.(new URL(request.url).searchParams)
      if (answer !== undefined) return answer as never
    }),
  )
  server.use(
    mockApi('get', '/api/suites/{testsuite}/runs/{uuid}/samples', ({ params }) => {
      const hex = hexOf(params.uuid)
      sampled.push(hex)
      const answer = sampleAnswer?.(hex)
      if (answer !== undefined) return answer as never
      const items: Schemas['Sample'][] = (samples[hex] ?? []).map(([test, value]) =>
        sample(test, { execution_time: value }),
      )
      return HttpResponse.json(cursorPage(items))
    }),
  )
  return sampled
}

/** The URL of a comparison of libcxx's m1 at c1 (runs 1 and 2) with m1 at c2 (run 3). */
export const COMPARED =
  '/compare?suite_a=libcxx&machine_a=m1&commit_a=c1&suite_b=libcxx&machine_b=m1&commit_b=c2' +
  '&metric=execution_time'

/** The comparison of COMPARED: a is regressed, b is on side A only, c on side B only. */
export const ROWS = [
  'Geomean | 2 | 4 | 2 | +100.00% | 2.0000 | Regressed',
  'a | 2 | 4 | 2 | +100.00% | 2.0000 | Regressed',
  'b | 2 | N/A | N/A | N/A | N/A | N/A',
  'c | N/A | 5 | N/A | N/A | N/A | N/A',
]

/** The rows of the comparison table, once it shows. */
export async function comparison() {
  return rowsOf(await table('Comparison'))
}

/** The controls of `side`, whose fields are named without it: "Suite", "Machine", "Commit". */
export function sideOf(side: 'A' | 'B') {
  return screen.getByRole('region', { name: new RegExp(`^Side ${side} `) })
}

/** The checkbox of the run `hex` of `side`. */
export function runBox(hex: string, side: 'A' | 'B') {
  return within(sideOf(side)).getByRole('checkbox', { name: `Run ${uuidPrefix(uuidOf(hex))}` })
}

/**
 * Pick `name` in the combobox labelled `label`, typing it over the text the input holds, which is
 * never emptied meanwhile: that would clear the combobox's value (AR14).
 */
export async function pick(label: string, name: string, container: HTMLElement = document.body) {
  const user = userEvent.setup()
  const input = await within(container).findByRole('combobox', { name: label })
  await waitFor(() => expect(input).toBeEnabled())
  await user.tripleClick(input)
  await user.keyboard(name)
  await user.click(await screen.findByRole('option', { name }))
}
