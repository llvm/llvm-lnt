/**
 * How the UI names and orders projects and test suites (AR22): by their label, which is the
 * display name a project or a suite has (D4, D7), or its name otherwise. A suite's full label is its
 * project's label and its own, separated by a `/`: it names the suite wherever its project is not
 * named beside it. Every label shown for a project or a suite comes from here, whereas links, URLs,
 * API requests and the text typed to confirm a deletion use the names.
 */

import type { ProjectName } from './api/suites'
import { findSuite, fullName, type SuiteRef } from './api/suite-ref'
import { compareStrings } from './format'
import { labelOf } from './schema'

/** What a suite's labels are made of: its names and display names, and its project's. */
export type Labelled = { name: string; display_name: string | null; project: ProjectName }

/** The label of a project or a suite: its display name, or its name if it has none (AR22). */
export const projectLabel: (project: ProjectName) => string = labelOf

/** The label of a suite of its own, as under the heading of its project (AR22). */
export const suiteLabel: (suite: Pick<Labelled, 'name' | 'display_name'>) => string = labelOf

/** The full label of `suite`: its project's label and its own, separated by a `/` (AR22). */
export function fullLabel(suite: Labelled): string {
  return `${projectLabel(suite.project)}/${suiteLabel(suite)}`
}

/**
 * The suite `ref` names, as `suites` has it, or by its names alone while they are not known, or if
 * they do not hold it (AR22).
 */
export function suiteNamed(suites: readonly Labelled[] | undefined, ref: SuiteRef): Labelled {
  return (
    findSuite(suites, ref) ?? {
      name: ref.suite,
      display_name: null,
      project: { name: ref.project, display_name: null },
    }
  )
}

/**
 * The project `name` names, as `projects` has it, or by its name alone while they are not known, or
 * if they do not hold it (AR22).
 */
export function projectNamed(projects: readonly ProjectName[] | undefined, name: string): ProjectName {
  return projects?.find((project) => project.name === name) ?? { name, display_name: null }
}

/** The full label of the suite `ref` names among `suites` (see `suiteNamed`). */
export function fullLabelOf(suites: readonly Labelled[] | undefined, ref: SuiteRef): string {
  return fullLabel(suiteNamed(suites, ref))
}

// Case-insensitive, in the order of the browser's language (AR22).
const collator = new Intl.Collator(undefined, { sensitivity: 'accent' })

/** AR22's order of two labels, with their names to break ties. */
function compareLabelled(
  a: { name: string; display_name: string | null },
  b: { name: string; display_name: string | null },
): number {
  return collator.compare(labelOf(a), labelOf(b)) || compareStrings(a.name, b.name)
}

/** AR22's order of projects: by label, then by name. */
export const compareProjects: (a: ProjectName, b: ProjectName) => number = compareLabelled

/**
 * AR22's order of suites, a level at a time: by their projects' order, then by their own labels,
 * then by their names -- rather than by their full labels, which could interleave the suites of two
 * projects whose labels start alike.
 */
export function compareSuites(a: Labelled, b: Labelled): number {
  return compareProjects(a.project, b.project) || compareLabelled(a, b)
}

/** `suite` as an option of a dropdown picking a suite: its names, shown by its full label. */
export function suiteOption(suite: Labelled): { value: string; label: string } {
  return {
    value: fullName({ project: suite.project.name, suite: suite.name }),
    label: fullLabel(suite),
  }
}

/**
 * The suites `refs` name, as `suites` has them, or by their names alone while `suites` does not
 * hold them, in AR22's order: what an API key covers, say.
 */
export function suitesNamed(
  suites: readonly Labelled[] | undefined,
  refs: readonly SuiteRef[],
): Labelled[] {
  return refs.map((ref) => suiteNamed(suites, ref)).sort(compareSuites)
}

/** Two lists of suites, each in AR22's order, compared suite by suite in that order. */
export function compareSuiteLists(a: readonly Labelled[], b: readonly Labelled[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = compareSuites(a[i], b[i])
    if (order !== 0) return order
  }
  return a.length - b.length
}
