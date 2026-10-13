import { describe, expect, it } from 'vitest'
import { aggregate } from './aggregation'

describe('aggregate', () => {
  it('takes the median, the mean of the middle two for an even count (O9)', () => {
    expect(aggregate([3, 1, 2], 'median')).toBe(2)
    expect(aggregate([4, 1, 3, 2], 'median')).toBe(2.5)
    expect(aggregate([5], 'median')).toBe(5)
  })

  it('takes the mean, the smallest or the largest', () => {
    expect(aggregate([1, 2, 6], 'mean')).toBe(3)
    expect(aggregate([3, -1, 2], 'min')).toBe(-1)
    expect(aggregate([3, -1, 2], 'max')).toBe(3)
  })

  it('takes the mean of equal values as exactly their value', () => {
    // Summed, then divided, three times 0.1 make 0.30000000000000004 / 3 = 0.10000000000000002.
    expect(aggregate([0.1, 0.1, 0.1], 'mean')).toBe(0.1)
    expect(aggregate([0.609, 0.609, 0.609, 0.609, 0.609, 0.609, 0.609], 'mean')).toBe(0.609)
  })

  it('leaves the values it is given as they are', () => {
    const values = [3, 1, 2]
    aggregate(values, 'median')
    expect(values).toEqual([3, 1, 2])
  })
})
