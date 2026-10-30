/**
 * The schema editor's model (TS7): what the editor holds before it is sent -- its draft -- and what
 * it sends, a whole schema to create a suite, or the changes to an existing one's (E10).
 *
 * The checks of names and of URL templates only spare the user a round trip: the server validates
 * every schema in full, and is authoritative. They mirror its rules (D4, D5; `suites/schema.py` on
 * the server) and leave everything else to it. The check of URL templates (`templateProblem`) is
 * shared with the links built from them, which do not trust the server's alone (AR20).
 */

import type { Schemas } from '../../../api/client'
import type { SuiteSchema } from '../../../api/suites'
import { templateProblem, type Repository } from '../../../repository'
import {
  flagAllowed,
  isTextKey,
  LIST_INFO,
  LISTS,
  REPOSITORY_KEYS,
  URL_KEYS,
  type AttributeType,
  type ListName,
  type PresentationKey,
  type RepositoryKey,
} from './schema-lists'

/**
 * An entry as the editor holds it: every key any list accepts, whichever its list, so that one
 * shape serves the three. A text key holds what its input shows.
 */
export interface DraftEntry {
  /** Identifies the entry's row, whatever its name. */
  id: number
  /** The entry as stored, if it existed when the editor opened; null for one added since. */
  original: AnyEntry | null
  /** An existing entry the user removed, which saving removes, unless the user undoes it. */
  removed: boolean
  name: string
  type: AttributeType
  display_name: string
  unit: string
  unit_abbrev: string
  bigger_is_better: boolean
  dashboard: boolean
  searchable: boolean
  display: boolean
  listed: boolean
}

/** The repository as the editor holds it: what each input shows. */
export interface DraftRepository extends Record<RepositoryKey, string> {
  /** The repository as stored, when editing a suite's schema; null when creating a suite. */
  original: Repository | null
}

export type Draft = Record<ListName, DraftEntry[]> & { repository: DraftRepository }

export const EMPTY_DRAFT: Draft = {
  metrics: [],
  commit_fields: [],
  machine_fields: [],
  repository: { original: null, label: '', commit_url: '', range_url: '' },
}

/** An entry of any list, as a schema has it: the keys of the other lists are absent. */
export type AnyEntry = Pick<DraftEntry, 'name' | 'type'> &
  Partial<Schemas['Metric'] & Schemas['CommitField'] & Schemas['MachineField']>

let lastId = 0

function draftEntry(entry: AnyEntry, original: AnyEntry | null): DraftEntry {
  return {
    id: ++lastId,
    original,
    removed: false,
    name: entry.name,
    type: entry.type,
    display_name: entry.display_name ?? '',
    unit: entry.unit ?? '',
    unit_abbrev: entry.unit_abbrev ?? '',
    bigger_is_better: entry.bigger_is_better ?? false,
    dashboard: entry.dashboard ?? false,
    searchable: entry.searchable ?? false,
    display: entry.display ?? false,
    listed: entry.listed ?? false,
  }
}

function draftOfSchema(schema: SuiteSchema, stored: boolean): Draft {
  const toDraft = (entry: AnyEntry) => draftEntry(entry, stored ? entry : null)
  const { repository } = schema
  return {
    metrics: schema.metrics.map(toDraft),
    commit_fields: schema.commit_fields.map(toDraft),
    machine_fields: schema.machine_fields.map(toDraft),
    repository: {
      original: stored ? repository : null,
      label: repository.label ?? '',
      commit_url: repository.commit_url ?? '',
      range_url: repository.range_url ?? '',
    },
  }
}

/**
 * The entries and the repository of `schema`, as new ones: to create a suite from a copy of it
 * (TS7).
 */
export function copyOf(schema: SuiteSchema): Draft {
  return draftOfSchema(schema, false)
}

/** The entries and the repository of `schema`, as they are stored: to edit its schema (TS7). */
export function draftOf(schema: SuiteSchema): Draft {
  return draftOfSchema(schema, true)
}

/** A new, unnamed entry of `list`, for `addEntry`. */
export function newEntry(list: ListName): DraftEntry {
  return draftEntry({ name: '', type: LIST_INFO[list].type }, null)
}

/** `draft` with `entry` at the end of `list`. */
export function addEntry(draft: Draft, list: ListName, entry: DraftEntry): Draft {
  return { ...draft, [list]: [...draft[list], entry] }
}

/**
 * `draft` with the entry `id` of `list` changed. Some flags only suit some types (D3), so changing
 * the type to another clears them. At most one commit field is the display field (D4), so making
 * one the display field makes the others not.
 */
export function changeEntry(
  draft: Draft,
  list: ListName,
  id: number,
  changes: Partial<Omit<DraftEntry, 'id'>>,
): Draft {
  return {
    ...draft,
    [list]: draft[list].map((entry) => {
      if (entry.id !== id) return changes.display === true ? { ...entry, display: false } : entry
      const changed = { ...entry, ...changes }
      for (const key of LIST_INFO[list].keys) {
        if (!isTextKey(key) && !flagAllowed(key, changed.type)) changed[key] = false
      }
      return changed
    }),
  }
}

/**
 * `draft` without the entry `id` of `list`: gone, if it was added in this edit, and marked removed
 * otherwise, which `restoreEntry` undoes.
 */
export function removeEntry(draft: Draft, list: ListName, id: number): Draft {
  return {
    ...draft,
    [list]: draft[list].flatMap((entry) => {
      if (entry.id !== id) return [entry]
      return entry.original === null ? [] : [{ ...entry, removed: true }]
    }),
  }
}

export function restoreEntry(draft: Draft, list: ListName, id: number): Draft {
  return {
    ...draft,
    [list]: draft[list].map((entry) => (entry.id === id ? { ...entry, removed: false } : entry)),
  }
}

/** `draft` with the repository's `key` showing `text`. */
export function changeRepository(draft: Draft, key: RepositoryKey, text: string): Draft {
  return { ...draft, repository: { ...draft.repository, [key]: text } }
}

// D4's rules for names. An entry's name becomes a column: it may have capitals, and its case is
// significant. A suite's names nothing in the database, and is lowercase only.
const NAME_RULES = {
  suite: {
    pattern: /^[a-z0-9][a-z0-9_-]*$/,
    problem:
      "A name has only lowercase letters, digits, '-' and '_', and starts with a letter or a digit.",
    maxLength: 64,
  },
  entry: {
    pattern: /^[A-Za-z][A-Za-z0-9_]*$/,
    problem: 'A name has only letters, digits and underscores, and starts with a letter.',
    maxLength: 63,
  },
}

/** Why `name` breaks D4's rule for the names of suites, or of entries, if it does. */
function ruleProblem(name: string, of: keyof typeof NAME_RULES): string | undefined {
  const { pattern, problem, maxLength } = NAME_RULES[of]
  if (!pattern.test(name)) return problem
  if (name.length > maxLength) return `A name is at most ${maxLength} characters long.`
  return undefined
}

/** `'a', 'b' or 'c'`. */
function quotedList(names: readonly string[]): string {
  const quoted = names.map((name) => `'${name}'`)
  return quoted.length === 1 ? quoted[0] : `${quoted.slice(0, -1).join(', ')} or ${quoted.at(-1)}`
}

/**
 * Why each entry of `list` among `entries` cannot have its name, by the entry's `id`, for those
 * that cannot: D4's rule, the names the list reserves, or another entry of the list with the same
 * name. Only an entry added in this edit can be refused, since an existing one's name cannot be
 * changed. A removed entry's name stays taken until the edit is saved: removing an entry and adding
 * one of the same name would be two operations on one name, which D2 does not allow. An empty name
 * is not refused here: nothing has been typed yet (see `draftProblem`).
 */
export function nameProblems(list: ListName, entries: readonly DraftEntry[]): Map<number, string> {
  const { noun, reserved } = LIST_INFO[list]
  const problems = new Map<number, string>()
  for (const entry of entries) {
    const { id, name } = entry
    if (entry.original !== null || name === '') continue
    const others = entries.filter((other) => other !== entry && other.name === name)
    const problem =
      ruleProblem(name, 'entry') ??
      (reserved.includes(name)
        ? `A ${noun} cannot be named ${quotedList(reserved)}.`
        : undefined) ??
      (others.some((other) => other.removed)
        ? `The ${noun} '${name}' is removed in this edit, so it cannot be added again until the ` +
          'edit is saved.'
        : undefined) ??
      (others.length > 0 ? `Another ${noun} is named '${name}'.` : undefined)
    if (problem !== undefined) problems.set(id, problem)
  }
  return problems
}

/** Why `name` cannot name a new suite, if it cannot. An empty name is not refused here. */
export function suiteNameProblem(name: string, existing: readonly string[]): string | undefined {
  if (name === '') return undefined
  const problem = ruleProblem(name, 'suite')
  if (problem !== undefined) return problem
  if (existing.includes(name)) return `There is already a suite named '${name}'.`
  return undefined
}

/**
 * Why each URL of `repository` cannot be sent, by its key, for those that cannot. A URL left as it
 * is stored is not checked, so that a schema stored with one the editor refuses can still be saved;
 * nor is one left empty, which is sent as null.
 */
export function repositoryProblems(repository: DraftRepository): Map<RepositoryKey, string> {
  const { original } = repository
  const problems = new Map<RepositoryKey, string>()
  for (const key of URL_KEYS) {
    const value = sent(repository[key])
    if (value === null || (original !== null && !isChanged(repository[key], original[key]))) {
      continue
    }
    const problem = templateProblem(key, value)
    if (problem !== undefined) problems.set(key, problem)
  }
  return problems
}

/**
 * Why `draft` cannot be sent, if it cannot: some entry has a name that `nameProblems` refuses, or
 * no name yet, or the repository has a URL that `repositoryProblems` refuses.
 */
export function draftProblem(draft: Draft): string | undefined {
  if (LISTS.some((list) => nameProblems(list, draft[list]).size > 0)) {
    return 'Correct the names marked in red first.'
  }
  if (LISTS.some((list) => draft[list].some((entry) => entry.name === ''))) {
    return 'Give every new entry a name first.'
  }
  if (repositoryProblems(draft.repository).size > 0) {
    return 'Correct the repository URLs marked in red first.'
  }
  return undefined
}

/** Text as it is sent: without surrounding whitespace, and null if that leaves nothing (TS7). */
function sent(text: string): string | null {
  const trimmed = text.trim()
  return trimmed === '' ? null : trimmed
}

/** The value of `key` the entry is to have: a flag as it is, and text as `sent` sends it. */
function valueOf(entry: DraftEntry, key: PresentationKey): string | boolean | null {
  const value = entry[key]
  return typeof value === 'boolean' ? value : sent(value)
}

/** The entry as a schema document spells it (D4), with exactly the keys its list accepts. */
function entryOf(list: ListName, entry: DraftEntry) {
  const keys = LIST_INFO[list].keys.map((key) => [key, valueOf(entry, key)])
  return { name: entry.name, type: entry.type, ...Object.fromEntries(keys) }
}

/**
 * The body of `POST /api/suites` creating the suite `name`, with the display name its input shows
 * as `displayName`, and `draft`'s entries and repository (E10).
 */
export function schemaOf(
  name: string,
  displayName: string,
  draft: Draft,
): Schemas['SuiteSchemaInput'] {
  const lists = LISTS.map((list) => [list, draft[list].map((entry) => entryOf(list, entry))])
  const repository = REPOSITORY_KEYS.map((key) => [key, sent(draft.repository[key])])
  return {
    name,
    display_name: sent(displayName),
    ...Object.fromEntries(lists),
    repository: Object.fromEntries(repository),
  } as Schemas['SuiteSchemaInput']
}

/** Whether `text`, as an input of the editor shows it, sets a value: what it sends is not null. */
export function isSet(text: string): boolean {
  return sent(text) !== null
}

/** Whether a suite's `draft` holds anything the user entered: an entry, or a repository value. */
export function hasContent(draft: Draft): boolean {
  return (
    LISTS.some((list) => draft[list].length > 0) ||
    REPOSITORY_KEYS.some((key) => sent(draft.repository[key]) !== null)
  )
}

/** The existing entries the user removed, with their list. */
export function removedEntries(draft: Draft): { list: ListName; name: string }[] {
  return LISTS.flatMap((list) =>
    draft[list].filter((entry) => entry.removed).map((entry) => ({ list, name: entry.name })),
  )
}

/**
 * Whether the user changed the text `text` of a value stored as `stored`: whether it differs both as
 * typed and as it would be sent, so that neither text left untouched (a stored " Foo " shows as
 * typed) nor text changed only around its ends counts.
 */
function isChanged(text: string, stored: string | null): boolean {
  return text !== (stored ?? '') && sent(text) !== stored
}

/**
 * Whether the user changed the key `key` of the existing entry `entry`, stored as `original`: a
 * flag that differs from the stored one, or a text that `isChanged`.
 */
function isEntryChanged(entry: DraftEntry, original: AnyEntry, key: PresentationKey): boolean {
  const stored = original[key] ?? null
  if (!isTextKey(key)) return entry[key] !== stored
  return isChanged(entry[key], stored as string | null)
}

/**
 * The part of `PATCH /api/suites/{name}/schema` changing the suite's display name, stored as
 * `stored`, to what its input shows, `text`: nothing unless the user changed it (TS7).
 */
export function displayNameChange(text: string, stored: string | null): Schemas['SchemaPatch'] {
  return isChanged(text, stored) ? { display_name: sent(text) } : {}
}

/**
 * The body of `PATCH /api/suites/{name}/schema` making the changes in `draft` (E10): an entry added
 * in full, an existing one updated with only the keys the user changed, a removed one by its name,
 * and the repository with only the keys the user changed. It says nothing of what the user left
 * alone, so that saving does not undo changes others made since the editor opened (TS7). Empty
 * when the user changed nothing.
 */
export function patchOf(draft: Draft): Schemas['SchemaPatch'] {
  const patch: Record<string, Record<string, unknown>> = {}
  for (const list of LISTS) {
    const add = []
    const update = []
    const remove = []
    for (const entry of draft[list]) {
      const { original } = entry
      if (original === null) add.push(entryOf(list, entry))
      else if (entry.removed) remove.push(entry.name)
      else {
        const changed = LIST_INFO[list].keys.filter((key) => isEntryChanged(entry, original, key))
        if (changed.length > 0) {
          const values = changed.map((key) => [key, valueOf(entry, key)])
          update.push({ name: entry.name, ...Object.fromEntries(values) })
        }
      }
    }
    const operations = Object.entries({ add, update, remove }).filter(([, items]) => items.length)
    if (operations.length > 0) patch[list] = Object.fromEntries(operations)
  }
  const { repository } = draft
  const { original } = repository
  if (original !== null) {
    const changed = REPOSITORY_KEYS.filter((key) => isChanged(repository[key], original[key]))
    if (changed.length > 0) {
      patch.repository = Object.fromEntries(changed.map((key) => [key, sent(repository[key])]))
    }
  }
  return patch as Schemas['SchemaPatch']
}
