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
 * Create a suite named after the test, with the metrics `execution_time` and `compile_time`, and
 * the machine field `hardware`, submit `runs` to it, and call `use` with its name and the UUIDs of
 * the runs, in order. The suite is deleted once `use` returns.
 */
export async function ownSuite(
  request: APIRequestContext,
  tokenFor: (scope: Scope) => Promise<string>,
  testInfo: TestInfo,
  runs: OwnRun[],
  use: (suite: string, runs: string[]) => Promise<void>,
) {
  const suite = `e2e_${testInfo.testId.toLowerCase().replace(/[^a-z0-9]/g, '_')}`.slice(0, 63)
  const headers = { Authorization: `Bearer ${await tokenFor('manage')}` }
  const created = await request.post('/api/suites', {
    headers,
    data: {
      name: suite,
      metrics: [
        { name: 'execution_time', type: 'real' },
        { name: 'compile_time', type: 'real' },
      ],
      machine_fields: [{ name: 'hardware', type: 'text' }],
    },
  })
  expect(created.status(), await created.text()).toBe(201)
  try {
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
  } finally {
    await request.delete(`/api/suites/${suite}?confirm=true`, { headers })
  }
}
