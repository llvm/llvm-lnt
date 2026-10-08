/**
 * The stack every end-to-end run tests against, set up once before the tests and torn down after
 * them: a throwaway database on the local PostgreSQL, the real server serving the built client on
 * its own port (`lnt-v5 server run`, which migrates the database first), an admin key, and the
 * seed data.
 *
 * The admin token reaches the tests as `E2E_ADMIN_TOKEN` (see fixtures.ts). The server's output is
 * written to `SERVER_LOG`, which fixtures.ts attaches to each failing test.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, openSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { seed } from '../tools/seed.ts'
import { uv, UV_RUN, V5 } from '../tools/uv.ts'

/** Not 3000 (the dev server) nor 3100 (the integration tests), so that all three can coexist. */
const PORT = Number(process.env.E2E_PORT ?? 3200)
export const BASE_URL = `http://127.0.0.1:${PORT}`
export const SERVER_LOG = path.join(import.meta.dirname, 'server.log')

/**
 * The server to create the throwaway database on: the one `npm run db:up` starts, and the one CI's
 * service container provides, as for the server tests.
 */
const POSTGRES = 'postgresql://lnt:lnt@127.0.0.1:5432'

/** Run one SQL statement against the `lnt` database, outside a transaction (CREATE DATABASE). */
function sql(statement: string): void {
  const script = [
    'import sys, psycopg',
    'with psycopg.connect(sys.argv[1], autocommit=True) as c: c.execute(sys.argv[2])',
  ].join('\n')
  uv(['python', '-c', script, `${POSTGRES}/lnt`, statement])
}

async function isServing(): Promise<boolean> {
  try {
    return (await fetch(`${BASE_URL}/healthz`)).ok
  } catch {
    return false
  }
}

async function waitForServer(server: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (server.exitCode !== null) break
    if (await isServing()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const tail = readFileSync(SERVER_LOG, 'utf8').split('\n').slice(-20).join('\n')
  throw new Error(`The server never answered ${BASE_URL}/healthz. Its last output:\n${tail}`)
}

/** Send `signal` to the server's whole process group, which may have exited already. */
function signalGroup(server: ChildProcess, signal: NodeJS.Signals): void {
  try {
    // The whole group: `uv run` starts the server as a child of its own.
    process.kill(-server.pid!, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

/** Stop the server and everything it started, waiting for it to exit. */
async function stop(server: ChildProcess): Promise<void> {
  const running = server.exitCode === null && server.signalCode === null
  const exited = running ? new Promise((resolve) => server.once('exit', resolve)) : null
  signalGroup(server, 'SIGTERM')
  const timeout = setTimeout(() => signalGroup(server, 'SIGKILL'), 10_000)
  await exited
  clearTimeout(timeout)
}

export default async function globalSetup() {
  // Otherwise the tests would quietly run against whatever is already there.
  if (await isServing()) {
    throw new Error(
      `Something is already serving ${BASE_URL}: a server left behind by an e2e run that was ` +
        'killed, perhaps, which you can stop. Or set E2E_PORT to use another port.',
    )
  }

  const database = `lnt_e2e_${randomBytes(6).toString('hex')}`
  const env = {
    DATABASE_URL: `${POSTGRES}/${database}`,
    CLIENT_DIST: path.join(V5, 'client', 'dist'),
  }
  let server: ChildProcess | undefined
  let created = false

  /** Drop the database, once: on an interrupt, the teardown below may have started too. */
  const dropDatabase = () => {
    if (!created) return
    created = false
    sql(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
  }
  const teardown = async () => {
    try {
      if (server) await stop(server)
    } finally {
      dropDatabase()
    }
  }

  // Playwright only runs the teardown once this returns it, and the server runs in a process group
  // of its own, which an interrupt does not reach: so an interrupt now must tear down by itself.
  // Synchronously, because Playwright exits as soon as it notices the interrupt too.
  const interrupted = (signal: NodeJS.Signals) => {
    if (server) signalGroup(server, 'SIGKILL')
    dropDatabase()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  }
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)

  try {
    sql(`CREATE DATABASE "${database}"`)
    created = true

    const log = openSync(SERVER_LOG, 'w')
    server = spawn('uv', [...UV_RUN, 'lnt-v5', 'server', 'run', '--port', String(PORT)], {
      env: { ...process.env, ...env },
      stdio: ['ignore', log, log],
      detached: true,
    })
    closeSync(log)
    await waitForServer(server)

    const args = ['lnt-v5', 'server', 'create-key', '--name', 'e2e-admin', '--scope', 'admin']
    const token = uv(args, env).trim()
    process.env.E2E_ADMIN_TOKEN = token
    await seed({ url: BASE_URL, token: () => token, log: () => {} })
  } catch (error) {
    await teardown()
    throw error
  } finally {
    process.off('SIGINT', interrupted)
    process.off('SIGTERM', interrupted)
  }
  return teardown
}
