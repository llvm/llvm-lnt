/**
 * What every end-to-end test imports instead of `@playwright/test`:
 *
 * - `tokenFor(scope)`: a token for a new key of that scope, to act as a user who holds it.
 * - `signIn(page, scope)`: store such a token in `page`'s browser, as the Settings panel does, so
 *   that the pages it loads from then on use it. Returns the token.
 * - The server's output while a test ran, attached to it when it fails.
 *
 * Every test runs against the same seeded database, and locally several run at once. So a test
 * that writes creates entities of its own, named uniquely (with `testInfo.testId`, say), and never
 * modifies or deletes seeded ones; and no test assumes that the seeded entities are all there is.
 */

import { readFileSync, statSync } from 'node:fs'
import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test'
import type { components } from '../client/src/api/schema.d.ts'
import { TOKEN_STORAGE_KEY } from '../client/src/auth/storage-key.ts'
import { SERVER_LOG } from './global-setup.ts'

export { expect }

export type Scope = components['schemas']['Scope']

/** A real libcxx run (server/tests/data/libcxx/runs/r552558-linux-1.json): 25 tests, once each. */
export const REAL_RUN = '5f85edeb-a65b-4b2f-ab83-9152007dc703'

/** The token of the admin key the stack was seeded with (see global-setup.ts). */
export function adminToken(): string {
  const token = process.env.E2E_ADMIN_TOKEN
  if (!token) throw new Error('E2E_ADMIN_TOKEN is not set: run the tests with playwright.config.ts')
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

interface Fixtures {
  tokenFor: (scope: Scope) => Promise<string>
  signIn: (page: Page, scope: Scope) => Promise<string>
  serverLog: void
}

export const test = base.extend<Fixtures>({
  tokenFor: async ({ request }, use) => {
    await use(async (scope) => {
      const response = await request.post('/api/admin/api-keys', {
        headers: { Authorization: `Bearer ${adminToken()}` },
        data: { name: `e2e-${scope}`, scope },
      })
      expect(response.status(), await response.text()).toBe(201)
      return ((await response.json()) as components['schemas']['ApiKeyCreated']).token
    })
  },

  signIn: async ({ tokenFor }, use) => {
    await use(async (page, scope) => {
      const token = await tokenFor(scope)
      // Storage belongs to an origin, so the page needs one first: the cheapest the server serves.
      await page.goto('/healthz')
      await page.evaluate(([key, value]) => localStorage.setItem(key, value), [
        TOKEN_STORAGE_KEY,
        token,
      ])
      return token
    })
  },

  // With several workers, the excerpt also holds whatever the others' tests logged meanwhile.
  serverLog: [
    // Playwright requires the fixtures argument to be destructured, even when none is used.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, testInfo) => {
      const start = statSync(SERVER_LOG).size
      await use()
      if (testInfo.status !== testInfo.expectedStatus) {
        const body = readFileSync(SERVER_LOG).subarray(start)
        await testInfo.attach('server.log', { body, contentType: 'text/plain' })
      }
    },
    { auto: true },
  ],
})
