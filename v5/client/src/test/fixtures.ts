/**
 * Builders of the API's objects for tests, with defaults, so that a test only spells out what it is
 * about.
 */

import type { Schemas } from '../api/client'
import type { SuiteSchema } from '../api/suites'
import type { Commit } from '../schema'

/** A suite like libcxx: a display field, labelled and unlabelled fields, and a non-text one. */
export const SUITE: SuiteSchema = {
  name: 'libcxx',
  metrics: [
    {
      name: 'execution_time',
      type: 'real',
      display_name: 'Execution Time',
      unit: 'seconds',
      unit_abbrev: 's',
      bigger_is_better: false,
    },
  ],
  machine_fields: [
    { name: 'hardware', type: 'text', display_name: 'Hardware', searchable: true },
    { name: 'os', type: 'text', display_name: null, searchable: true },
    { name: 'core_count', type: 'integer', display_name: 'Cores', searchable: false },
  ],
  commit_fields: [
    { name: 'svn_revision', type: 'text', display_name: null, searchable: true, display: true },
    { name: 'commit_info', type: 'text', display_name: null, searchable: false, display: false },
  ],
}

/** A suite with no fields at all, and so no display field. */
export const BARE_SUITE: SuiteSchema = {
  name: 'nts',
  metrics: [],
  machine_fields: [],
  commit_fields: [],
}

export function machine(
  name: string,
  overrides: Partial<Schemas['Machine']> = {},
): Schemas['Machine'] {
  return {
    name,
    tracked: true,
    fields: { hardware: null, os: null, core_count: null },
    last_run_at: null,
    ...overrides,
  }
}

export function commit(value: string, overrides: Partial<Commit> = {}): Commit {
  return {
    value,
    ordinal: null,
    tag: null,
    fields: { svn_revision: null, commit_info: null },
    ...overrides,
  }
}

/** A UUID made of `hex` repeated, so that its shortened form is easy to spell. */
export function uuidOf(hex: string): string {
  const h = hex.repeat(32).slice(0, 32)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** A run whose UUID is `hex` repeated (see `uuidOf`). */
export function run(hex: string, overrides: Partial<Schemas['Run']> = {}): Schemas['Run'] {
  return {
    uuid: uuidOf(hex),
    machine: 'linux-x86_64',
    commit: 'abc123',
    submitted_at: '2026-08-25T14:22:41Z',
    ...overrides,
  }
}

/** A regression in a list (E8), whose UUID is `hex` repeated (see `uuidOf`). */
export function regression(
  hex: string,
  overrides: Partial<Schemas['Regression']> = {},
): Schemas['Regression'] {
  return {
    uuid: uuidOf(hex),
    title: 'find_if slowdown',
    bug: null,
    state: 'detected',
    commit: null,
    created_at: '2026-08-31T15:03:36Z',
    machine_count: 0,
    test_count: 0,
    ...overrides,
  }
}

/** I2's cursor envelope. */
export function cursorPage<Item>(items: Item[], next: string | null = null) {
  return { items, cursor: { next, previous: null } }
}
