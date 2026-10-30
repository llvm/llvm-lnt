/**
 * Populates an LNT v5 instance with development data, through its public REST API:
 *
 * - the `libcxx` project ("libc++"), with the `benchmarks` suite ("Microbenchmarks") and its real
 *   runs from server/tests/data/libcxx, and the `header-sizes` suite, without runs;
 * - the `llvm` project ("LLVM"), with the `nts` suite and its real runs from server/tests/data/nts;
 * - the `swift` project, without a display name or suites;
 * - a synthetic history of `libcxx/benchmarks`, with regressions and profiles, and machines beyond
 *   the real ones (see synthetic.ts);
 * - API keys of every scope, one of them revoked and some restricted to one suite or two, for the
 *   Admin page to list. Their tokens are thrown away, so that nothing can authenticate with them.
 *
 *     node tools/seed.ts [--url URL] [--token TOKEN]
 *
 * `--url` defaults to the dev server, http://localhost:3000 unless `DEV_SERVER_PORT` in `.env`
 * moves it (see .env.example). The token needs `manage` scope covering everything to create the
 * projects and suites, `triage` for the regressions, and `admin` for the keys, which a token
 * without it skips; it defaults to `$LNT_SEED_TOKEN`. Without either, and only for the dev server,
 * an admin key is created for the dev database (the one in `.env`) with `lnt-v5 server create-key`.
 *
 * It never changes anything that exists: a project that is already there is left as it is, its
 * display name included, and only its missing suites are added; a suite that is already there is
 * skipped whole, whatever it holds; and a key is created only if no key has its name. To seed a
 * suite again, delete it first. Deleting it also removes it from the keys restricted to it, which
 * seeding again leaves as they are, since keys of their names exist (revoking them does not help:
 * revoked keys keep their names), so they then cover less, or nothing: only a database with no key
 * of their names, such as an empty one, has them seeded anew. The keys are seeded along with a
 * project or a suite, so that seeding an instance that has everything asks for no token, and writes
 * nothing.
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { gzipSync } from 'node:zlib'
import createClient, { type Client } from 'openapi-fetch'
import type { components, paths } from '../client/src/api/schema.d.ts'
import type { SuiteRef } from '../client/src/api/suite-ref.ts'
import { libcxxSynthetic, type Submission } from './synthetic.ts'
import { loadDotEnv, uv, V5 } from './uv.ts'

const DATA = path.join(V5, 'server', 'tests', 'data')

/** The dev server's URL, once `.env` is loaded. */
function devServer(): string {
  return `http://localhost:${process.env.DEV_SERVER_PORT || 3000}`
}

type Api = Client<paths>

type SuiteSchemaInput = components['schemas']['SuiteSchemaInput']

interface Suite {
  name: string
  display_name?: string
  /** The directory of server/tests/data holding the suite's schema and real runs, if it has any. */
  data?: string
  /** The suite's schema, but for its names, when it has no data. */
  schema?: Omit<SuiteSchemaInput, 'name' | 'display_name'>
  /** What to submit after the suite's real runs. */
  extra?: (api: Api, realRuns: Submission[]) => Promise<void>
}

interface Project {
  name: string
  display_name?: string
  suites: Suite[]
}

/** The seeded suite of the real libcxx runs and their synthetic history. */
export const BENCHMARKS: SuiteRef = { project: 'libcxx', suite: 'benchmarks' }

/** The seeded suite of the real nts runs. */
export const NTS: SuiteRef = { project: 'llvm', suite: 'nts' }

export const PROJECTS: Project[] = [
  {
    name: 'libcxx',
    display_name: 'libc++',
    suites: [
      {
        name: 'benchmarks',
        display_name: 'Microbenchmarks',
        data: 'libcxx',
        async extra(api, realRuns) {
          const { runs, regressions } = libcxxSynthetic(realRuns)
          await submitAll(api, BENCHMARKS, runs)
          const params = { path: BENCHMARKS }
          for (const body of regressions) {
            const path = '/api/projects/{project}/suites/{suite}/regressions'
            check(await api.POST(path, { params, body }))
          }
        },
      },
      {
        // A suite without runs, nor a display name.
        name: 'header-sizes',
        schema: {
          metrics: [
            {
              name: 'preprocessed_size',
              type: 'integer',
              display_name: 'Preprocessed Size',
              unit: 'bytes',
              unit_abbrev: 'B',
              dashboard: true,
            },
          ],
          machine_fields: [],
          commit_fields: [],
        },
      },
    ],
  },
  { name: 'llvm', display_name: 'LLVM', suites: [{ name: 'nts', data: 'nts' }] },
  // A project without a display name, nor suites.
  { name: 'swift', suites: [] },
]

/**
 * The keys to seed, each never used: the Admin page shows every scope, a revoked key, and keys
 * restricted to some suites. Those are created after the suites, since a key can only be restricted
 * to suites that exist.
 */
export const KEYS: {
  name: string
  scope: components['schemas']['Scope']
  restricted_to?: SuiteRef[]
  revoked?: true
}[] = [
  { name: 'dashboard-reader', scope: 'read' },
  { name: 'ci-submitter', scope: 'submit' },
  { name: 'triage-bot', scope: 'triage' },
  { name: 'release-manager', scope: 'manage' },
  { name: 'ops-admin', scope: 'admin' },
  { name: 'retired-bot', scope: 'submit', revoked: true },
  { name: 'libcxx-submitter', scope: 'submit', restricted_to: [BENCHMARKS] },
  { name: 'perf-triager', scope: 'triage', restricted_to: [BENCHMARKS, NTS] },
  { name: 'nts-maintainer', scope: 'manage', restricted_to: [NTS] },
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

/** The real runs in the directory `data` of server/tests/data, oldest commit first. */
function realRuns(data: string): Submission[] {
  const directory = path.join(DATA, data, 'runs')
  return readdirSync(directory)
    .sort()
    .map((file) => readJson(path.join(directory, file)) as Submission)
    .sort((a, b) => (a.commit.ordinal ?? 0) - (b.commit.ordinal ?? 0))
}

async function submitAll(api: Api, suite: SuiteRef, runs: Submission[]): Promise<void> {
  // One at a time, so that commits are first seen, and runs submitted, in a reproducible order.
  // Compressed, as O1 encourages, so that the end-to-end tests, which seed with this, submit runs
  // the way real clients should.
  const params = { path: suite }
  const headers = { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }
  const bodySerializer = (body: Submission) => gzipSync(JSON.stringify(body))
  for (const body of runs) {
    check(
      await api.POST('/api/projects/{project}/suites/{suite}/runs', {
        params,
        body,
        headers,
        bodySerializer,
      }),
    )
  }
}

/** The schema of `suite`, with its names. */
function schemaOf(suite: Suite): SuiteSchemaInput {
  const schema = suite.data
    ? (readJson(path.join(DATA, suite.data, 'schema.json')) as SuiteSchemaInput)
    : suite.schema!
  return { ...schema, name: suite.name, display_name: suite.display_name ?? null }
}

async function populate(api: Api, url: string, project: string, suite: Suite): Promise<void> {
  const params = { path: { project } }
  check(await api.POST('/api/projects/{project}/suites', { params, body: schemaOf(suite) }))
  try {
    const runs = suite.data ? realRuns(suite.data) : []
    await submitAll(api, { project, suite: suite.name }, runs)
    await suite.extra?.(api, runs)
  } catch (error) {
    // Otherwise every later seed would skip the suite, because it exists.
    throw new Error(
      `${messageOf(error)}\nThe suite '${project}/${suite.name}' was left incomplete. To seed it ` +
        `again, delete it first: DELETE ${url}/api/projects/${project}/suites/${suite.name}` +
        '?confirm=true',
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

/**
 * Seed every project and suite that does not exist yet; return the names of the projects created,
 * and the full names (`{project}/{suite}`) of the suites seeded and skipped.
 */
export async function seed({ url, token, log = console.log }: SeedOptions) {
  const anonymous = createClient<paths>({ baseUrl: url })
  const listed = await anonymous.GET('/api/projects')
  check(listed)
  const existing = new Map(listed.data!.items.map((project) => [project.name, project]))
  const created: string[] = []
  const missing: { project: string; suite: Suite }[] = []
  const skipped: string[] = []
  for (const project of PROJECTS) {
    const held = existing.get(project.name)
    if (held === undefined) created.push(project.name)
    for (const suite of project.suites) {
      if (held?.suites.some((schema) => schema.name === suite.name)) {
        skipped.push(`${project.name}/${suite.name}`)
        log(`Suite '${project.name}/${suite.name}' already exists; leaving it alone.`)
      } else {
        missing.push({ project: project.name, suite })
      }
    }
  }
  if (created.length > 0 || missing.length > 0) {
    const headers = { Authorization: `Bearer ${token()}` }
    const api = createClient<paths>({ baseUrl: url, headers })
    for (const project of PROJECTS.filter((entry) => created.includes(entry.name))) {
      const body = { name: project.name, display_name: project.display_name ?? null }
      check(await api.POST('/api/projects', { body }))
      log(`Created project '${project.name}'.`)
    }
    for (const { project, suite } of missing) {
      const started = Date.now()
      await populate(api, url, project, suite)
      const seconds = ((Date.now() - started) / 1000).toFixed(1)
      log(`Seeded suite '${project}/${suite.name}' in ${seconds}s.`)
    }
    await seedKeys(api, log)
  }
  return {
    created,
    seeded: missing.map(({ project, suite }) => `${project}/${suite.name}`),
    skipped,
  }
}

/** Create the keys of `KEYS` that no key is named after, if `api`'s token has `admin` scope. */
async function seedKeys(api: Api, log: (message: string) => void): Promise<void> {
  const auth = await api.GET('/api/auth')
  check(auth)
  if (auth.data?.key?.scope !== 'admin') {
    log('Skipping the API keys, which seeding needs a token with admin scope for.')
    return
  }
  const listed = await api.GET('/api/admin/api-keys')
  check(listed)
  const existing = new Set(listed.data!.items.map((key) => key.name))
  const wanted = KEYS.filter((key) => !existing.has(key.name))
  for (const { name, scope, restricted_to, revoked } of wanted) {
    const created = await api.POST('/api/admin/api-keys', { body: { name, scope, restricted_to } })
    check(created)
    if (revoked) {
      const params = { path: { prefix: created.data!.prefix } }
      check(await api.DELETE('/api/admin/api-keys/{prefix}', { params }))
    }
  }
}

/**
 * The token to seed `url` with. Only the dev server's database is known, the one in `.env`, so a
 * key is only created for that one: for any other server, the token has to be given.
 */
function tokenFor(url: string, given: string | undefined): string {
  if (given !== undefined) return given
  if (url !== devServer()) {
    throw new Error(`Seeding ${url} needs a token: pass --token, or set LNT_SEED_TOKEN.`)
  }
  console.log('Creating an admin key named "seed" for the database in .env.')
  const args = ['lnt-v5', 'server', 'create-key', '--name', 'seed', '--scope', 'admin']
  return uv(['--env-file', '.env', ...args]).trim()
}

if (import.meta.main) {
  // Here rather than at the top, so that importing `seed`, as the end-to-end tests do, does not
  // load .env.
  loadDotEnv()
  const { values } = parseArgs({
    options: { url: { type: 'string', default: devServer() }, token: { type: 'string' } },
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
