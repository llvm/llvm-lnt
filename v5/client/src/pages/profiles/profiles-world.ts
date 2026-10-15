/**
 * The world the Profiles page's tests run in: a mocked API holding a few suites, machines, the
 * commits at which they have runs with profiles, those runs, their profiles, and the profiles'
 * metadata, and the means to drive the page.
 */

import { HttpResponse } from 'msw'
import { screen } from '@testing-library/react'
import type { Schemas } from '../../api/client'
import type { SuiteSchema } from '../../api/suites'
import { BARE_SUITE, SUITE, commit, cursorPage, machine, run, uuidOf } from '../../test/fixtures'
import { errorResponse, mockApi } from '../../test/mock-api'
import { mockCommits, mockMachines, mockRuns, mockSuites } from '../../test/page'
import { profilesPath } from '../../paths'
import { server } from '../../test/server'

/** A suite of its own, holding the same world as libcxx. */
export const OTHER_SUITE: SuiteSchema = { ...BARE_SUITE, name: 'other' }

/** The tests, each with the hex digit that marks its profiles' UUIDs. */
const TESTS: Record<string, string> = { alpha: 'a', beta: 'b', gamma: 'c', delta: 'd' }

/**
 * The runs with profiles of each machine at each commit, under `machine/commit`, in the order they
 * were measured: each run by the hex of its UUID, with the tests it has a profile of. `m3` is a
 * machine without profiles.
 */
const RUNS: Record<string, [hex: string, tests: string[]][]> = {
  'm1/c1': [
    ['1', ['alpha', 'beta']],
    ['2', ['gamma', 'alpha']],
  ],
  'm1/c2': [['3', ['beta', 'gamma']]],
  'm2/c1': [['4', ['alpha']]],
  'm2/c3': [['5', ['beta']]],
}

const MACHINES = ['m1', 'm2', 'm3']

/** The UUID of the profile of `test` in the run `hex`. */
export function profileUuid(hex: string, test: string): string {
  return uuidOf(`${hex}${TESTS[test]}`)
}

/** How an endpoint answers a request for `key`, if not as the world says: `undefined`. */
type Answer<Key> = (key: Key) => Response | undefined | Promise<Response | undefined>

interface World {
  suites?: SuiteSchema[]
  /** How `GET runs` answers a query. */
  runsAnswer?: Answer<URLSearchParams>
  /** How `GET runs/{uuid}/profiles` answers a run, by its UUID's hex. */
  profilesAnswer?: Answer<string>
  /** How `GET profiles/{uuid}` answers a profile, by its UUID. */
  metadataAnswer?: Answer<string>
}

/**
 * Mock the API for the Profiles page: the suites, and the world described in each of them. Returns
 * what was asked for: the queries of `GET commits`, and the UUIDs of the profiles whose metadata
 * was asked for, in order.
 */
export function mockWorld({
  suites = [SUITE, OTHER_SUITE],
  runsAnswer,
  profilesAnswer,
  metadataAnswer,
}: World = {}) {
  const metadata: string[] = []
  mockSuites(suites)
  mockMachines(() => ({ items: MACHINES.map((name) => machine(name)) }))
  // The commits at which a machine has runs with profiles, as a commit picker lists or looks them
  // up (AR15). A machine of none is a 404 (E3).
  const commits = mockCommits((query) => {
    const machineName = query.get('machine')
    const only = query.get('commit')
    const held = Object.keys(RUNS)
      .filter((key) => machineName === null || key.startsWith(`${machineName}/`))
      .map((key) => key.split('/')[1])
    return cursorPage(
      [...new Set(held)]
        .filter((value) => only === null || value === only)
        .map((value) => commit(value)),
    )
  })
  mockRuns((query) => {
    const listed = RUNS[`${query.get('machine')}/${query.get('commit')}`] ?? []
    return cursorPage(
      listed.map(([hex], i) =>
        run(hex, {
          machine: query.get('machine')!,
          commit: query.get('commit')!,
          measured_at: `2026-08-2${i}T10:00:00Z`,
        }),
      ),
    )
  })
  const testsOf = (hex: string) =>
    Object.values(RUNS)
      .flat()
      .find(([runHex]) => runHex === hex)?.[1]
  server.use(
    mockApi('get', '/api/suites/{testsuite}/commits', ({ request }) => {
      const name = new URL(request.url).searchParams.get('machine')
      if (name !== null && !MACHINES.includes(name)) {
        return errorResponse(404, 'not_found', 'No such machine') as never
      }
    }),
    mockApi('get', '/api/suites/{testsuite}/runs', async ({ request }) => {
      const answer = await runsAnswer?.(new URL(request.url).searchParams)
      if (answer !== undefined) return answer as never
    }),
    mockApi('get', '/api/suites/{testsuite}/runs/{uuid}/profiles', async ({ params }) => {
      const hex = params.uuid[0]
      const answer = await profilesAnswer?.(hex)
      if (answer !== undefined) return answer as never
      const tests = [...(testsOf(hex) ?? [])].sort()
      return HttpResponse.json({
        items: tests.map((test) => ({ test, uuid: profileUuid(hex, test) })),
      })
    }),
    mockApi('get', '/api/suites/{testsuite}/profiles/{uuid}', async ({ params }) => {
      metadata.push(params.uuid)
      const answer = await metadataAnswer?.(params.uuid)
      if (answer !== undefined) return answer as never
      const [hex, letter] = params.uuid
      const test = Object.keys(TESTS).find((name) => TESTS[name] === letter)!
      const body: Schemas['ProfileMetadata'] = {
        uuid: params.uuid,
        test,
        run_uuid: uuidOf(hex),
        counters: { cycles: 100, instructions: 200 },
        disassembly_format: 'llvm-objdump',
      }
      return HttpResponse.json(body)
    }),
  )
  return { commits, metadata }
}

/** A side showing `test` in the run `hex` of `machine` at `commit`, in libcxx. */
export function sideAt(machine: string, commit: string, hex: string, test: string) {
  return { suite: 'libcxx', machine, commit, run: uuidOf(hex), test }
}

/** The URL of side A showing alpha in run 1 of m1 at c1, as Run Detail links to it (PF1). */
export const ALPHA = profilesPath(sideAt('m1', 'c1', '1', 'alpha'))

/** The controls of `side`, whose fields are named without it: "Suite", "Machine", "Commit". */
export function sideOf(side: 'A' | 'B') {
  return screen.getByRole('region', { name: `Side ${side}` })
}

/** The column of the profile `side` shows (PF7), if it has one. */
export function columnOf(side: 'A' | 'B') {
  return screen.queryByRole('region', { name: `Profile ${side}` })
}
