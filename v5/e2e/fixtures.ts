/**
 * What every end-to-end test imports instead of `@playwright/test`:
 *
 * - `tokenFor(scope, restrictedTo?)`: a token for a new key of that scope, restricted to the suites
 *   `restrictedTo` names (each by its project's name and its own) if given, to act as a user who
 *   holds it.
 * - `signIn(page, scope, restrictedTo?)`: store such a token in `page`'s browser, as the Settings
 *   panel does, so that the pages it loads from then on use it. Returns the token.
 * - The log of the app and of Nginx while a test ran, attached to it when it fails.
 *
 * Every test runs against the same seeded database, and locally several run at once. So a test
 * that writes creates entities of its own, named uniquely (with `testInfo.testId`, say), and never
 * modifies or deletes seeded ones; and no test assumes that the seeded entities are all there is.
 */

import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test'
import type { components } from '../client/src/api/schema.d.ts'
import type { SuiteRef } from '../client/src/api/suite-ref.ts'
import { TOKEN_STORAGE_KEY } from '../client/src/auth/storage-key.ts'
import { BENCHMARKS, NTS } from '../tools/seed.ts'
import { stackLog } from './global-setup.ts'

export { expect }

export type Scope = components['schemas']['Scope']

export type { SuiteRef }
export { BENCHMARKS, NTS }

/**
 * A real libcxx run of `libcxx/benchmarks` (server/tests/data/libcxx/runs/r552558-linux-1.json): 25
 * tests, once each.
 */
export const REAL_RUN = '5f85edeb-a65b-4b2f-ab83-9152007dc703'

/** The token of the admin key the stack was seeded with (see global-setup.ts). */
export function adminToken(): string {
  const token = process.env.E2E_ADMIN_TOKEN
  if (!token) {
    throw new Error('E2E_ADMIN_TOKEN is not set: run the end-to-end tests with `npm run test:e2e`')
  }
  return token
}

/** The body of a successful `GET path`, failing the test with the API's answer otherwise. */
export async function json<T>(
  request: APIRequestContext,
  path: string,
  headers?: Record<string, string>,
): Promise<T> {
  const response = await request.get(path, { headers })
  expect(response.status(), await response.text()).toBe(200)
  return (await response.json()) as T
}

/**
 * The UUID of the latest `libcxx/benchmarks` run of `machine` at `commit` that has profiles: the
 * one the Profiles page selects, and Compare's Profile links lead to (see tools/synthetic.ts for
 * which runs have profiles).
 */
export async function profiledRun(request: APIRequestContext, machine: string, commit: string) {
  const query = `machine=${machine}&commit=${commit}&has_profiles=true&sort=-measured_at&limit=1`
  const path = `/api/projects/libcxx/suites/benchmarks/runs?${query}`
  return (await json<components['schemas']['RunCursorPage']>(request, path)).items[0].uuid
}

interface Fixtures {
  tokenFor: (scope: Scope, restrictedTo?: SuiteRef[]) => Promise<string>
  signIn: (page: Page, scope: Scope, restrictedTo?: SuiteRef[]) => Promise<string>
  serverLog: void
}

export const test = base.extend<Fixtures>({
  tokenFor: async ({ request }, use) => {
    await use(async (scope, restrictedTo) => {
      const response = await request.post('/api/admin/api-keys', {
        headers: { Authorization: `Bearer ${adminToken()}` },
        data: { name: `e2e-${scope}`, scope, restricted_to: restrictedTo },
      })
      expect(response.status(), await response.text()).toBe(201)
      return ((await response.json()) as components['schemas']['ApiKeyCreated']).token
    })
  },

  signIn: async ({ tokenFor }, use) => {
    await use(async (page, scope, restrictedTo) => {
      const token = await tokenFor(scope, restrictedTo)
      // Storage belongs to an origin, so the page needs one first: the cheapest the server serves.
      await page.goto('/healthz')
      await page.evaluate(([key, value]) => localStorage.setItem(key, value), [
        TOKEN_STORAGE_KEY,
        token,
      ])
      return token
    })
  },

  // With several workers, the excerpt also holds whatever the others' tests logged meanwhile. It
  // starts a little before the test, since the containers' clock may be slightly off the host's.
  serverLog: [
    // Playwright requires the fixtures argument to be destructured, even when none is used.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, testInfo) => {
      const since = new Date(Date.now() - 2000)
      await use()
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('server.log', { body: stackLog(since), contentType: 'text/plain' })
      }
    },
    { auto: true },
  ],
})
