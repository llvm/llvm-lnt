import { describe, expect, it } from 'vitest'
import { SUITE } from '../../test/fixtures'
import {
  addEntry,
  changeEntry,
  draftOf,
  EMPTY_DRAFT,
  hasBlankName,
  hasNameProblem,
  newEntry,
  nameProblems,
  removeEntry,
  schemaOf,
  suiteNameProblem,
  type Draft,
  type ListName,
} from './schema-draft'

/** `draft` with a new entry of `list` named `name`, and that entry. */
function withEntry(draft: Draft, list: ListName, name: string) {
  const entry = { ...newEntry(list), name }
  return { draft: addEntry(draft, list, entry), entry }
}

/** Why `entry`, of `list` in `draft`, cannot have its name, if it cannot. */
function entryNameProblem(draft: Draft, list: ListName, entry: { id: number }) {
  return nameProblems(list, draft[list]).get(entry.id)
}

/** Why a lone entry of `list` named `name` is refused, if it is. */
function problemOf(list: ListName, name: string) {
  const { draft, entry } = withEntry(EMPTY_DRAFT, list, name)
  return entryNameProblem(draft, list, entry)
}

describe('nameProblems', () => {
  it("accepts every name D4's rule allows", () => {
    for (const name of ['a', 'execution_time', 'x86_64', 'order', 'user', 'a'.repeat(63)]) {
      expect(problemOf('metrics', name)).toBeUndefined()
    }
  })

  it("refuses a name D4's rule does not allow", () => {
    for (const name of ['Execution', '1st', '_x', 'with space', 'dash-ed', ' a', 'é']) {
      expect(problemOf('metrics', name)).toMatch(/lowercase letters, digits and underscores/)
    }
    expect(problemOf('metrics', 'a'.repeat(64))).toBe('A name is at most 63 characters long.')
  })

  it('refuses the names each list reserves, and only in that list', () => {
    expect(problemOf('metrics', 'run_id')).toBe(
      "A metric cannot be named 'id', 'machine_id', 'name', 'profile', 'run_id' or 'test_id'.",
    )
    for (const name of ['id', 'machine_id', 'name', 'profile', 'test_id']) {
      expect(problemOf('metrics', name)).toBeDefined()
    }
    for (const name of ['id', 'commit', 'ordinal', 'tag']) {
      expect(problemOf('commit_fields', name)).toBeDefined()
    }
    for (const name of ['id', 'name', 'tracked']) {
      expect(problemOf('machine_fields', name)).toBeDefined()
    }
    expect(problemOf('metrics', 'tag')).toBeUndefined()
    expect(problemOf('metrics', 'tracked')).toBeUndefined()
    expect(problemOf('commit_fields', 'name')).toBeUndefined()
    expect(problemOf('machine_fields', 'ordinal')).toBeUndefined()
    expect(problemOf('machine_fields', 'profile')).toBeUndefined()
  })

  it('refuses a name another entry of the list has, but not one of another list', () => {
    const first = withEntry(EMPTY_DRAFT, 'metrics', 'os')
    const second = withEntry(first.draft, 'metrics', 'os')
    expect(entryNameProblem(second.draft, 'metrics', first.entry)).toBe(
      "Another metric is named 'os'.",
    )
    expect(entryNameProblem(second.draft, 'metrics', second.entry)).toBe(
      "Another metric is named 'os'.",
    )

    const field = withEntry(first.draft, 'machine_fields', 'os')
    expect(entryNameProblem(field.draft, 'machine_fields', field.entry)).toBeUndefined()
    expect(entryNameProblem(field.draft, 'metrics', first.entry)).toBeUndefined()
  })

  it('leaves an empty name to hasBlankName', () => {
    const { draft, entry } = withEntry(EMPTY_DRAFT, 'metrics', '')
    expect(entryNameProblem(draft, 'metrics', entry)).toBeUndefined()
    expect(hasNameProblem(draft)).toBe(false)
    expect(hasBlankName(draft)).toBe(true)
  })
})

describe('hasNameProblem', () => {
  it('says whether any entry of any list has a name refused', () => {
    const fine = withEntry(EMPTY_DRAFT, 'metrics', 'size').draft
    expect(hasNameProblem(fine)).toBe(false)
    expect(hasBlankName(fine)).toBe(false)
    expect(hasNameProblem(withEntry(fine, 'commit_fields', 'tag').draft)).toBe(true)
  })
})

describe('suiteNameProblem', () => {
  it("accepts a name D4's rule allows and no suite has", () => {
    for (const name of ['nts', 'admin', 'suites', 'pg', 'pgx', 'a'.repeat(63)]) {
      expect(suiteNameProblem(name, ['libcxx'])).toBeUndefined()
    }
  })

  it('refuses the names no namespace can have', () => {
    const reserved =
      "A suite cannot be named 'information_schema' or 'public', or start with 'pg_'."
    for (const name of ['public', 'information_schema', 'pg_', 'pg_catalog']) {
      expect(suiteNameProblem(name, [])).toBe(reserved)
    }
  })

  it("refuses a name D4's rule does not allow, or a suite has", () => {
    expect(suiteNameProblem('My Suite', [])).toMatch(/lowercase letters/)
    expect(suiteNameProblem('a'.repeat(64), [])).toMatch(/at most 63/)
    expect(suiteNameProblem('libcxx', ['libcxx'])).toBe("There is already a suite named 'libcxx'.")
  })

  it('leaves an empty name alone', () => {
    expect(suiteNameProblem('', [])).toBeUndefined()
  })
})

describe('changeEntry', () => {
  it('clears searchable and display when the type changes away from text', () => {
    const { draft, entry } = withEntry(EMPTY_DRAFT, 'commit_fields', 'sha')
    const flagged = changeEntry(draft, 'commit_fields', entry.id, {
      searchable: true,
      display: true,
    })
    const changed = changeEntry(flagged, 'commit_fields', entry.id, {
      type: 'integer',
    })
    expect(changed.commit_fields[0]).toMatchObject({
      type: 'integer',
      searchable: false,
      display: false,
    })
  })

  it('makes one commit field at most the display field', () => {
    const first = withEntry(EMPTY_DRAFT, 'commit_fields', 'a')
    const second = withEntry(first.draft, 'commit_fields', 'b')
    const one = changeEntry(second.draft, 'commit_fields', first.entry.id, {
      display: true,
    })
    const other = changeEntry(one, 'commit_fields', second.entry.id, {
      display: true,
    })
    expect(other.commit_fields.map((entry) => entry.display)).toEqual([false, true])
    // Unchecking the display field leaves the others as they are.
    const none = changeEntry(other, 'commit_fields', second.entry.id, {
      display: false,
    })
    expect(none.commit_fields.map((entry) => entry.display)).toEqual([false, false])
  })
})

describe('addEntry and removeEntry', () => {
  it('adds an unnamed entry of the commonest type at the end of its list', () => {
    const metrics = addEntry(draftOf(SUITE), 'metrics', newEntry('metrics'))
    expect(metrics.metrics.at(-1)).toMatchObject({ name: '', type: 'real' })
    const fields = addEntry(EMPTY_DRAFT, 'machine_fields', newEntry('machine_fields'))
    expect(fields.machine_fields).toMatchObject([{ name: '', type: 'text' }])
  })

  it('removes the entry, and only it', () => {
    const draft = draftOf(SUITE)
    const [os] = draft.machine_fields.filter((entry) => entry.name === 'os')
    const removed = removeEntry(draft, 'machine_fields', os.id)
    expect(removed.machine_fields.map((entry) => entry.name)).toEqual(['hardware', 'core_count'])
    expect(removed.metrics).toBe(draft.metrics)
  })
})

describe('draftOf and schemaOf', () => {
  it('copy a schema, keys and all, as a new suite', () => {
    expect(schemaOf('copy', draftOf(SUITE))).toEqual({
      ...SUITE,
      name: 'copy',
    })
  })

  it('send each entry with exactly the keys its list accepts', () => {
    let draft = EMPTY_DRAFT
    for (const list of ['metrics', 'commit_fields', 'machine_fields'] as const) {
      draft = withEntry(draft, list, 'x').draft
    }
    expect(schemaOf('new', draft)).toEqual({
      name: 'new',
      metrics: [
        {
          name: 'x',
          type: 'real',
          display_name: null,
          unit: null,
          unit_abbrev: null,
          bigger_is_better: false,
        },
      ],
      commit_fields: [
        {
          name: 'x',
          type: 'text',
          display_name: null,
          searchable: false,
          display: false,
        },
      ],
      machine_fields: [{ name: 'x', type: 'text', display_name: null, searchable: false }],
    })
  })

  it('send text without surrounding whitespace, and only whitespace as null', () => {
    const { draft, entry } = withEntry(EMPTY_DRAFT, 'metrics', 'time')
    const changed = changeEntry(draft, 'metrics', entry.id, {
      display_name: '  Time ',
      unit: '   ',
      unit_abbrev: 's',
    })
    expect(schemaOf('new', changed).metrics![0]).toMatchObject({
      display_name: 'Time',
      unit: null,
      unit_abbrev: 's',
    })
  })

  it('send a suite without entries', () => {
    expect(schemaOf('empty', EMPTY_DRAFT)).toEqual({
      name: 'empty',
      metrics: [],
      commit_fields: [],
      machine_fields: [],
    })
  })
})
