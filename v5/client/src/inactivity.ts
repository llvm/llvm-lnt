/** What a machine's or a commit's `delete_after_inactive_days` means, and what it can hold. */

import { isIntegerIn } from './format'

/** The range of `delete_after_inactive_days` (D5). */
const INACTIVE_DAYS_MIN = 1
const INACTIVE_DAYS_MAX = 36500

/** What the setting does, wherever it is shown (O10). */
export const INACTIVITY_HELP =
  'Delete it automatically, along with its runs, once this many days have passed since it ' +
  'was created or since a run was last submitted for it, whichever is later. Empty to keep it ' +
  'forever.'

/** Why `text` is not a number of days the setting can hold, if it is not (AR11). */
export function invalidInactiveDays(text: string): string | undefined {
  return isIntegerIn(text, INACTIVE_DAYS_MIN, INACTIVE_DAYS_MAX)
    ? undefined
    : `A number of days is a whole number from ${INACTIVE_DAYS_MIN} to ${INACTIVE_DAYS_MAX}.`
}
