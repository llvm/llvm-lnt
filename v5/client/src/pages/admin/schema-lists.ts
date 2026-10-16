/**
 * What is true of a suite schema's three lists (D4), whether a page views them or edits them: what
 * each is called, which keys it accepts, and which names it reserves.
 */

import type { Schemas } from '../../api/client'

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
   * The names D4's rule allows but the list does not: the built-in columns of the tables its entries
   * become columns of (D5).
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
    reserved: ['id', 'machine_id', 'run_id', 'test_id'],
  },
  commit_fields: {
    heading: 'Commit Fields',
    label: 'Commit fields',
    noun: 'commit field',
    keys: ['display_name', 'searchable', 'display'],
    type: 'text',
    reserved: ['commit', 'delete_after_inactive_days', 'first_seen_at', 'id', 'ordinal', 'tag'],
  },
  machine_fields: {
    heading: 'Machine Fields',
    label: 'Machine fields',
    noun: 'machine field',
    keys: ['display_name', 'searchable'],
    type: 'text',
    reserved: ['delete_after_inactive_days', 'first_seen_at', 'id', 'name', 'tracked'],
  },
}
