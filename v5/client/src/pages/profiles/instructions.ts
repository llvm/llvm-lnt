/**
 * The values of a function's instructions for the selected counter (PF6), and the order the
 * hottest instructions are stepped through in (PF5).
 */

import type { Schemas } from '../../api/client'
import { formatNumber, formatPercent } from '../../format'

export type Instruction = Schemas['Instruction']

/** How a disassembly view shows an instruction's value (PF6). */
export type ValueMode = 'relative' | 'absolute' | 'cumulative'

/** The values of a function's instructions for a counter, one entry per instruction, in order. */
export interface InstructionValues {
  /** The instruction's value. */
  raw: Float64Array
  /** The instruction's share of the function's value, as a percentage: 0 when that value is 0. */
  shares: Float64Array
  /** The sum of the shares up to the instruction, included: 100 at the last one, unless all are 0. */
  cumulative: Float64Array
  /** The sum of the values: 0 only when every value is, since counts are never negative. */
  total: number
}

/**
 * The values of `instructions`, a function's, for `counter`. None when the function does not have
 * the counter: its instructions all have the same counters (O7). A function without instructions
 * has values, none of them, rather than lacking the counter.
 *
 * The function's value is summed here rather than taken from the API, so that the running sum ends
 * at exactly 100%, whatever order the server added the values in.
 */
export function instructionValues(
  instructions: readonly Instruction[],
  counter: string,
): InstructionValues | undefined {
  if (instructions.length > 0 && !(counter in instructions[0].counters)) return undefined
  const count = instructions.length
  const raw = new Float64Array(count)
  let total = 0
  for (let i = 0; i < count; i++) {
    raw[i] = instructions[i].counters[counter]
    total += raw[i]
  }
  const shares = new Float64Array(count)
  const cumulative = new Float64Array(count)
  if (total > 0) {
    let running = 0
    for (let i = 0; i < count; i++) {
      running += raw[i]
      shares[i] = (raw[i] / total) * 100
      cumulative[i] = (running / total) * 100
    }
  }
  return { raw, shares, cumulative, total }
}

/** An address, in hexadecimal with a `0x` prefix (PF5). */
export function formatAddress(address: number): string {
  return `0x${address.toString(16)}`
}

/**
 * What the disassembly view shows for the instruction at `index` in `mode` (PF6). Nothing for a
 * value of 0 in Relative % and Absolute, so that the instructions that matter stand out.
 */
export function formatInstructionValue(
  values: InstructionValues,
  index: number,
  mode: ValueMode,
): string {
  const raw = values.raw[index]
  switch (mode) {
    case 'relative':
      return raw === 0 ? '' : formatPercent(values.shares[index])
    case 'absolute':
      return raw === 0 ? '' : formatNumber(raw)
    case 'cumulative':
      return formatPercent(values.cumulative[index])
  }
}

/**
 * The indices of the instructions whose values are `raw`, from the hottest to the coldest (PF5):
 * by value, descending, ties in the order of the instructions, leaving out those whose value is 0.
 */
export function hottestOrder(raw: ArrayLike<number>): number[] {
  const order: number[] = []
  for (let i = 0; i < raw.length; i++) if (raw[i] > 0) order.push(i)
  return order.sort((a, b) => raw[b] - raw[a] || a - b)
}

/** Tab stops are every 8 columns, as in the browser's default `tab-size`. */
const TAB_SIZE = 8

/**
 * How many columns of a fixed-width font the widest line of `text` takes, tabs expanded, counting
 * code points. One pass over its code units, as it is run for every instruction of a function.
 */
export function textColumns(text: string): number {
  let widest = 0
  let column = 0
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit === 0x0a) column = 0
    else if (unit === 0x09) column = (Math.floor(column / TAB_SIZE) + 1) * TAB_SIZE
    // The second half of a surrogate pair belongs to the code point its first half counted.
    else if (unit < 0xdc00 || unit > 0xdfff) column++
    widest = Math.max(widest, column)
  }
  return widest
}

/**
 * How many columns of a fixed-width font the widest of `values` takes, whichever way it is shown
 * (PF6), so that a column sized to it never cuts one off. A value is shown to 6 significant digits
 * but with its whole integer part (AR6): none from 1 up is longer than both 7 characters (`1.23456`)
 * and the largest value, and none below 1 longer than `0.`, the smallest value's zeros after the
 * point, and 6 digits. No percentage is longer than those.
 */
export function valueColumns(values: InstructionValues | undefined): number {
  let largest = 0
  let smallest = Infinity
  for (const raw of values?.raw ?? []) {
    if (raw > largest) largest = raw
    if (raw > 0 && raw < smallest) smallest = raw
  }
  let columns = Math.max(7, formatNumber(largest).length)
  if (smallest < 1) {
    const zeros = Math.max(0, -Math.floor(Math.log10(smallest)) - 1)
    columns = Math.max(columns, 2 + zeros + 6)
  }
  return columns
}
