import { describe, expect, it } from 'vitest'
import { formatTimestamp, shortUuid } from './format'

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
