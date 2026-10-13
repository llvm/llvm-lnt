/** How far the Compare page is from a comparison (CP6): what it still needs, and what it loads. */

import type { SampleState } from '../../api/runs'
import { plural } from '../../format'
import type { Side } from './use-side'

/** What the page's progress reads of a side. */
export type SideProgress = Pick<Side, 'id' | 'settings' | 'schema' | 'selected' | 'wanted'> & {
  runs: Pick<Side['runs'], 'isError'>
}

/**
 * The runs `side` has selected, by `runRefKey`, in the order they were submitted, once the
 * selection is known: then they are those it wants the samples of.
 */
export function chosenRuns(side: Pick<Side, 'selected' | 'wanted'>): string[] {
  return side.selected === undefined ? [] : side.wanted
}

/** The runs `a` and `b` have selected, each once, even when both sides select it. */
export function sidesRuns(a: SideProgress, b: SideProgress): Set<string> {
  return new Set([...chosenRuns(a), ...chosenRuns(b)])
}

/** Whether the samples of a run could not be loaded. */
export function hasFailed(state: SampleState | undefined): state is SampleState {
  return state?.error != null
}

/** The runs `a` and `b` have selected whose samples could not be loaded, as `states` has them. */
export function failedRuns(
  a: SideProgress,
  b: SideProgress,
  states: ReadonlyMap<string, SampleState>,
): SampleState[] {
  return [...sidesRuns(a, b)].map((key) => states.get(key)).filter(hasFailed)
}

/** `a run`, or `3 runs`. */
export function runCount(count: number): string {
  return count === 1 ? 'a run' : plural(count, 'run')
}

/** What the comparison still needs before it can be computed, if anything (CP6 "Empty states"). */
function missingInput(
  a: SideProgress,
  b: SideProgress,
  offered: number,
  chosen: boolean,
): string | null {
  for (const side of [a, b]) {
    const letter = side.id.toUpperCase()
    const { machine, commit } = side.settings
    if (side.schema === undefined) return `Select a suite for side ${letter}.`
    if (machine === '') return `Select a machine for side ${letter}.`
    if (commit === '') return `Select a commit for side ${letter}.`
    if (side.selected?.size === 0) return `Select a run for side ${letter}.`
  }
  if (offered === 0) return 'The two suites have no metric that can be compared.'
  if (!chosen) return 'Select a metric.'
  return null
}

/**
 * What the page shows in place of the comparison while there is none (CP6): that it is loading,
 * what it still needs, or nothing, when what it could not load is reported already.
 */
export type Waiting =
  | { kind: 'loading'; label?: string }
  | { kind: 'missing'; text: string }
  | { kind: 'failed' }

interface Status {
  /** Whether the suites are still being listed. */
  suitesPending: boolean
  /** How many metrics the page offers, and whether one is chosen. */
  offered: number
  metric: boolean
  /** Whether the comparison is computed. */
  compared: boolean
}

/**
 * What the page waits for before it can show the comparison of `a` and `b`, whose runs' samples
 * `states` has, or null once it shows it.
 */
export function waiting(
  a: SideProgress,
  b: SideProgress,
  states: ReadonlyMap<string, SampleState>,
  { suitesPending, offered, metric, compared }: Status,
): Waiting | null {
  if (suitesPending) return { kind: 'loading' }
  const missing = missingInput(a, b, offered, metric)
  if (missing !== null) return { kind: 'missing', text: missing }
  const chosen = [...sidesRuns(a, b)].map((key) => states.get(key))
  if (chosen.some(hasFailed) || a.runs.isError || b.runs.isError) return { kind: 'failed' }
  if (a.selected === undefined || b.selected === undefined) {
    return { kind: 'loading', label: 'Loading runs...' }
  }
  if (compared) return null
  const loaded = chosen.filter((state) => state?.samples !== undefined).length
  return { kind: 'loading', label: `Loading samples: ${loaded} of ${chosen.length} runs...` }
}
