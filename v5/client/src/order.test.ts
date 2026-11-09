import { describe, expect, it } from 'vitest'
import { arrangeBy, moveTo } from './order'

describe('moveTo', () => {
  const keys = ['a', 'b', 'c', 'd']

  it('puts an item moved towards the start just before its target', () => {
    expect(moveTo(keys, 'c', 'a')).toEqual(['c', 'a', 'b', 'd'])
    expect(moveTo(keys, 'd', 'c')).toEqual(['a', 'b', 'd', 'c'])
  })

  it('puts an item moved towards the end just after its target', () => {
    expect(moveTo(keys, 'a', 'c')).toEqual(['b', 'c', 'a', 'd'])
    expect(moveTo(keys, 'b', 'd')).toEqual(['a', 'c', 'd', 'b'])
  })

  it('leaves the order as it is for an item moved onto itself, or one not held', () => {
    expect(moveTo(keys, 'b', 'b')).toEqual(keys)
    expect(moveTo(keys, 'x', 'a')).toEqual(keys)
    expect(moveTo(keys, 'a', 'x')).toEqual(keys)
  })

  it('returns a new array, leaving the one given as it is', () => {
    const moved = moveTo(keys, 'a', 'b')
    expect(moved).not.toBe(keys)
    expect(keys).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('arrangeBy', () => {
  const items = ['a', 'b', 'c'].map((name) => ({ name }))
  const nameOf = (item: { name: string }) => item.name
  const names = (arranged: { name: string }[]) => arranged.map(nameOf)

  it('puts the items in the order of their keys', () => {
    const arranged = arrangeBy(items, ['c', 'a', 'b'], nameOf)
    expect(names(arranged.items)).toEqual(['c', 'a', 'b'])
    expect(arranged.items[0]).toBe(items[2])
    expect(arranged.outdated).toBe(false)
  })

  it('puts the items whose keys are left out last, in their order, as outdated', () => {
    const arranged = arrangeBy(items, ['c'], nameOf)
    expect(names(arranged.items)).toEqual(['c', 'a', 'b'])
    expect(arranged.outdated).toBe(true)
  })

  it('ignores keys of no item, as outdated', () => {
    const arranged = arrangeBy(items, ['b', 'x', 'a', 'c'], nameOf)
    expect(names(arranged.items)).toEqual(['b', 'a', 'c'])
    expect(arranged.outdated).toBe(true)
  })
})
