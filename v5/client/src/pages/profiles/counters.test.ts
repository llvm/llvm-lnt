import { describe, expect, it } from 'vitest'
import { formatPercent } from '../../format'
import {
  comparedValue,
  defaultCounter,
  difference,
  differenceDirection,
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

  it('gives N/A when a side has no value, or A is 0', () => {
    expect(difference(null, 1)).toBeNull()
    expect(difference(1, null)).toBeNull()
    expect(difference(0, 1)).toBeNull()
  })

  it("gives nothing while either side's values are not known, even if the other is N/A", () => {
    expect(difference(undefined, 1)).toBeUndefined()
    expect(difference(null, undefined)).toBeUndefined()
  })
})

describe('comparedValue', () => {
  it("gives a profile's value, N/A for a counter it lacks, and nothing until it loads", () => {
    expect(comparedValue({ cycles: 0 }, 'cycles')).toBe(0)
    expect(comparedValue({ cycles: 1 }, 'misses')).toBeNull()
    expect(comparedValue(undefined, 'cycles')).toBeUndefined()
  })
})

describe('differenceDirection', () => {
  const direction = (value: number) => differenceDirection(formatPercent(value, { signed: true }))

  it('tells a decrease from an increase by the sign shown', () => {
    expect(direction(-20)).toBe('decrease')
    expect(direction(20)).toBe('increase')
  })

  it('gives neither for a Difference shown as 0%, however small its value', () => {
    expect(formatPercent(-0.04, { signed: true })).toBe('0%')
    expect(direction(-0.04)).toBeUndefined()
    expect(direction(0.04)).toBeUndefined()
    expect(direction(0)).toBeUndefined()
  })

  it('agrees with the rounding of the text shown, half away from zero', () => {
    expect(formatPercent(-0.05, { signed: true })).toBe('-0.1%')
    expect(direction(-0.05)).toBe('decrease')
    expect(formatPercent(0.05, { signed: true })).toBe('+0.1%')
    expect(direction(0.05)).toBe('increase')
  })

  it('gives neither for N/A', () => {
    expect(differenceDirection('N/A')).toBeUndefined()
  })
})
