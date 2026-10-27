/**
 * How the value of a machine or commit field is edited, by its type (DT1): the text its input opens
 * with, the texts it takes, and what a text saves.
 */

import type { Schemas } from './api/client'
import { isIntegerIn, localTimestampText, parseNumber } from './format'

type AttributeType = Schemas['AttributeType']

/** A field's value, as the API gives it and takes it (D3). */
export type StoredValue = string | number

interface FieldEditing {
  /** The text the input opens with, for a field that has a value. */
  text(value: StoredValue): string
  /** Why `text`, trimmed and not empty, cannot be saved, if it cannot (AR11). */
  invalid?(text: string): string | undefined
  /** The value that `text`, trimmed, valid and not empty, saves. */
  parse(text: string): StoredValue
  /** Whether the input takes several lines (AR12). */
  multiline?: boolean
  placeholder?: string
  /** How many characters wide a single-line input is. */
  size?: number
}

/**
 * The integers a browser holds exactly, and so can send as typed: a declared `integer` is a BIGINT
 * (D3), which holds more.
 */
const INTEGER_MAX = Number.MAX_SAFE_INTEGER

/**
 * A timestamp with an explicit offset, for the API to read (D3): `2026-08-25T14:22:41-04:00`. The
 * shape only, since the API refuses the dates and times that do not exist, which the input reports.
 */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

/** How a field of each type is edited (DT1). */
export const FIELD_EDITING: Record<AttributeType, FieldEditing> = {
  // Several lines, since a value can span them, such as a compiler's `--version`.
  text: { text: String, parse: (text) => text, multiline: true },
  integer: {
    text: String,
    invalid: (text) =>
      isIntegerIn(text, -INTEGER_MAX, INTEGER_MAX)
        ? undefined
        : `An integer field takes a whole number from ${-INTEGER_MAX} to ${INTEGER_MAX}.`,
    parse: Number,
  },
  real: {
    text: String,
    invalid: (text) =>
      parseNumber(text) === undefined
        ? 'A real field takes a number, such as 1.5, -.5 or 2e-3.'
        : undefined,
    parse: Number,
  },
  datetime: {
    text: (value) => localTimestampText(String(value)),
    invalid: (text) =>
      TIMESTAMP.test(text)
        ? undefined
        : 'A datetime field takes a date and time with an offset or Z, such as ' +
          '2026-08-25T14:22:41-04:00.',
    // As typed: the API reads it (D3).
    parse: (text) => text,
    placeholder: 'YYYY-MM-DDTHH:MM:SS+HH:MM',
    // Wide enough for the text it opens with, milliseconds included.
    size: 30,
  },
}
