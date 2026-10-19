import { describe, expect, it } from 'vitest'
import {
  formatNumber,
  formatPercent,
  longestFormatted,
  formatTimestamp,
  parseNumber,
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
    [1.2643218, '1.264'],
    [66655.7123, '66656'],
    [1.2, '1.2'],
    [0, '0'],
    [-0, '0'],
    [4123456789.4, '4123456789'],
    [123456.7, '123457'],
    [0.0012345, '0.001235'],
    // Exponent notation once it rounds to less than 0.001, rounded as other values are.
    [0.00099996, '0.001'],
    [0.0009999, '9.999e-4'],
    [-0.000123456789, '-1.235e-4'],
    [3.74999e-10, '3.75e-10'],
    [1e-300, '1e-300'],
    [NaN, 'NaN'],
    [-Infinity, '-∞'],
  ])('shows %s as %s', (value, shown) => {
    expect(formatNumber(value)).toBe(shown)
  })
})

describe('longestFormatted', () => {
  // Numbers of every shape formatNumber gives, around its thresholds and digit counts.
  const numbers = [
    5e-324, 1.2345e-100, 9.99996e-10, 1.2345e-10, 1e-9, 1.2345e-5, 0.00099996, 0.0012345, 0.012345,
    0.5, 1, 1.2345, 99.995, 12345.6, 4123456789.4,
  ]

  const ranges = numbers.flatMap((smallest) =>
    numbers.filter((largest) => largest >= smallest).map((largest) => [smallest, largest]),
  )

  it.each(ranges)(
    'is at least as long as any number from %s to %s, as shown',
    (smallest, largest) => {
      const between = numbers.filter((n) => n >= smallest && n <= largest)
      const longest = Math.max(...between.map((n) => formatNumber(n).length))
      expect(longestFormatted(smallest, largest)).toBeGreaterThanOrEqual(longest)
    },
  )
})

describe('formatPercent', () => {
  it('gives one decimal place, and none for a whole number', () => {
    expect(formatPercent(100 / 3)).toBe('33.3%')
    expect(formatPercent(25)).toBe('25%')
    expect(formatPercent(100)).toBe('100%')
    expect(formatPercent(9.96)).toBe('10%')
    expect(formatPercent(-12.34)).toBe('-12.3%')
  })

  it('shows no sign for a value that rounds to 0', () => {
    expect(formatPercent(-0.04)).toBe('0%')
    expect(formatPercent(-0.04, { signed: true })).toBe('0%')
    expect(formatPercent(0, { signed: true })).toBe('0%')
  })

  it('shows the sign of a positive value when signed', () => {
    expect(formatPercent(5, { signed: true })).toBe('+5%')
    expect(formatPercent(-20, { signed: true })).toBe('-20%')
    expect(formatPercent(0.25, { signed: true })).toBe('+0.3%')
  })

  it('does not group digits', () => {
    expect(formatPercent(12345.6)).toBe('12345.6%')
  })
})

describe('plural', () => {
  it('puts the noun in the plural unless there is exactly one', () => {
    expect(plural(0, 'run')).toBe('0 runs')
    expect(plural(1, 'run')).toBe('1 run')
    expect(plural(12, 'run')).toBe('12 runs')
  })
})

describe('parseNumber', () => {
  it('reads a number in decimal notation', () => {
    expect(parseNumber('2')).toBe(2)
    expect(parseNumber('-0.5')).toBe(-0.5)
    expect(parseNumber('.5')).toBe(0.5)
    expect(parseNumber('3.')).toBe(3)
    expect(parseNumber('1e-3')).toBe(0.001)
  })

  it('rejects any other text, which Number would read as a number', () => {
    for (const text of ['', ' ', ' 1', '1 ', '0x10', 'Infinity', '1e400', '1,5', '.']) {
      expect(parseNumber(text)).toBeUndefined()
    }
  })

  it('rejects a number outside its range, its bounds included', () => {
    expect(parseNumber('0', 0, 1)).toBe(0)
    expect(parseNumber('1', 0, 1)).toBe(1)
    expect(parseNumber('-0.1', 0, 1)).toBeUndefined()
    expect(parseNumber('1.1', 0, 1)).toBeUndefined()
  })
})
