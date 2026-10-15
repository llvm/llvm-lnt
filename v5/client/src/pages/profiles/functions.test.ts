import { describe, expect, it } from 'vitest'
import { carriedFunction, functionShare, hottestFirst } from './functions'

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

describe('carriedFunction', () => {
  const next = { test: 't1', functions: new Set(['main', 'helper']) }

  it('keeps its function across profiles of the same test that have it', () => {
    expect(carriedFunction(next, { test: 't1', name: 'helper' }, undefined)).toBe('helper')
    expect(
      carriedFunction(next, { test: 't1', name: 'helper' }, { test: 't1', name: 'main' }),
    ).toBe('helper')
  })

  it("takes the other side's function, of the same test, when it cannot keep its own", () => {
    expect(carriedFunction(next, { test: 't1', name: 'gone' }, { test: 't1', name: 'main' })).toBe(
      'main',
    )
    // A function of another test is not kept, even if the new profile has one of that name.
    expect(
      carriedFunction(next, { test: 't0', name: 'helper' }, { test: 't1', name: 'main' }),
    ).toBe('main')
    expect(carriedFunction(next, undefined, { test: 't1', name: 'main' })).toBe('main')
  })

  it('leaves the side to its hottest function otherwise', () => {
    expect(carriedFunction(next, { test: 't0', name: 'main' }, undefined)).toBeNull()
    expect(carriedFunction(next, undefined, { test: 't0', name: 'main' })).toBeNull()
    expect(carriedFunction(next, { test: 't1', name: 'gone' }, { test: 't1', name: 'gone' })).toBe(
      null,
    )
    expect(carriedFunction(next, undefined, undefined)).toBeNull()
  })
})
