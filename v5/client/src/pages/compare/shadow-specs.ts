/** The shadows of the Compare page (CP8) as the URL spells them (CP7). */

import {
  formatCommitOfMachine,
  parseCommitOfMachine,
  type CommitOfMachine,
} from '../../components/checked-commits'
import type { Param } from '../../url-state'

/** At most how many shadows can be pinned at once (CP8). */
export const MAX_SHADOWS = 5

/**
 * A shadow: a side B pinned. Its runs are those it selects, each once, in ascending order, or none
 * when it selects every run of its commit.
 */
export interface ShadowSpec extends CommitOfMachine {
  runs: string[]
}

/** The shadow of a side whose settings are `side`, its runs as `ShadowSpec` holds them. */
export function shadowOf(side: ShadowSpec): ShadowSpec {
  const { suite, machine, commit, runs } = side
  return { suite, machine, commit, runs: [...new Set(runs)].sort() }
}

/**
 * The shadow `text` names, or null if it is malformed: `{suite}/{machine}/{commit}`, followed by
 * `/{run},{run}...` when it selects only some of its commit's runs. None of the names can contain a
 * `/` (I1), and only the runs are told apart by commas, which a machine or a commit may contain. No
 * part, and no run, can be empty.
 */
export function parseShadow(text: string): ShadowSpec | null {
  const parts = text.split('/')
  const base = parseCommitOfMachine(parts.slice(0, 3))
  if (base === null || parts.length > 4) return null
  const runs = parts.length === 4 ? parts[3].split(',') : []
  if (runs.some((run) => run === '')) return null
  return shadowOf({ ...base, runs })
}

/** `spec`, as the URL spells it, which tells it apart from any other shadow. */
export function formatShadow(spec: ShadowSpec): string {
  const base = formatCommitOfMachine(spec)
  return spec.runs.length === 0 ? base : `${base}/${spec.runs.join(',')}`
}

/** `specs`, each once, in the order first given. */
export function uniqueShadows(specs: readonly ShadowSpec[]): ShadowSpec[] {
  return [...new Map(specs.map((spec) => [formatShadow(spec), spec])).values()]
}

/**
 * The shadows, repeated once per shadow (CP7): malformed ones dropped, the others each kept once,
 * in the order first given, and only the first `MAX_SHADOWS` of them.
 */
export function shadowParam(): Param<ShadowSpec[]> {
  return {
    default: [],
    parse: (values) =>
      uniqueShadows(values.flatMap((value) => parseShadow(value) ?? [])).slice(0, MAX_SHADOWS),
    serialize: (specs) => specs.map(formatShadow),
  }
}
