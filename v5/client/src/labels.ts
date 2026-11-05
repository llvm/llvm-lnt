/**
 * How the UI names projects, test suites (AR22) and machines (AR23): by their label, which is the
 * display name a project, a suite or a machine has (D4, D5, D7), or else its name. A suite's full
 * label is its project's label and its own, separated by ` › `: it names the suite wherever its
 * project is not named beside it. Every label shown for a project, a suite or a machine comes from
 * here, whereas links, URLs, API requests and the text typed to confirm a deletion use the names.
 * Machines are ordered by label too (AR23), whereas projects and suites are in the order the API
 * lists them (AR22).
 */

import type { Schemas } from './api/client'
import type { ProjectName } from './api/suites'
import { findSuite, fullName, type SuiteRef } from './api/suite-ref'
import type { Option } from './components/select'
import { compareStrings } from './format'
import { labelOf } from './schema'

/** What a suite's labels are made of: its names and display names, and its project's. */
export type Labelled = { name: string; display_name: string | null; project: ProjectName }

/** The label of a project or a suite: its display name, or its name if it has none (AR22). */
export const projectLabel: (project: ProjectName) => string = labelOf

/** The label of a suite of its own, as under the heading of its project (AR22). */
export const suiteLabel: (suite: Pick<Labelled, 'name' | 'display_name'>) => string = labelOf

/** `parts` joined by ` › `, which unlike `/` is not mistaken for part of a display name (AR22). */
export function joinLabels(...parts: string[]): string {
  return parts.join(' › ')
}

/** The full label of `suite`: its project's label and its own, separated by ` › ` (AR22). */
export function fullLabel(suite: Labelled): string {
  return joinLabels(projectLabel(suite.project), suiteLabel(suite))
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

// Case-insensitive, in the order of the browser's language (AR23).
const collator = new Intl.Collator(undefined, { sensitivity: 'accent' })

/** AR23's order of two labels, with their names to break ties. */
export function compareLabels(
  aLabel: string,
  aName: string,
  bLabel: string,
  bName: string,
): number {
  return collator.compare(aLabel, bLabel) || compareStrings(aName, bName)
}

/** What a machine's label is made of: its name and its display name (AR23). */
export type MachineNames = Pick<Schemas['Machine'], 'name' | 'display_name'>

/** The label of a machine: its display name, or its name if it has none (AR23). */
export const machineLabel: (machine: MachineNames) => string = labelOf

/** AR23's order of machines: by label, then by name. */
export function compareMachines(a: MachineNames, b: MachineNames): number {
  return compareLabels(machineLabel(a), a.name, machineLabel(b), b.name)
}

/**
 * What a client-side filter over machines matches (AR23): a machine's label and its name, with a
 * NUL between them, which neither holds, so that a match never spans both.
 */
export function machineFilterText(name: string, label: string): string {
  return `${label}\u0000${name}`
}

/**
 * How a machine is named to assistive technology where its label alone may not tell it apart, as
 * its label is not unique (AR23): its label, followed by its name when the two differ.
 */
export function labelAndName(name: string, label: string): string {
  return label === name ? name : `${label}, ${name}`
}

/**
 * `suite` as an option of a dropdown picking a suite (AR22): its names, shown by its own label under
 * the heading of its project, and by its full label once picked. Its project's name tells its group
 * apart from that of another project with the same label.
 */
export function suiteOption(suite: Labelled): Option<string> {
  return {
    value: fullName({ project: suite.project.name, suite: suite.name }),
    label: suiteLabel(suite),
    selectedLabel: fullLabel(suite),
    section: { key: suite.project.name, heading: projectLabel(suite.project) },
  }
}

/** An entry of what an API key covers (I5): a whole project, with a null `suite`, or one suite. */
export type EntryRef = Schemas['RestrictionEntry']

/** An entry of what an API key covers, as the UI names it: a whole project, or a single suite. */
export interface NamedEntry {
  project: ProjectName
  /** Null for the whole project. */
  suite: Labelled | null
  /**
   * Where the entry's project stands among the projects listed, and where its suite stands among
   * the project's, -1 for the whole project: `Infinity` for one not listed.
   */
  place: readonly [project: number, suite: number]
}

/**
 * The entries `refs` list, named as `projects` has them, or by their names alone while `projects`
 * does not hold them, in AR22's order: by project, a whole project before the suites of that
 * project, then by suite, each in the order of `projects`. A project not listed comes after those
 * listed, and a suite not listed after its project's listed suites, by name.
 */
export function entriesNamed(
  projects: readonly (ProjectName & { suites: readonly Labelled[] })[] | undefined,
  refs: readonly EntryRef[],
): NamedEntry[] {
  return refs
    .map((ref): NamedEntry => {
      const index = projects?.findIndex((project) => project.name === ref.project) ?? -1
      const listed = projects?.[index]
      // What names the project, without its suites.
      const project = listed
        ? { name: listed.name, display_name: listed.display_name }
        : { name: ref.project, display_name: null }
      const projectPlace = listed ? index : Infinity
      if (ref.suite === null) return { project, suite: null, place: [projectPlace, -1] }
      const suiteIndex = listed?.suites.findIndex((suite) => suite.name === ref.suite) ?? -1
      const suite = listed?.suites[suiteIndex]
      return {
        project,
        suite: suite ?? { name: ref.suite, display_name: null, project },
        place: [projectPlace, suite ? suiteIndex : Infinity],
      }
    })
    .sort(compareEntries)
}

/**
 * How `entry` is shown (AR22): a whole project by its label followed by `(all)`, and a single suite
 * by its full label.
 */
export function entryLabel(entry: Pick<NamedEntry, 'project' | 'suite'>): string {
  return entry.suite === null ? `${projectLabel(entry.project)} (all)` : fullLabel(entry.suite)
}

/**
 * The order of two entries (AR22): by project, the whole project first, then by suite. Those not
 * listed come after those listed, by name, which AR22 leaves to the UI.
 */
function compareEntries(a: NamedEntry, b: NamedEntry): number {
  return (
    comparePlaces(a.place[0], a.project.name, b.place[0], b.project.name) ||
    comparePlaces(a.place[1], a.suite?.name ?? '', b.place[1], b.suite?.name ?? '')
  )
}

/** Two places in a list, `Infinity` for what it does not hold, which is then ordered by name. */
function comparePlaces(aPlace: number, aName: string, bPlace: number, bName: string): number {
  if (aPlace !== bPlace) return aPlace < bPlace ? -1 : 1
  return aPlace === Infinity ? compareStrings(aName, bName) : 0
}

/** Two lists of entries, each in AR22's order, compared entry by entry in that order. */
export function compareEntryLists(a: readonly NamedEntry[], b: readonly NamedEntry[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = compareEntries(a[i], b[i])
    if (order !== 0) return order
  }
  return a.length - b.length
}
