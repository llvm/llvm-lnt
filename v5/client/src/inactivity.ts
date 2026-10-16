/** How a machine's or a commit's `delete_after_inactive_days` is shown and edited (DT1, DT3). */

import { plural } from './format'

/** The range of `delete_after_inactive_days` (D5). */
const INACTIVE_DAYS_MIN = 1
const INACTIVE_DAYS_MAX = 36500

/** What the setting does, wherever it is shown (O10). */
export const INACTIVITY_HELP =
  'Delete it automatically, along with its runs, once this many days have passed since it ' +
  'was created or since a run was last submitted for it, whichever is later. A number of days ' +
  'it has already been unused for gets it deleted shortly after it is saved. Empty to keep it ' +
  'however long it is unused.'

/** What the Commit Detail page says of the setting while the commit has an ordinal (DT3). */
export const ORDERED_COMMIT_NOTE = 'No effect while the commit has an ordinal.'

/** The setting as an `InlineEdit` holds it: its text, or null when it is not set. */
export function days(value: number | null): string | null {
  return value === null ? null : String(value)
}

/** `days` as the info boxes show it: `1 day`, `30 days`. */
export function formatInactiveDays(days: string): string {
  return plural(Number(days), 'day')
}

/** Why `text` is not a number of days the setting can hold, if it is not (AR11). */
export function invalidInactiveDays(text: string): string | undefined {
  // Checked as digits first: `Number` reads more than an integer (`1e3`, `0x10`).
  const days = Number(text)
  return /^\d+$/.test(text) && days >= INACTIVE_DAYS_MIN && days <= INACTIVE_DAYS_MAX
    ? undefined
    : `A number of days is a whole number from ${INACTIVE_DAYS_MIN} to ${INACTIVE_DAYS_MAX}.`
}
