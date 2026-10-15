import { describe, expect, it } from 'vitest'
import { functionChoice, functionShare, hottestFirst } from './functions'

const fn = (name: string, counters: Record<string, number>) => ({ name, counters, length: 1 })

describe('functionShare', () => {
  const profile = { cycles: 200, misses: 0 }

  it("gives the function's share of the profile's value, as a percentage", () => {
    expect(functionShare(fn('f', { cycles: 50 }), 'cycles', profile)).toBe(25)
    expect(functionShare(fn('f', { cycles: 0 }), 'cycles', profile)).toBe(0)
  })

  it('gives none for a function without the counter', () => {
    expect(functionShare(fn('f', { misses: 1 }), 'cycles', profile)).toBeUndefined()
  })

  it("gives none when the profile's value is 0 or missing, or there is no counter", () => {
    expect(functionShare(fn('f', { misses: 1 }), 'misses', profile)).toBeUndefined()
    expect(functionShare(fn('f', { branches: 1 }), 'branches', profile)).toBeUndefined()
    expect(functionShare(fn('f', { cycles: 1 }), undefined, profile)).toBeUndefined()
  })
})

describe('hottestFirst', () => {
  const names = (functions: { name: string }[]) => functions.map((f) => f.name)

  it('sorts by value, descending, ties by name in code-point order', () => {
    const functions = [
      fn('c', { cycles: 1 }),
      fn('b', { cycles: 5 }),
      fn('a', { cycles: 1 }),
      fn('Z', { cycles: 1 }),
    ]
    expect(names(hottestFirst(functions, 'cycles'))).toEqual(['b', 'Z', 'a', 'c'])
  })

  it('puts the functions without the counter after every one with it', () => {
    const functions = [fn('a', {}), fn('b', { cycles: 0 }), fn('c', {}), fn('d', { cycles: 3 })]
    expect(names(hottestFirst(functions, 'cycles'))).toEqual(['d', 'b', 'a', 'c'])
  })

  it('sorts by name without a counter', () => {
    const functions = [fn('b', { cycles: 9 }), fn('a', { cycles: 1 })]
    expect(names(hottestFirst(functions, undefined))).toEqual(['a', 'b'])
  })

  it('leaves the functions it is given as they are', () => {
    const functions = [fn('a', { cycles: 1 }), fn('b', { cycles: 2 })]
    hottestFirst(functions, 'cycles')
    expect(names(functions)).toEqual(['a', 'b'])
  })
})

describe('functionChoice', () => {
  const functions = [fn('main', { cycles: 1 }), fn('hot', { cycles: 9 }), fn('warm', { cycles: 5 })]
  const base = { test: 't1', functions, hottest: 'hot', carry: null, url: '', other: null }

  it('has none for a profile that lists none', () => {
    expect(functionChoice({ ...base, functions: [] })).toEqual({ name: null })
  })

  it('takes the function the URL names if the profile has it, and the hottest otherwise', () => {
    expect(functionChoice({ ...base, url: 'warm' })).toEqual({ name: 'warm' })
    expect(functionChoice({ ...base, url: 'gone' })).toEqual({ name: 'hot' })
    expect(functionChoice(base)).toEqual({ name: 'hot' })
  })

  it('waits for the hottest to be known, when it needs it', () => {
    expect(functionChoice({ ...base, hottest: undefined })).toBeUndefined()
    expect(functionChoice({ ...base, hottest: undefined, url: 'warm' })).toEqual({ name: 'warm' })
  })

  it('keeps its own function, of the same test, without asking the other side', () => {
    const carry = { test: 't1', name: 'main' }
    expect(functionChoice({ ...base, carry, other: undefined })).toEqual({ name: 'main' })
  })

  it("then takes the other side's, waiting for it, and the hottest otherwise", () => {
    const other = { test: 't1', name: 'warm' }
    for (const carry of [
      { test: 't0', name: 'main' },
      { test: 't1', name: 'gone' },
      { test: 't1', name: null },
    ]) {
      expect(functionChoice({ ...base, carry, other: undefined })).toBeUndefined()
      expect(functionChoice({ ...base, carry, other })).toEqual({ name: 'warm' })
      expect(functionChoice({ ...base, carry, other: null })).toEqual({ name: 'hot' })
    }
    // The other side's function must be of the same test too.
    const carry = { test: 't0', name: 'main' }
    expect(functionChoice({ ...base, carry, other: { test: 't0', name: 'warm' } })).toEqual({
      name: 'hot',
    })
    expect(functionChoice({ ...base, carry, other: null, hottest: undefined })).toBeUndefined()
  })

  it('ignores the URL while carrying', () => {
    const carry = { test: 't0', name: 'main' }
    expect(functionChoice({ ...base, carry, url: 'warm' })).toEqual({ name: 'hot' })
  })
})
