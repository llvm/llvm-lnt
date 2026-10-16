/**
 * The stack every end-to-end run tests against, set up once before the tests and torn down after
 * them: a throwaway database on the local PostgreSQL, the real server serving the built client on
 * a free port (`lnt-v5 server run`, which migrates the database first), an admin key, and the
 * seed data. The database and the port are this run's own, so that several checkouts can run the
 * tests at once.
 *
 * The server's URL and the admin token reach the tests as `E2E_BASE_URL` and `E2E_ADMIN_TOKEN`
 * (see fixtures.ts). The server's output is written to `SERVER_LOG`, which fixtures.ts attaches to
 * each failing test.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, openSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { seed } from '../tools/seed.ts'
import { uv, UV_RUN, V5 } from '../tools/uv.ts'

/** Unless E2E_PORT says otherwise, 0: the server picks a free port, and reports it in its log. */
const PORT = process.env.E2E_PORT ?? '0'
export const SERVER_LOG = path.join(import.meta.dirname, 'server.log')

/**
 * The line uvicorn logs once it listens. The match runs past the port, so that a line still being
 * written cannot yield half of one.
 */
const LISTENING = /Uvicorn running on \S+:(\d+) \(Press CTRL\+C/

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

async function isServing(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/healthz`)).ok
  } catch {
    return false
  }
}

/**
 * Wait for `server` to answer, and return its URL. The port is read from the server's own log
 * rather than probed for, so that the server found there is this one, whatever else is running.
 */
async function waitForServer(server: ChildProcess): Promise<string> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (server.exitCode !== null || server.signalCode !== null) break
    const port = LISTENING.exec(readFileSync(SERVER_LOG, 'utf8'))?.[1]
    const url = `http://127.0.0.1:${port}`
    if (port && (await isServing(url))) return url
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const tail = readFileSync(SERVER_LOG, 'utf8').split('\n').slice(-20).join('\n')
  throw new Error(`The server never answered. Its last output:\n${tail}`)
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
    server = spawn('uv', [...UV_RUN, 'lnt-v5', 'server', 'run', '--port', PORT], {
      env: { ...process.env, ...env },
      stdio: ['ignore', log, log],
      detached: true,
    })
    closeSync(log)
    const url = await waitForServer(server)
    process.env.E2E_BASE_URL = url

    const args = ['lnt-v5', 'server', 'create-key', '--name', 'e2e-admin', '--scope', 'admin']
    const token = uv(args, env).trim()
    process.env.E2E_ADMIN_TOKEN = token
    await seed({ url, token: () => token, log: () => {} })
  } catch (error) {
    await teardown()
    throw error
  } finally {
    process.off('SIGINT', interrupted)
    process.off('SIGTERM', interrupted)
  }
  return teardown
}
