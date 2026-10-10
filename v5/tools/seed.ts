/**
 * Populates an LNT v5 instance with development data, through its public REST API:
 *
 * - the `libcxx` and `nts` suites, with their real runs from server/tests/data;
 * - a synthetic libcxx history, with regressions and profiles, and machines beyond the real ones
 *   (see synthetic.ts).
 *
 *     node tools/seed.ts [--url URL] [--token TOKEN]
 *
 * `--url` defaults to the dev server, http://localhost:3000. The token needs `manage` scope to
 * create the suites and `triage` for the regressions; it defaults to `$LNT_SEED_TOKEN`. Without
 * either, and only for the dev server, an admin key is created for the dev database (the one in
 * `.env`) with `lnt-v5 server create-key`.
 *
 * It never changes anything that exists: a suite that is already there is skipped whole, whatever
 * it holds. To seed one again, delete it first.
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import createClient, { type Client } from 'openapi-fetch'
import type { components, paths } from '../client/src/api/schema.d.ts'
import { libcxxSynthetic, type Submission } from './synthetic.ts'
import { uv, V5 } from './uv.ts'

const DATA = path.join(V5, 'server', 'tests', 'data')
const DEV_SERVER = 'http://localhost:3000'

type Api = Client<paths>

interface Suite {
  name: string
  /** What to submit after the suite's real runs. */
  extra?: (api: Api, realRuns: Submission[]) => Promise<void>
}

const SUITES: Suite[] = [
  {
    name: 'libcxx',
    async extra(api, realRuns) {
      const { runs, regressions } = libcxxSynthetic(realRuns)
      await submitAll(api, 'libcxx', runs)
      const params = { path: { testsuite: 'libcxx' } }
      for (const body of regressions) {
        check(await api.POST('/api/suites/{testsuite}/regressions', { params, body }))
      }
    },
  },
  { name: 'nts' },
]

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Throw unless the API call succeeded. */
function check({ response, error }: { response: Response; error?: unknown }): void {
  if (!response.ok) {
    throw new Error(`${response.url}: HTTP ${response.status}: ${JSON.stringify(error)}`)
  }
}

/** A suite's real runs, oldest commit first. */
function realRuns(suite: string): Submission[] {
  const directory = path.join(DATA, suite, 'runs')
  return readdirSync(directory)
    .sort()
    .map((file) => readJson(path.join(directory, file)) as Submission)
    .sort((a, b) => (a.commit.ordinal ?? 0) - (b.commit.ordinal ?? 0))
}

async function submitAll(api: Api, suite: string, runs: Submission[]): Promise<void> {
  // One at a time, so that commits are first seen, and runs submitted, in a reproducible order.
  const params = { path: { testsuite: suite } }
  for (const body of runs) check(await api.POST('/api/suites/{testsuite}/runs', { params, body }))
}

async function populate(api: Api, url: string, suite: Suite): Promise<void> {
  const file = path.join(DATA, suite.name, 'schema.json')
  const schema = readJson(file) as components['schemas']['SuiteSchemaInput']
  check(await api.POST('/api/suites', { body: schema }))
  try {
    const runs = realRuns(suite.name)
    await submitAll(api, suite.name, runs)
    await suite.extra?.(api, runs)
  } catch (error) {
    // Otherwise every later seed would skip the suite, because it exists.
    throw new Error(
      `${messageOf(error)}\nThe suite '${suite.name}' was left incomplete. To seed it again, ` +
        `delete it first: DELETE ${url}/api/suites/${suite.name}?confirm=true`,
      { cause: error },
    )
  }
}

export interface SeedOptions {
  /** Where the server is, e.g. `http://localhost:3000`. */
  url: string
  /** The token to write with. Only asked for if there is anything to seed. */
  token: () => string
  log?: (message: string) => void
}

/** Seed every suite that does not exist yet; return the names of those seeded and skipped. */
export async function seed({ url, token, log = console.log }: SeedOptions) {
  const anonymous = createClient<paths>({ baseUrl: url })
  const missing: Suite[] = []
  const skipped: string[] = []
  for (const suite of SUITES) {
    const params = { path: { name: suite.name } }
    const { response, error } = await anonymous.GET('/api/suites/{name}', { params })
    if (response.status === 404) {
      missing.push(suite)
    } else {
      check({ response, error })
      skipped.push(suite.name)
      log(`Suite '${suite.name}' already exists; leaving it alone.`)
    }
  }
  if (missing.length > 0) {
    const headers = { Authorization: `Bearer ${token()}` }
    const api = createClient<paths>({ baseUrl: url, headers })
    for (const suite of missing) {
      const started = Date.now()
      await populate(api, url, suite)
      log(`Seeded suite '${suite.name}' in ${((Date.now() - started) / 1000).toFixed(1)}s.`)
    }
  }
  return { seeded: missing.map((suite) => suite.name), skipped }
}

/**
 * The token to seed `url` with. Only the dev server's database is known, the one in `.env`, so a
 * key is only created for that one: for any other server, the token has to be given.
 */
function tokenFor(url: string, given: string | undefined): string {
  if (given !== undefined) return given
  if (url !== DEV_SERVER) {
    throw new Error(`Seeding ${url} needs a token: pass --token, or set LNT_SEED_TOKEN.`)
  }
  console.log('Creating an admin key named "seed" for the database in .env.')
  const args = ['lnt-v5', 'server', 'create-key', '--name', 'seed', '--scope', 'admin']
  return uv(['--env-file', '.env', ...args]).trim()
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { url: { type: 'string', default: DEV_SERVER }, token: { type: 'string' } },
  })
  const url = values.url.replace(/\/$/, '')
  try {
    await seed({ url, token: () => tokenFor(url, values.token ?? process.env.LNT_SEED_TOKEN) })
  } catch (error) {
    console.error(`seed: ${messageOf(error)}`)
    if (error instanceof TypeError) {
      console.error(`Is the server running at ${url}? Start it with \`npm run dev\`.`)
    }
    process.exitCode = 1
  }
}
