import { describe, expect, it } from 'vitest'
import {
  formatInstructionValue,
  hottestOrder,
  instructionValues,
  textColumns,
  valueColumns,
  type Instruction,
  type InstructionValues,
  type ValueMode,
} from './instructions'

function instructions(...values: number[]): Instruction[] {
  return values.map((cycles, i) => ({ address: 4096 + i, counters: { cycles }, text: 'nop' }))
}

function shown(values: InstructionValues, mode: ValueMode): string[] {
  return Array.from(values.raw, (_, i) => formatInstructionValue(values, i, mode))
}

describe('instructionValues', () => {
  it("gives each instruction's value, share and running sum of shares", () => {
    const values = instructionValues(instructions(1, 0, 3), 'cycles')!
    expect([...values.raw]).toEqual([1, 0, 3])
    expect([...values.shares]).toEqual([25, 0, 75])
    expect([...values.cumulative]).toEqual([25, 25, 100])
    expect(values.total).toBe(4)
  })

  it('ends its running sum at exactly 100%', () => {
    // Shares that do not add up to exactly 100 in floating point.
    const values = instructionValues(instructions(0.1, 0.2, 0.3, 1e-9, 7), 'cycles')!
    expect(values.cumulative.at(-1)).toBe(100)
  })

  it("gives shares of 0 when the function's value is 0", () => {
    const values = instructionValues(instructions(0, 0), 'cycles')!
    expect([...values.shares]).toEqual([0, 0])
    expect([...values.cumulative]).toEqual([0, 0])
    expect(values.total).toBe(0)
  })

  it('gives none when the function does not have the counter', () => {
    expect(instructionValues(instructions(1, 2), 'misses')).toBeUndefined()
  })

  it('gives empty values, rather than none, for a function without instructions', () => {
    const values = instructionValues([], 'cycles')!
    expect(values.raw).toHaveLength(0)
  })
})

describe('formatInstructionValue', () => {
  const values = instructionValues(instructions(1, 0, 2.5, 123456789), 'cycles')!

  it('shows the share in Relative %, and nothing for a value of 0', () => {
    expect(shown(values, 'relative')).toEqual(['0%', '', '0%', '100%'])
    expect(shown(instructionValues(instructions(1, 0, 2), 'cycles')!, 'relative')).toEqual([
      '33.3%',
      '',
      '66.7%',
    ])
  })

  it('shows the raw value in Absolute, and nothing for a value of 0', () => {
    expect(shown(values, 'absolute')).toEqual(['1', '', '2.5', '123456789'])
  })

  it('shows the running sum in Cumulative %, even where the value is 0', () => {
    expect(shown(instructionValues(instructions(1, 0, 3), 'cycles')!, 'cumulative')).toEqual([
      '25%',
      '25%',
      '100%',
    ])
    expect(shown(instructionValues(instructions(0, 0), 'cycles')!, 'cumulative')).toEqual([
      '0%',
      '0%',
    ])
  })
})

describe('hottestOrder', () => {
  it('goes from the hottest to the coldest, ties in order, leaving out values of 0', () => {
    expect(hottestOrder([3, 0, 5, 3, 1, 0, 5])).toEqual([2, 6, 0, 3, 4])
  })

  it('is empty when no instruction has a value', () => {
    expect(hottestOrder([0, 0])).toEqual([])
    expect(hottestOrder([])).toEqual([])
  })
})

describe('textColumns', () => {
  it('counts the columns of the widest line, with tab stops every 8 columns', () => {
    expect(textColumns('')).toBe(0)
    expect(textColumns('ret')).toBe(3)
    expect(textColumns('push\trbp')).toBe(11)
    expect(textColumns('\tx')).toBe(9)
    expect(textColumns('12345678\tx')).toBe(17)
    expect(textColumns('a\nlonger line')).toBe(11)
    expect(textColumns('longer line\na')).toBe(11)
    expect(textColumns('𝔸𝔹')).toBe(2)
  })
})

describe('valueColumns', () => {
  const modes: ValueMode[] = ['relative', 'absolute', 'cumulative']

  it.each([
    [[1, 2, 3]],
    [[0.000123456, 5]],
    [[0.5, 0.123456]],
    [[0.000999999]],
    [[1.23456, 0]],
    [[123456789.5, 0.25]],
    [[1e-9, 1]],
  ])('is as wide as the widest of %j, however it is shown', (raws) => {
    const values = instructionValues(instructions(...raws), 'cycles')!
    const widest = Math.max(...modes.flatMap((mode) => shown(values, mode).map((s) => s.length)))
    expect(valueColumns(values)).toBeGreaterThanOrEqual(widest)
  })

  it('fits a small value in full', () => {
    const values = instructionValues(instructions(0.000123456), 'cycles')!
    expect(formatInstructionValue(values, 0, 'absolute')).toBe('0.000123456')
    expect(valueColumns(values)).toBe(11)
  })

  it('is 7 columns without values', () => {
    expect(valueColumns(undefined)).toBe(7)
    expect(valueColumns(instructionValues(instructions(0, 0), 'cycles'))).toBe(7)
  })
})
