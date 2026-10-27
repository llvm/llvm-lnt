import { describe, expect, it } from 'vitest'
import { FIELD_EDITING } from './fields'

describe('FIELD_EDITING', () => {
  const valid = (type: keyof typeof FIELD_EDITING, text: string) =>
    FIELD_EDITING[type].invalid?.(text) === undefined

  it('takes any text for a text field, as typed, on several lines', () => {
    expect(valid('text', 'a\nb')).toBe(true)
    expect(FIELD_EDITING.text.parse('a\nb')).toBe('a\nb')
    expect(FIELD_EDITING.text.multiline).toBe(true)
  })

  it('takes the integers a browser holds exactly for an integer field', () => {
    for (const text of ['0', '-12', '9007199254740991', '-9007199254740991']) {
      expect(valid('integer', text)).toBe(true)
    }
    for (const text of ['1.5', '8.0', '1e3', '+1', '0x10', '9007199254740992', '9'.repeat(400)]) {
      expect(valid('integer', text)).toBe(false)
    }
    expect(FIELD_EDITING.integer.parse('-12')).toBe(-12)
    expect(FIELD_EDITING.integer.text(64)).toBe('64')
  })

  it('takes a finite number in decimal notation for a real field', () => {
    for (const text of ['1.5', '-.5', '2e-3', '1e+21', '7']) {
      expect(valid('real', text)).toBe(true)
    }
    for (const text of ['NaN', 'Infinity', '1e400', '0x10', '1,5', 'one']) {
      expect(valid('real', text)).toBe(false)
    }
    expect(FIELD_EDITING.real.parse('2e-3')).toBe(0.002)
    // What a value opens as is taken back.
    expect(valid('real', FIELD_EDITING.real.text(1e21))).toBe(true)
    expect(valid('real', FIELD_EDITING.real.text(1e-7))).toBe(true)
  })

  // The tests run in UTC (see vite.config.ts), whose offset is +00:00.
  it('takes a date and time with an offset for a datetime field, as typed', () => {
    for (const text of [
      '2026-08-25T14:22:41Z',
      '2026-08-25T14:22:41-04:00',
      '2026-08-25 14:22+02:00',
      '2026-08-25T14:22:41.123456+00:00',
    ]) {
      expect(valid('datetime', text)).toBe(true)
    }
    for (const text of [
      '2026-08-25T14:22:41',
      '2026-08-25',
      '2026-08-25, 2:22:41 PM',
      '2026-08-25T14:22:41-0400',
      '1700000000',
    ]) {
      expect(valid('datetime', text)).toBe(false)
    }
    expect(FIELD_EDITING.datetime.parse('2026-08-25 14:22+02:00')).toBe('2026-08-25 14:22+02:00')
    expect(FIELD_EDITING.datetime.text('2026-08-25T14:22:41Z')).toBe('2026-08-25T14:22:41+00:00')
  })
})
