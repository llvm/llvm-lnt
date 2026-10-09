/**
 * Formatting shared by every page (AR2 "Display conventions").
 */

/** What a table shows in place of a value that is absent. */
export const MISSING = '--'

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * A timestamp in the browser's local time zone, as `2026-08-25, 2:22:41 PM`. Built by hand rather
 * than with `Intl`, whose output varies across browsers and versions (some put a narrow no-break
 * space before `PM`).
 */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const hours = date.getHours()
  const time = `${hours % 12 || 12}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return `${day}, ${time} ${hours < 12 ? 'AM' : 'PM'}`
}

/** The first 8 characters of a UUID: what a deletion is confirmed with (AR2 "Deletions"). */
export function uuidPrefix(uuid: string): string {
  return uuid.slice(0, 8)
}

/** A UUID shortened to its first 8 characters, where space is short. */
export function shortUuid(uuid: string): string {
  return `${uuidPrefix(uuid)}…`
}

/** A regression's title, or `(untitled)` when it has none (AR2 "Display conventions"). */
export function regressionTitle(regression: { title: string | null }): string {
  return regression.title ?? '(untitled)'
}

/**
 * `text`, cut to at most `max` characters, the last of them an ellipsis when it is cut. Characters
 * are counted as code points, so that none is cut in half.
 */
export function truncate(text: string, max: number): string {
  const characters = Array.from(text)
  return characters.length <= max ? text : `${characters.slice(0, max - 1).join('')}…`
}
