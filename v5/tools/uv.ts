import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export const V5 = path.resolve(import.meta.dirname, '..')

/**
 * Add the variables in v5/.env, if there is one, to the environment, for the tools that act on the
 * dev stack it configures. Variables that are already set keep their values.
 */
export function loadDotEnv(): void {
  const file = path.join(V5, '.env')
  if (existsSync(file)) process.loadEnvFile(file)
}

/**
 * Run `args` in the server's project, and return its stdout. Its stderr is only shown if it fails,
 * as part of the error.
 */
export function uv(args: string[]): string {
  try {
    return execFileSync('uv', ['run', '--project', path.join(V5, 'server'), ...args], {
      cwd: V5,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim()
    const message = `\`uv run ${args.join(' ')}\` failed${stderr ? `:\n${stderr}` : ''}`
    throw new Error(message, { cause: error })
  }
}
