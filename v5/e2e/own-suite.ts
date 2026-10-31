/**
 * A suite of a test's own, in a project of its own, for tests that write: they leave the seeded
 * projects and suites alone, since what they add would show in the lists other tests read at the
 * same time (see fixtures.ts).
 */

import type { APIRequestContext, TestInfo } from '@playwright/test'
import type { components } from '../client/src/api/schema.d.ts'
import type { Submission } from '../tools/synthetic.ts'
import { suitePath } from '../client/src/paths.ts'
import { expect, type Scope, type SuiteRef } from './fixtures.ts'

/** A run to submit: its machine, its commit and ordinal, and its tests, as a submission has them. */
export interface OwnRun {
  machine: string
  commit: string
  ordinal: number
  tests: Submission['tests']
}

/**
 * A name of the test's own, one that no other test uses, that D7 allows for a project or a suite,
 * at most `length` characters long, so that a suffix can follow it.
 */
export function ownName(testInfo: TestInfo, length: number): string {
  return `e2e-${testInfo.testId.toLowerCase().replace(/[^a-z0-9]/g, '-')}`.slice(0, length)
}

/**
 * Create a project of the test's own, one that no other test uses, and call `use` with a suite of
 * the test's own in it, to create: the project is named after the test, and the suite after the
 * project, with `-s` after it, so that a client mixing up the two names cannot pass. Once `use`
 * returns, delete the suite, if `use` created one, and the project, with `manageToken`, which must
 * be instance-wide.
 */
export async function withOwnSuite(
  request: APIRequestContext,
  manageToken: string,
  testInfo: TestInfo,
  use: (suite: SuiteRef) => Promise<void>,
) {
  const project = ownName(testInfo, 62)
  const suite = { project, suite: `${project}-s` }
  const headers = { Authorization: `Bearer ${manageToken}` }
  const created = await request.post('/api/projects', { headers, data: { name: project } })
  expect(created.status(), await created.text()).toBe(201)
  try {
    await use(suite)
  } finally {
    await request.delete(`/api${suitePath(suite)}?confirm=true`, { headers })
    await request.delete(`/api/projects/${project}`, { headers })
  }
}

/**
 * Create a suite of the test's own, in a project of its own (see `withOwnSuite`), with the metrics
 * `execution_time` and `compile_time`, the listed machine field `hardware`, and the display commit
 * field `revision`, which no commit has a value for, submit `runs` to it, and call `use` with it
 * and the UUIDs of the runs, in order. The suite and the project are deleted once `use` returns.
 */
export async function ownSuite(
  request: APIRequestContext,
  tokenFor: (scope: Scope) => Promise<string>,
  testInfo: TestInfo,
  runs: OwnRun[],
  use: (suite: SuiteRef, runs: string[]) => Promise<void>,
) {
  const token = await tokenFor('manage')
  const headers = { Authorization: `Bearer ${token}` }
  await withOwnSuite(request, token, testInfo, async (suite) => {
    const created = await request.post(`/api/projects/${suite.project}/suites`, {
      headers,
      data: {
        name: suite.suite,
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
      const response = await request.post(`/api${suitePath(suite)}/runs`, {
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
