/**
 * How the UI names and orders test suites (AR22): by their label, which is the display name a suite
 * has (D4), or its name otherwise. Every label shown for a suite comes from here, whereas links,
 * URLs, API requests and the text typed to confirm a deletion use the name.
 */

import type { SuiteSchema } from './api/suites'
import { compareStrings } from './format'
import { labelOf } from './schema'

/** What a suite's label is made of. */
type Labelled = Pick<SuiteSchema, 'name' | 'display_name'>

/** The label of `suite`: its display name, or its name if it has none, as for a metric (AR6). */
export const suiteLabel: (suite: Labelled) => string = labelOf

/**
 * The suite named `name`, as `suites` has it, or by its name alone while they are not known, or if
 * they do not hold it (AR22).
 */
function suiteNamed(suites: readonly Labelled[] | undefined, name: string): Labelled {
  return suites?.find((suite) => suite.name === name) ?? { name, display_name: null }
}

/** The label of the suite named `name` among `suites` (see `suiteNamed`). */
export function suiteLabelOf(suites: readonly Labelled[] | undefined, name: string): string {
  return suiteLabel(suiteNamed(suites, name))
}

// Case-insensitive, in the order of the browser's language (AR22).
const collator = new Intl.Collator(undefined, { sensitivity: 'accent' })

/** AR22's order of suites: by label, compared as the browser's language does, then by name. */
export function compareSuites(a: Labelled, b: Labelled): number {
  return collator.compare(suiteLabel(a), suiteLabel(b)) || compareStrings(a.name, b.name)
}

/** `suite` as an option of a dropdown picking a suite: its name, shown by its label. */
export function suiteOption(suite: Labelled): { value: string; label: string } {
  return { value: suite.name, label: suiteLabel(suite) }
}

/**
 * The suites named `names`, as `suites` has them, or by their names alone while `suites` does not
 * hold them, in AR22's order: what an API key covers, say.
 */
export function suitesNamed(
  suites: readonly Labelled[] | undefined,
  names: readonly string[],
): Labelled[] {
  return names.map((name) => suiteNamed(suites, name)).sort(compareSuites)
}

/** Two lists of suites, each in AR22's order, compared suite by suite in that order. */
export function compareSuiteLists(a: readonly Labelled[], b: readonly Labelled[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = compareSuites(a[i], b[i])
    if (order !== 0) return order
  }
  return a.length - b.length
}
