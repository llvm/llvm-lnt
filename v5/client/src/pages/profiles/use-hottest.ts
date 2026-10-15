/**
 * Where the Previous and Next buttons have got to, stepping through a function's hottest
 * instructions (PF5).
 */

import { useState } from 'react'
import { hottestOrder, type InstructionValues } from './instructions'

/** Where the buttons have got to under `counter`: `order[index]` is the instruction highlighted. */
interface Position {
  counter: string | undefined
  order: readonly number[]
  index: number
}

export interface Hottest {
  /**
   * The instruction highlighted, if any: its index among the function's (`instruction`), which of
   * the hottest instructions it is, from 0 (`rank`), and how many there are (`count`).
   */
  highlighted: { instruction: number; rank: number; count: number } | undefined
  canPrevious: boolean
  canNext: boolean
  previous(): void
  next(): void
}

/**
 * Stepping through the hottest instructions of a function, whose values for `counter` are `values`
 * (none when it does not have the counter). Its owner renders it once per function, so another
 * function starts afresh. Another counter starts again from before the hottest instruction too,
 * whereas new values under the same counter, which a refetch brings, keep the position.
 */
export function useHottest(
  values: InstructionValues | undefined,
  counter: string | undefined,
): Hottest {
  const [position, setPosition] = useState<Position | null>(null)
  // React renders again at once, before showing what this render gives.
  if (position !== null && position.counter !== counter) setPosition(null)
  const index = position?.index ?? -1
  const canPrevious = index > 0
  const canNext =
    position === null ? values !== undefined && values.total > 0 : index < position.order.length - 1

  const step = (by: number) => {
    // Sorted on the first step rather than for each counter, as sorting the instructions of a long
    // function takes a while (PF5).
    const order = position?.order ?? hottestOrder(values!.raw)
    setPosition({ counter, order, index: index + by })
  }
  return {
    highlighted: position
      ? { instruction: position.order[index], rank: index, count: position.order.length }
      : undefined,
    canPrevious,
    canNext,
    previous: () => {
      if (canPrevious) step(-1)
    },
    next: () => {
      if (canNext) step(1)
    },
  }
}
