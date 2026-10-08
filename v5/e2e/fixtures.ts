/**
 * What every end-to-end test imports instead of `@playwright/test`:
 *
 * - `tokenFor(scope)`: a token for a new key of that scope, to act as a user who holds it.
 * - The server's output while a test ran, attached to it when it fails.
 *
 * Every test runs against the same seeded database, and locally several run at once. So a test
 * that writes creates entities of its own, named uniquely (with `testInfo.testId`, say), and never
 * modifies or deletes seeded ones; and no test assumes that the seeded entities are all there is.
 */

import { readFileSync, statSync } from 'node:fs'
import { test as base, expect } from '@playwright/test'
import type { components } from '../client/src/api/schema.d.ts'
import { SERVER_LOG } from './global-setup.ts'

export { expect }

export type Scope = components['schemas']['Scope']

/** The token of the admin key the stack was seeded with (see global-setup.ts). */
export function adminToken(): string {
  const token = process.env.E2E_ADMIN_TOKEN
  if (!token) throw new Error('E2E_ADMIN_TOKEN is not set: run the tests with playwright.config.ts')
  return token
}

export const test = base.extend<{ tokenFor: (scope: Scope) => Promise<string>; serverLog: void }>({
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
