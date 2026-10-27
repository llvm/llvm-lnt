/**
 * A suite of a test's own, for tests that write: they leave the seeded suites alone, since what
 * they add would show in the lists other tests read at the same time (see fixtures.ts).
 */

import type { APIRequestContext, TestInfo } from '@playwright/test'
import type { components } from '../client/src/api/schema.d.ts'
import type { Submission } from '../tools/synthetic.ts'
import { expect, type Scope } from './fixtures.ts'

/** A run to submit: its machine, its commit and ordinal, and its tests, as a submission has them. */
export interface OwnRun {
  machine: string
  commit: string
  ordinal: number
  tests: Submission['tests']
}

/**
 * Call `use` with the name of a suite of the test's own, one that no other test uses, and delete the
 * suite, if `use` created one, once it returns, with `manageToken`.
 */
export async function withOwnSuiteName(
  request: APIRequestContext,
  manageToken: string,
  testInfo: TestInfo,
  use: (suite: string) => Promise<void>,
) {
  const suite = `e2e_${testInfo.testId.toLowerCase().replace(/[^a-z0-9]/g, '_')}`.slice(0, 63)
  try {
    await use(suite)
  } finally {
    await request.delete(`/api/suites/${suite}?confirm=true`, {
      headers: { Authorization: `Bearer ${manageToken}` },
    })
  }
}

/**
 * Create a suite named after the test, with the metrics `execution_time` and `compile_time`, the
 * listed machine field `hardware`, and the display commit field `revision`, which no commit has a
 * value for, submit `runs` to it, and call `use` with its name and the UUIDs of the runs, in order.
 * The suite is deleted once `use` returns.
 */
export async function ownSuite(
  request: APIRequestContext,
  tokenFor: (scope: Scope) => Promise<string>,
  testInfo: TestInfo,
  runs: OwnRun[],
  use: (suite: string, runs: string[]) => Promise<void>,
) {
  const token = await tokenFor('manage')
  const headers = { Authorization: `Bearer ${token}` }
  await withOwnSuiteName(request, token, testInfo, async (suite) => {
    const created = await request.post('/api/suites', {
      headers,
      data: {
        name: suite,
        metrics: [
          { name: 'execution_time', type: 'real' },
          { name: 'compile_time', type: 'real' },
        ],
        machine_fields: [{ name: 'hardware', type: 'text', listed: true }],
        commit_fields: [{ name: 'revision', type: 'text', display: true }],
      },
    })
    expect(created.status(), await created.text()).toBe(201)
    const uuids: string[] = []
    for (const { machine, commit, ordinal, tests } of runs) {
      const response = await request.post(`/api/suites/${suite}/runs`, {
        headers,
        data: {
          format_version: '5',
          machine: { name: machine, fields: { hardware: 'Apple M4' } },
          commit: { value: commit, ordinal },
          tests,
        },
      })
      expect(response.status(), await response.text()).toBe(201)
      uuids.push(((await response.json()) as components['schemas']['RunDetail']).uuid)
    }
    await use(suite, uuids)
  })
}
