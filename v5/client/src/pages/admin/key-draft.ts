/** The model of the key form (AD1), which creates a key or changes one. */

import { useMemo } from 'react'
import { fullName } from '../../api/suite-ref'
import { refOf, useProjects, type Project } from '../../api/suites'
import { RESTRICTABLE_SCOPES, type KeyScope } from '../../auth/scope'
import {
  entryLabel,
  fullLabel,
  projectLabel,
  suiteLabel,
  type EntryRef,
  type NamedEntry,
} from '../../labels'
import type { TreeParent } from '../../components/select'

/**
 * What the key form holds (AD1): the key's name and scope, whether "Only these:" is chosen over
 * "Everything", and what is checked under it: projects by their names, and suites by their full
 * names.
 */
export interface KeyDraft {
  name: string
  scope: KeyScope
  restrict: boolean
  checked: string[]
}

/** The form's projects, and the tree of them and their suites it checks what a key covers in. */
export function useCoversTree() {
  const projects = useProjects()
  const covers = useMemo(() => coversTree(projects.data ?? []), [projects.data])
  return { projects, ...covers }
}

export type CoversTree = ReturnType<typeof useCoversTree>

/**
 * What `draft` restricts the key to, if anything: only what is still listed, should something
 * checked have gone since. A key whose scope cannot be restricted is instance-wide.
 */
export function restrictionOf(draft: KeyDraft, tree: CoversTree): EntryRef[] | null {
  if (!draft.restrict || !RESTRICTABLE_SCOPES.includes(draft.scope)) return null
  return draft.checked.flatMap((value) => tree.entries.get(value) ?? [])
}

/**
 * What a key restricted to `entries` (see `entriesNamed`) covers, as AR22 shows it: `All` for an
 * instance-wide key, its entries by their labels, or `Nothing` once they have all been deleted.
 */
export function coversText(entries: readonly NamedEntry[] | null): string {
  if (entries === null) return 'All'
  if (entries.length === 0) return 'Nothing'
  return entries.map(entryLabel).join(', ')
}

/**
 * The tree of `projects` and their suites the key form checks what a key covers in (AD1): every
 * project, those without suites included, saying so, with its suites below it, each by its own
 * label, and by its full label to assistive technology. Each option's value stands for an entry of
 * the key, which `entries` maps it to.
 */
function coversTree(projects: readonly Project[]) {
  const entries = new Map<string, EntryRef>()
  const tree = projects.map((project): TreeParent<string> => {
    const label = projectLabel(project)
    entries.set(project.name, { project: project.name, suite: null })
    return {
      value: project.name,
      label,
      summary: entryLabel({ project, suite: null }),
      note: project.suites.length === 0 ? '(no suites)' : undefined,
      children: project.suites.map((suite) => {
        const value = fullName(refOf(suite))
        entries.set(value, { project: project.name, suite: suite.name })
        return { value, label: suiteLabel(suite), name: fullLabel(suite) }
      }),
    }
  })
  return { tree, entries }
}

