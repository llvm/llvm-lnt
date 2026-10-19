/**
 * Formatting shared by every page (AR6).
 */

/** What a table shows in place of a value that is absent. */
export const MISSING = '--'

/** What a table shows in place of a value a side does not have, or a ratio to 0. */
export const NA = 'N/A'

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

/** The first 8 characters of a UUID: what a deletion is confirmed with (AR16). */
export function uuidPrefix(uuid: string): string {
  return uuid.slice(0, 8)
}

/** A UUID shortened to its first 8 characters, where space is short. */
export function shortUuid(uuid: string): string {
  return `${uuidPrefix(uuid)}…`
}

/** A regression's title, or `(untitled)` when it has none (AR6). */
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
// the integer part is never rounded. No sign for -0.
const NUMBER = new Intl.NumberFormat('en-US', {
  maximumSignificantDigits: 4,
  maximumFractionDigits: 0,
  roundingPriority: 'morePrecision',
  useGrouping: false,
  signDisplay: 'negative',
})

// The same digits in exponent notation, rounded as NUMBER rounds them: `3.75E-10`.
const SCIENTIFIC = new Intl.NumberFormat('en-US', {
  notation: 'scientific',
  maximumSignificantDigits: 4,
})

/**
 * A measured number, to at most 4 significant digits but with its whole integer part, and in
 * exponent notation when it rounds to less than 0.001 (AR6): `1.264`, `66656`, `4123456789`,
 * `3.75e-10`.
 */
export function formatNumber(value: number): string {
  if (value !== 0 && Math.abs(value) < 1e-3) {
    const [digits, exponent] = SCIENTIFIC.format(value).split('E')
    if (Number(exponent) < -3) return `${digits}e${exponent}`
  }
  return NUMBER.format(value)
}

/**
 * At least as many characters as `formatNumber` takes for any number from `smallest` to `largest`,
 * both positive, or for 0 when `smallest` is infinite: none from 1 up takes more than `1.234` and
 * `largest`, and none below 1 more than the widest number of `smallest`'s magnitude in exponent
 * notation, `0.001234` and `1.234e-4` being as wide.
 */
export function longestFormatted(smallest: number, largest: number): number {
  const longest = Math.max('1.234'.length, formatNumber(largest).length)
  return smallest < 1 ? Math.max(longest, smallest.toExponential(3).length) : longest
}

// One decimal place at most, so that a whole number drops its `.0`. Neither shows a sign for a
// value that rounds to 0, which would otherwise read `-0%`.
const PERCENT = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  useGrouping: false,
  signDisplay: 'negative',
})
const SIGNED_PERCENT = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  useGrouping: false,
  signDisplay: 'exceptZero',
})

/**
 * `value`, a percentage, with one decimal place except that a whole number drops the trailing `.0`
 * (CP4, PF6): `33.3%`, `25%`. `signed` shows the sign of a positive value too, as a change does:
 * `+5%`, `-20%`, `0%`.
 */
export function formatPercent(
  value: number,
  { signed = false }: { signed?: boolean } = {},
): string {
  return `${(signed ? SIGNED_PERCENT : PERCENT).format(value)}%`
}

/**
 * The number `text` spells in decimal notation (`2`, `-0.5`, `.5`, `1e-3`), if it is one between
 * `min` and `max`, both included, or undefined otherwise. Strict, unlike `Number`, which reads an
 * empty text as 0 and accepts spaces around it or `0x10`: shared by a setting kept in the URL and
 * the input it is typed in, so that both accept the same texts.
 */
export function parseNumber(text: string, min = -Infinity, max = Infinity): number | undefined {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text)) return undefined
  const value = Number(text)
  return Number.isFinite(value) && value >= min && value <= max ? value : undefined
}

/**
 * Whether `text` is an integer from `min` to `max`, written as one: digits, after a minus sign for
 * a negative one. Checked as digits first, because `Number` reads more than an integer (`1e3`,
 * `0x10`), and makes a long enough one `Infinity`, which a request would send as null.
 */
export function isIntegerIn(text: string, min: number, max: number): boolean {
  const value = Number(text)
  return /^-?\d+$/.test(text) && value >= min && value <= max
}

/** `count noun`, with the noun in the plural unless the count is one: `1 run`, `3 runs`. */
export function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`
}

/** `text` with HTML's special characters escaped: for text a chart reads as HTML, as Plotly does. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Orders strings as `Array.prototype.sort` does by default, by UTF-16 code units. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
