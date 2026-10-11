/**
 * The schema editor's contents (AD3), and the schema document it sends to create a suite (E10).
 *
 * The name checks only spare the user a round trip: the server validates every schema in full, and
 * is authoritative. They mirror its rules (D4, D5; `suites/schema.py` on the server) and leave
 * everything else to it.
 */

import type { Schemas } from '../../api/client'
import type { SuiteSchema } from '../../api/suites'

export type ListName = 'metrics' | 'commit_fields' | 'machine_fields'
export type AttributeType = Schemas['AttributeType']

/** The three lists, in the order a schema has them. */
export const LISTS: readonly ListName[] = ['metrics', 'commit_fields', 'machine_fields']

export const TYPES: readonly AttributeType[] = ['real', 'integer', 'text', 'datetime']

const TEXT_KEYS = ['display_name', 'unit', 'unit_abbrev'] as const
type TextKey = (typeof TEXT_KEYS)[number]
type FlagKey = 'bigger_is_better' | 'searchable' | 'display'
export type PresentationKey = TextKey | FlagKey

export function isTextKey(key: PresentationKey): key is TextKey {
  return (TEXT_KEYS as readonly string[]).includes(key)
}

/**
 * Each presentation key's column header, in the viewer and the editor alike, and what the editor's
 * input of it is, in the input's accessible name.
 */
export const KEY_HEADERS: Record<PresentationKey, { header: string; label: string }> = {
  display_name: { header: 'Display Name', label: 'Display name' },
  unit: { header: 'Unit', label: 'Unit' },
  unit_abbrev: { header: 'Abbrev', label: 'Unit abbreviation' },
  bigger_is_better: { header: 'Bigger is Better', label: 'Bigger is better' },
  searchable: { header: 'Searchable', label: 'Searchable' },
  display: { header: 'Display', label: 'Display' },
}

interface ListInfo {
  /** The list's heading, in the viewer and the editor alike (AD2, AD3). */
  heading: string
  /** The accessible name of the list's table. */
  label: string
  /** What an entry of the list is called, in labels and messages. */
  noun: string
  /** The presentation keys the list accepts (D4), in the order the viewer shows them. */
  keys: readonly PresentationKey[]
  /** The type a new entry starts with: the commonest one. */
  type: AttributeType
  /**
   * The names D4's rule allows but the list does not: the built-in columns of the table its entries
   * become columns of (D5), and for a metric, the keys a test entry of a submission reserves (O1).
   */
  reserved: readonly string[]
}

export const LIST_INFO: Record<ListName, ListInfo> = {
  metrics: {
    heading: 'Metrics',
    label: 'Metrics',
    noun: 'metric',
    keys: ['display_name', 'unit', 'unit_abbrev', 'bigger_is_better'],
    type: 'real',
    reserved: ['id', 'machine_id', 'name', 'profile', 'run_id', 'test_id'],
  },
  commit_fields: {
    heading: 'Commit Fields',
    label: 'Commit fields',
    noun: 'commit field',
    keys: ['display_name', 'searchable', 'display'],
    type: 'text',
    reserved: ['commit', 'id', 'ordinal', 'tag'],
  },
  machine_fields: {
    heading: 'Machine Fields',
    label: 'Machine fields',
    noun: 'machine field',
    keys: ['display_name', 'searchable'],
    type: 'text',
    reserved: ['id', 'name', 'tracked'],
  },
}

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
  searchable: boolean
  display: boolean
}

export type Draft = Record<ListName, DraftEntry[]>

export const EMPTY_DRAFT: Draft = {
  metrics: [],
  commit_fields: [],
  machine_fields: [],
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
    searchable: entry.searchable ?? false,
    display: entry.display ?? false,
  }
}

function entriesOf(schema: SuiteSchema, toDraft: (entry: AnyEntry) => DraftEntry): Draft {
  return {
    metrics: schema.metrics.map(toDraft),
    commit_fields: schema.commit_fields.map(toDraft),
    machine_fields: schema.machine_fields.map(toDraft),
  }
}

/** The entries of `schema`, as entries to add: to create a suite from a copy of it (AD3). */
export function copyOf(schema: SuiteSchema): Draft {
  return entriesOf(schema, (entry) => draftEntry(entry, null))
}

/** The entries of `schema`, as they are stored: to edit its schema (AD3). */
export function draftOf(schema: SuiteSchema): Draft {
  return entriesOf(schema, (entry) => draftEntry(entry, entry))
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
 * `draft` with the entry `id` of `list` changed. Only a `text` entry can be searchable or the
 * display field (D3), so changing the type away from `text` clears both. At most one commit field
 * is the display field (D4), so making one the display field makes the others not.
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
      return changed.type === 'text' ? changed : { ...changed, searchable: false, display: false }
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

// D4's rule for every name in a schema, each of which becomes a namespace or a column.
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/
const NAME_MAX_LENGTH = 63

/** Why `name` breaks D4's rule for names, if it does. */
function ruleProblem(name: string): string | undefined {
  if (!NAME_PATTERN.test(name)) {
    return 'A name has only lowercase letters, digits and underscores, and starts with a letter.'
  }
  if (name.length > NAME_MAX_LENGTH) return `A name is at most ${NAME_MAX_LENGTH} characters long.`
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
      ruleProblem(name) ??
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

// D4: the names no suite can have, since no namespace can be created under them.
const RESERVED_SUITE_NAMES = ['information_schema', 'public']
const RESERVED_SUITE_PREFIX = 'pg_'

/** Why `name` cannot name a new suite, if it cannot. An empty name is not refused here. */
export function suiteNameProblem(name: string, existing: readonly string[]): string | undefined {
  if (name === '') return undefined
  const problem = ruleProblem(name)
  if (problem !== undefined) return problem
  if (RESERVED_SUITE_NAMES.includes(name) || name.startsWith(RESERVED_SUITE_PREFIX)) {
    return (
      `A suite cannot be named ${quotedList(RESERVED_SUITE_NAMES)}, ` +
      `or start with '${RESERVED_SUITE_PREFIX}'.`
    )
  }
  if (existing.includes(name)) return `There is already a suite named '${name}'.`
  return undefined
}

/**
 * Why `draft` cannot be sent, if it cannot: some entry has a name that `nameProblems` refuses, or
 * no name yet.
 */
export function draftProblem(draft: Draft): string | undefined {
  if (LISTS.some((list) => nameProblems(list, draft[list]).size > 0)) {
    return 'Correct the names marked in red first.'
  }
  if (LISTS.some((list) => draft[list].some((entry) => entry.name === ''))) {
    return 'Give every new entry a name first.'
  }
  return undefined
}

/**
 * The value of `key` the entry is to have. Text is sent without surrounding whitespace, and an
 * input left empty is null (AD3).
 */
function valueOf(entry: DraftEntry, key: PresentationKey): string | boolean | null {
  const value = entry[key]
  if (typeof value === 'boolean') return value
  const text = value.trim()
  return text === '' ? null : text
}

/** The entry as a schema document spells it (D4), with exactly the keys its list accepts. */
function entryOf(list: ListName, entry: DraftEntry) {
  const keys = LIST_INFO[list].keys.map((key) => [key, valueOf(entry, key)])
  return { name: entry.name, type: entry.type, ...Object.fromEntries(keys) }
}

/** The body of `POST /api/suites` creating the suite `name` with `draft`'s entries (E10). */
export function schemaOf(name: string, draft: Draft): Schemas['SuiteSchemaInput'] {
  const lists = LISTS.map((list) => [list, draft[list].map((entry) => entryOf(list, entry))])
  return { name, ...Object.fromEntries(lists) } as Schemas['SuiteSchemaInput']
}

/** The existing entries the user removed, with their list. */
export function removedEntries(draft: Draft): { list: ListName; name: string }[] {
  return LISTS.flatMap((list) =>
    draft[list].filter((entry) => entry.removed).map((entry) => ({ list, name: entry.name })),
  )
}

/**
 * Whether the user changed the key `key` of the existing entry `entry`, stored as `original`: a flag that differs from
 * the stored one, or a text that differs both as typed and as it would be sent, so that neither
 * text left untouched (a stored " Foo " shows as typed) nor text changed only around its ends
 * counts.
 */
function isChanged(entry: DraftEntry, original: AnyEntry, key: PresentationKey): boolean {
  const stored = original[key] ?? null
  if (!isTextKey(key)) return entry[key] !== stored
  return entry[key] !== (stored ?? '') && valueOf(entry, key) !== stored
}

/**
 * The body of `PATCH /api/suites/{name}/schema` making the changes in `draft` (E10): an entry added
 * in full, an existing one updated with only the keys the user changed, and a removed one by its
 * name. It says nothing of what the user left alone, so that saving does not undo changes others
 * made since the editor opened (AD3). Empty when the user changed nothing.
 */
export function patchOf(draft: Draft): Schemas['SchemaPatch'] {
  const patch: Record<string, Record<string, unknown[]>> = {}
  for (const list of LISTS) {
    const add = []
    const update = []
    const remove = []
    for (const entry of draft[list]) {
      const { original } = entry
      if (original === null) add.push(entryOf(list, entry))
      else if (entry.removed) remove.push(entry.name)
      else {
        const changed = LIST_INFO[list].keys.filter((key) => isChanged(entry, original, key))
        if (changed.length > 0) {
          const values = changed.map((key) => [key, valueOf(entry, key)])
          update.push({ name: entry.name, ...Object.fromEntries(values) })
        }
      }
    }
    const operations = Object.entries({ add, update, remove }).filter(([, items]) => items.length)
    if (operations.length > 0) patch[list] = Object.fromEntries(operations)
  }
  return patch as Schemas['SchemaPatch']
}
