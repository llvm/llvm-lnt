import { describe, expect, it } from 'vitest'
import {
  defaultCounter,
  difference,
  offeredCounters,
  shownCounter,
  type Counters,
} from './counters'

describe('offeredCounters', () => {
  it('gives every counter of the profiles once, sorted by code point', () => {
    expect(
      offeredCounters([
        { instructions: 1, cycles: 2 },
        { cycles: 3, 'branch-misses': 4, Zeta: 5 },
      ]),
    ).toEqual(['Zeta', 'branch-misses', 'cycles', 'instructions'])
  })

  it('gives none for no profiles, or profiles without counters', () => {
    expect(offeredCounters([])).toEqual([])
    expect(offeredCounters([{}, {}])).toEqual([])
  })
})

describe('defaultCounter', () => {
  it("starts on a single profile's first counter", () => {
    expect(defaultCounter([{ instructions: 1, cycles: 2 }])).toBe('cycles')
  })

  it('starts on the first counter every profile has', () => {
    expect(
      defaultCounter([
        { a: 1, cycles: 2 },
        { b: 1, cycles: 2 },
      ]),
    ).toBe('cycles')
  })

  it('starts on the first counter offered when the profiles have none in common', () => {
    expect(defaultCounter([{ cycles: 1 }, { branches: 2 }])).toBe('branches')
  })

  it('has none when the profiles have no counters', () => {
    expect(defaultCounter([{}, {}])).toBeUndefined()
    expect(defaultCounter([])).toBeUndefined()
  })
})

describe('shownCounter', () => {
  const profiles: Counters[] = [
    { a: 1, cycles: 2 },
    { b: 1, cycles: 2 },
  ]

  it('keeps the selected counter while some profile shown has it', () => {
    expect(shownCounter('a', profiles)).toBe('a')
    expect(shownCounter('b', profiles)).toBe('b')
  })

  it('goes back to the default when no profile shown has it', () => {
    expect(shownCounter('misses', profiles)).toBe('cycles')
    expect(shownCounter(undefined, profiles)).toBe('cycles')
    expect(shownCounter('misses', [{}])).toBeUndefined()
  })
})

describe('difference', () => {
  it('gives the change from A to B as a percentage of A', () => {
    expect(difference(200, 150)).toBe(-25)
    expect(difference(200, 300)).toBe(50)
    expect(difference(200, 200)).toBe(0)
    expect(difference(1, 0)).toBe(-100)
  })

  it('gives none when a side has no value, or A is 0', () => {
    expect(difference(undefined, 1)).toBeUndefined()
    expect(difference(1, undefined)).toBeUndefined()
    expect(difference(0, 1)).toBeUndefined()
  })
})
