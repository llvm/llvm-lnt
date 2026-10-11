/**
 * Formatting shared by every page (AR2 "Display conventions").
 */

/** What a table shows in place of a value that is absent. */
export const MISSING = '--'

/** A boolean, in words. */
export function yesNo(value: boolean): string {
  return value ? 'Yes' : 'No'
}

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

// Fixed to one locale, so that a value reads the same in every browser. No grouping, so that a
// value can be copied as a number. Of the two limits, the one keeping more digits applies, so that
// the integer part is never rounded.
const NUMBER = new Intl.NumberFormat('en-US', {
  maximumSignificantDigits: 6,
  maximumFractionDigits: 0,
  roundingPriority: 'morePrecision',
  useGrouping: false,
})

/**
 * A measured number, to at most 6 significant digits but with its whole integer part (AR2 "Display
 * conventions"): `1.26432`, `66655.7`, `4123456789`.
 */
export function formatNumber(value: number): string {
  return NUMBER.format(value)
}

/** `count noun`, with the noun in the plural unless the count is one: `1 run`, `3 runs`. */
export function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`
}

/** Orders strings as `Array.prototype.sort` does by default, by UTF-16 code units. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
