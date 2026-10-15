/**
 * The counter the Profiles page shows (PF4): the one the user picked, or the one the Counter
 * dropdown starts on, for as long as a profile shown has it.
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
   * Whether the counter can be relied on: no side's profile is on its way, which could change it.
   * Until then, what depends on the counter, such as which function is a side's hottest, waits.
   */
  settled: boolean
  /** Whether the profiles shown have no counter at all, once each has loaded or failed. */
  none: boolean
  pick(counter: string): void
}

/**
 * The counter shown, from the sides `sides`, and the URL's `counter`, which `update` changes.
 *
 * The counter is held as a name, never as a stand-in for the default, so that it stays as the
 * profiles shown change, for as long as one of them has it. It is left out of the URL while it is
 * the default of the profiles shown. It is only checked against the profiles while a side shows one,
 * so that a side's test cleared, then another picked, keeps it. Until every profile shown has
 * loaded, a counter that those loaded lack gives way to their default for the time being, but only
 * once they all have does it fall back to it for good, held and written to the URL (AR2 "State").
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
  // Until a profile shown has loaded, there is nothing to check the counter against.
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
