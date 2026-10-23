/**
 * The end-to-end tests run against the v5 image, in production's Compose stack, which `npm run
 * test:e2e` starts with tools/stack.sh, runs Playwright in, and tears down afterwards. `npm run
 * test:e2e` runs the app with two workers (`--env WEB_CONCURRENCY=2`), as production does
 * (`web_concurrency` in deployment/main/ec2.tf). What is left to set up here, once before the
 * tests: an admin key, and the seed data.
 *
 * The tests reach the stack through its Nginx, at `PROXY_URL` (see playwright.config.ts). The admin
 * token reaches them as `E2E_ADMIN_TOKEN` (see fixtures.ts). Once they are done, the stack's log is
 * written to `SERVER_LOG`.
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { seed } from '../tools/seed.ts'

const SERVER_LOG = path.join(import.meta.dirname, 'server.log')

/** The log of the app and of Nginx, from `since` on if given. */
export function stackLog(since?: Date): Buffer {
  const args = ['compose', 'logs', '--no-color', '--timestamps']
  if (since) args.push('--since', since.toISOString())
  return execFileSync('docker', [...args, 'app', 'nginx'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: Infinity,
  })
}

/** Create an admin key through the CLI, in the app's container, and return its token. */
function createAdminKey(): string {
  const args = ['lnt-v5', 'server', 'create-key', '--name', 'e2e-admin', '--scope', 'admin']
  // `create-key` prints the token alone on stdout. A failure's message holds its stderr.
  const token = execFileSync('docker', ['exec', process.env.CONTAINER!, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  if (!/^[0-9a-f]{64}$/.test(token)) {
    throw new Error(`Expected a 64-character hex token from create-key, got: ${token}`)
  }
  return token
}

export default async function globalSetup() {
  const url = process.env.PROXY_URL
  if (!url || !process.env.CONTAINER) {
    throw new Error('The stack is not set up: run the end-to-end tests with `npm run test:e2e`')
  }
  const teardown = () => writeFileSync(SERVER_LOG, stackLog())
  try {
    const token = createAdminKey()
    process.env.E2E_ADMIN_TOKEN = token
    await seed({ url, token: () => token, log: () => {} })
  } catch (error) {
    teardown()
    throw error
  }
  return teardown
}
