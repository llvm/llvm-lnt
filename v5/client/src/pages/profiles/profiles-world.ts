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
import { gate, mockCommits, mockMachines, mockRuns, mockSuites } from '../../test/page'
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

type Counters = Record<string, number>

/**
 * The functions of each test's profiles, with their counters, by name: under cycles, hot is alpha's
 * hottest, and under instructions, warm is.
 */
const FUNCTIONS: Record<string, Record<string, Counters>> = {
  alpha: {
    hot: { cycles: 60, instructions: 20 },
    main: { cycles: 10, instructions: 30 },
    warm: { cycles: 30, instructions: 150 },
  },
  beta: {
    cool: { cycles: 40, instructions: 100 },
    hot: { cycles: 50, instructions: 50 },
    main: { cycles: 10, instructions: 50 },
  },
  gamma: {
    cold: { cycles: 5, instructions: 5 },
    main: { cycles: 95, instructions: 195 },
  },
}

/** The top-level counters of every profile, unless the world says otherwise. */
const COUNTERS: Counters = { cycles: 100, instructions: 200 }

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
  /** How `GET profiles/{uuid}/functions` answers a profile, by its UUID. */
  functionsAnswer?: Answer<string>
  /** How `GET profiles/{uuid}/disassembly` answers a function, by `uuid/name`. */
  disassemblyAnswer?: Answer<string>
  /** The top-level counters of profiles, by UUID, where not those of every profile. */
  counters?: Record<string, Counters>
  /** The functions of profiles, by UUID, where not those of their test's. */
  functions?: Record<string, Record<string, Counters>>
}

/**
 * Mock the API for the Profiles page: the suites, and the world described in each of them. Returns
 * what was asked for, in order: the queries of `GET commits`, the UUIDs of the profiles whose
 * metadata and functions were asked for, and the functions whose instructions were, by
 * `uuid/name`.
 */
export function mockWorld({
  suites = [SUITE, OTHER_SUITE],
  runsAnswer,
  profilesAnswer,
  metadataAnswer,
  functionsAnswer,
  disassemblyAnswer,
  counters = {},
  functions = {},
}: World = {}) {
  const metadata: string[] = []
  const listed: string[] = []
  const disassembled: string[] = []
  const testOf = (uuid: string) => Object.keys(TESTS).find((name) => TESTS[name] === uuid[1])!
  const functionsOf = (uuid: string) => functions[uuid] ?? FUNCTIONS[testOf(uuid)] ?? {}
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
      const body: Schemas['ProfileMetadata'] = {
        uuid: params.uuid,
        test: testOf(params.uuid),
        run_uuid: uuidOf(params.uuid[0]),
        counters: counters[params.uuid] ?? COUNTERS,
        disassembly_format: 'llvm-objdump',
      }
      return HttpResponse.json(body)
    }),
    mockApi('get', '/api/suites/{testsuite}/profiles/{uuid}/functions', async ({ params }) => {
      listed.push(params.uuid)
      const answer = await functionsAnswer?.(params.uuid)
      if (answer !== undefined) return answer as never
      const items = Object.entries(functionsOf(params.uuid)).map(([name, fn]) => ({
        name,
        counters: fn,
        length: 2,
      }))
      return HttpResponse.json({ items })
    }),
    mockApi(
      'get',
      '/api/suites/{testsuite}/profiles/{uuid}/disassembly',
      async ({ params, request }) => {
        const name = new URL(request.url).searchParams.get('function')!
        disassembled.push(`${params.uuid}/${name}`)
        const answer = await disassemblyAnswer?.(`${params.uuid}/${name}`)
        if (answer !== undefined) return answer as never
        const fn = functionsOf(params.uuid)[name]
        if (fn === undefined) return errorResponse(404, 'not_found', 'No such function') as never
        // Two instructions, the first with three quarters of each counter.
        const part = (share: number) =>
          Object.fromEntries(Object.entries(fn).map(([counter, value]) => [counter, value * share]))
        return HttpResponse.json({
          name,
          counters: fn,
          disassembly_format: 'llvm-objdump',
          instructions: [
            { address: 0x1000, counters: part(0.75), text: `${name}: add` },
            { address: 0x1004, counters: part(0.25), text: `${name}: ret` },
          ],
        })
      },
    ),
  )
  return { commits, metadata, listed, disassembled }
}

/**
 * An answer for `mockWorld` that holds back the requests `when` picks, until `open` is called, then
 * answers them as the world does.
 */
export function heldBack<Key>(when: (key: Key) => boolean = () => true) {
  const { promise, open } = gate()
  const answer = async (key: Key) => {
    if (when(key)) await promise
    return undefined
  }
  return { answer, open }
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
