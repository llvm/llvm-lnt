/** How far the Compare page is from a comparison (CP6): what it still needs, and what it loads. */

import type { SampleState } from '../../api/runs'
import { plural } from '../../format'
import type { Side } from './use-side'

/**
 * The runs `side` has selected, by `runRefKey`, in the order they were submitted, once the
 * selection is known: then they are those it wants the samples of.
 */
export function chosenRuns(side: Side): string[] {
  return side.selected === undefined ? [] : side.wanted
}

/** Whether the samples of a run could not be loaded. */
function hasFailed(state: SampleState | undefined): state is SampleState {
  return state?.error != null
}

interface Progress {
  /** How many runs the two sides select, each once, even when both sides select it. */
  chosen: number
  /** How many of those have their samples. */
  loaded: number
  /** Those whose samples could not be loaded. */
  failed: SampleState[]
  /** Those of the shadow's runs that are not the sides', whose samples could not be loaded. */
  shadowFailed: SampleState[]
}

/** How far the samples of the runs `a`, `b` and `shadow` select are loaded, by `states`. */
export function loadProgress(
  a: Side,
  b: Side,
  shadow: Side,
  states: ReadonlyMap<string, SampleState>,
): Progress {
  const main = new Set([...chosenRuns(a), ...chosenRuns(b)])
  const chosen = [...main].map((key) => states.get(key))
  return {
    chosen: chosen.length,
    loaded: chosen.filter((state) => state?.samples !== undefined).length,
    failed: chosen.filter(hasFailed),
    // The sides' failures are reported already.
    shadowFailed: chosenRuns(shadow)
      .filter((key) => !main.has(key))
      .map((key) => states.get(key))
      .filter(hasFailed),
  }
}

/** `a run`, or `3 runs`. */
export function runCount(count: number): string {
  return count === 1 ? 'a run' : plural(count, 'run')
}

/** What the comparison still needs before it can be computed, if anything (CP6 "Empty states"). */
export function missingInput(a: Side, b: Side, offered: number, chosen: boolean): string | null {
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
