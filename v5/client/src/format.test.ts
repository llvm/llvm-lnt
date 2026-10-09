import { describe, expect, it } from 'vitest'
import {
  formatNumber,
  formatTimestamp,
  plural,
  regressionTitle,
  shortUuid,
  truncate,
} from './format'

// The tests run in UTC (see vite.config.ts).
describe('formatTimestamp', () => {
  it.each([
    ['2026-08-25T14:22:41Z', '2026-08-25, 2:22:41 PM'],
    ['2026-08-18T03:57:56Z', '2026-08-18, 3:57:56 AM'],
    ['2026-01-02T00:05:09Z', '2026-01-02, 12:05:09 AM'],
    ['2026-01-02T12:00:00Z', '2026-01-02, 12:00:00 PM'],
  ])('shows %s as %s', (iso, shown) => {
    expect(formatTimestamp(iso)).toBe(shown)
  })

  it('shows the time in the local time zone', () => {
    expect(formatTimestamp('2026-08-25T14:22:41+02:00')).toBe('2026-08-25, 12:22:41 PM')
  })

  it('shows something it cannot read as it is', () => {
    expect(formatTimestamp('yesterday')).toBe('yesterday')
  })
})

describe('shortUuid', () => {
  it('keeps the first 8 characters', () => {
    expect(shortUuid('573af861-8303-4a5b-a643-b8321e0142c4')).toBe('573af861…')
  })
})

describe('truncate', () => {
  it('keeps a text that fits as it is', () => {
    expect(truncate('abc', 3)).toBe('abc')
  })

  it('cuts a longer one, ending it with an ellipsis', () => {
    expect(truncate('abcdef', 4)).toBe('abc…')
  })

  it('counts characters rather than UTF-16 code units, and cuts none in half', () => {
    expect(truncate('😀😀😀', 3)).toBe('😀😀😀')
    expect(truncate('😀😀😀😀', 3)).toBe('😀😀…')
  })
})

describe('regressionTitle', () => {
  it('is the title, or (untitled) without one', () => {
    expect(regressionTitle({ title: 'slow' })).toBe('slow')
    expect(regressionTitle({ title: null })).toBe('(untitled)')
  })
})

describe('formatNumber', () => {
  it.each([
    [1.2643218, '1.26432'],
    [66655.7123, '66655.7'],
    [1.264, '1.264'],
    [0, '0'],
    [-0.000123456789, '-0.000123457'],
    [4123456789.4, '4123456789'],
    [123456.7, '123457'],
  ])('shows %s as %s', (value, shown) => {
    expect(formatNumber(value)).toBe(shown)
  })
})

describe('plural', () => {
  it('puts the noun in the plural unless there is exactly one', () => {
    expect(plural(0, 'run')).toBe('0 runs')
    expect(plural(1, 'run')).toBe('1 run')
    expect(plural(12, 'run')).toBe('12 runs')
  })
})
