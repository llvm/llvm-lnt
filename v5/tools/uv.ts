import { execFileSync } from 'node:child_process'
import path from 'node:path'

export const V5 = path.resolve(import.meta.dirname, '..')

/** `uv run` in the server's project: what precedes the command, for running it yourself. */
export const UV_RUN = ['run', '--project', path.join(V5, 'server')]

/**
 * Run `args` in the server's project, with `env` added to the environment, and return its stdout.
 * Its stderr is only shown if it fails, as part of the error.
 */
export function uv(args: string[], env: Record<string, string> = {}): string {
  try {
    return execFileSync('uv', [...UV_RUN, ...args], {
      cwd: V5,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim()
    const message = `\`uv run ${args.join(' ')}\` failed${stderr ? `:\n${stderr}` : ''}`
    throw new Error(message, { cause: error })
  }
}
