import { describe, expect, it } from 'vitest'
import { heatColor } from './heat'

describe('heatColor', () => {
  it('does not color a share below 1%', () => {
    expect(heatColor(0)).toBeUndefined()
    expect(heatColor(0.99)).toBeUndefined()
    expect(heatColor(NaN)).toBeUndefined()
  })

  it('goes from yellow at 1% to red at 10%', () => {
    expect(heatColor(1)).toBe('rgb(253, 224, 71)')
    expect(heatColor(5.5)).toBe('rgb(251, 169, 92)')
    expect(heatColor(10)).toBe('rgb(248, 113, 113)')
  })

  it('is red from 10% up', () => {
    expect(heatColor(50)).toBe('rgb(248, 113, 113)')
    expect(heatColor(150)).toBe('rgb(248, 113, 113)')
  })
})
