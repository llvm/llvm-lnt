/**
 * The counter the Profiles page shows (PF4): the counter the user picked, or the one the Counter
 * dropdown starts on, for as long as some profile shown has it.
 */

import { useEffect, useState } from 'react'
import type { Counters } from './counters'
import { defaultCounter, offeredCounters, shownCounter } from './counters'
import { urlValue, type Settings } from './settings'
import type { ProfileSide } from './use-side'

export interface Counter {
  /** Every top-level counter of the profiles shown, sorted by name. */
  offered: string[]
  /** The counter shown, if the profiles shown have any. */
  shown: string | undefined
  /**
   * Whether the counter is settled: no side's profile is still loading, so the counter cannot
   * change on its own. Until then, whatever depends on the counter waits, such as finding a side's
   * hottest function.
   */
  settled: boolean
  /** Whether the profiles shown have no counters at all, once each one has loaded or failed. */
  none: boolean
  pick(counter: string): void
}

/**
 * The counter shown, from the sides `sides` and the URL's `counter`, which `update` changes.
 *
 * The page holds the counter by its name, never as a placeholder that means "the default". So the
 * counter stays as the profiles shown change, for as long as one of them has it. The URL leaves it
 * out while it is the starting counter of the profiles shown. The page only checks the counter
 * against the profiles while some side shows a profile, so clearing a side's test and then picking
 * another keeps it. Until every profile shown has loaded, a counter that the loaded profiles lack
 * gives way to their starting counter for the time being. Once they have all loaded, the counter
 * falls back to the starting counter for good: the page holds it and writes it to the URL (AR2
 * "State").
 */
export function useCounter(
  sides: readonly ProfileSide[],
  counter: string,
  update: (changes: Partial<Settings>) => void,
): Counter {
  const [held, setHeld] = useState(counter === '' ? undefined : counter)
  const statuses = sides.map((side) => side.status)
  const loaded: Counters[] = statuses.flatMap((status) =>
    status.kind === 'shown' ? [status.profile.counters] : [],
  )
  const anyShown = statuses.some((status) => status.kind !== 'none')
  const settled = statuses.every((status) => status.kind !== 'pending')
  const complete = statuses.every((status) => status.kind === 'none' || status.kind === 'shown')

  const offered = offeredCounters(loaded)
  const fallback = defaultCounter(loaded)
  // Until some profile shown has loaded, there is nothing to check the counter against.
  const shown = loaded.length > 0 ? shownCounter(held, loaded) : held
  const checked = complete && anyShown
  if (checked && shown !== held) setHeld(shown)

  const written = urlValue(shown, fallback)
  useEffect(() => {
    if (checked) update({ counter: written })
  }, [checked, written, update])

  return {
    offered,
    shown,
    settled,
    none: settled && loaded.length > 0 && offered.length === 0,
    pick: (picked) => {
      setHeld(picked)
      update({ counter: urlValue(picked, fallback) })
    },
  }
}
