import { describe, expect, it } from 'vitest'
import { nextSort, sortParam, sortRows, type SortKey } from './table-sort'

interface Row {
  id: string
  key: SortKey
}

const ROWS: Row[] = [
  { id: 'a', key: 2 },
  { id: 'b', key: null },
  { id: 'c', key: 1 },
  { id: 'd', key: 2 },
  { id: 'e', key: null },
]

const ids = (rows: Row[]) => rows.map((row) => row.id)

describe('sortRows', () => {
  it('sorts numbers numerically, keeping the order of ties, in both directions', () => {
    expect(ids(sortRows(ROWS, (row) => row.key, 'ascending'))).toEqual(['c', 'a', 'd', 'b', 'e'])
    expect(ids(sortRows(ROWS, (row) => row.key, 'descending'))).toEqual(['a', 'd', 'c', 'b', 'e'])
  })

  it('sorts strings by code unit, rather than as numbers or by locale', () => {
    const rows = ['b', 'B', '10', '9', 'a'].map((key) => ({ id: key, key }))

    expect(ids(sortRows(rows, (row) => row.key, 'ascending'))).toEqual(['10', '9', 'B', 'a', 'b'])
  })

  it('leaves the rows it is given as they are', () => {
    const rows = [...ROWS]

    sortRows(rows, (row) => row.key, 'ascending')

    expect(rows).toEqual(ROWS)
  })
})

describe('nextSort', () => {
  it('sorts by another column ascending, and toggles the direction of the same one', () => {
    const sort = { column: 'a', direction: 'descending' } as const

    expect(nextSort(sort, 'b')).toEqual({ column: 'b', direction: 'ascending' })
    expect(nextSort(sort, 'a')).toEqual({ column: 'a', direction: 'ascending' })
    expect(nextSort(nextSort(sort, 'a'), 'a')).toEqual(sort)
  })
})

describe('sortParam', () => {
  const param = sortParam(['name', 'created_at'], { column: 'created_at', direction: 'descending' })

  it('spells the column, prefixed with - for descending order', () => {
    expect(param.serialize({ column: 'name', direction: 'ascending' })).toEqual(['name'])
    expect(param.serialize({ column: 'name', direction: 'descending' })).toEqual(['-name'])
    expect(param.parse(['-created_at'])).toEqual({ column: 'created_at', direction: 'descending' })
    expect(param.parse(['name'])).toEqual({ column: 'name', direction: 'ascending' })
  })

  it.each([[['nope']], [['-']], [['--name']], [['name', 'created_at']]])(
    'cannot use %j',
    (values) => {
      expect(param.parse(values)).toBeUndefined()
    },
  )
})
