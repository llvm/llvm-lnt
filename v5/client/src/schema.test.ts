import { describe, expect, it } from 'vitest'
import { commitDisplayValue, formatFieldValue, labelOf } from './schema'
import { BARE_SUITE, SUITE, commit } from './test/fixtures'

describe('labelOf', () => {
  it('uses the display name when the schema sets one', () => {
    expect(labelOf({ name: 'hardware', display_name: 'Hardware' })).toBe('Hardware')
  })

  it('falls back to the name', () => {
    expect(labelOf({ name: 'os', display_name: null })).toBe('os')
  })
})

describe('formatFieldValue', () => {
  it('shows text and numbers as they are', () => {
    expect(formatFieldValue('Apple M4', 'text')).toBe('Apple M4')
    expect(formatFieldValue(12, 'integer')).toBe('12')
    expect(formatFieldValue(0.5, 'real')).toBe('0.5')
  })

  it('shows a datetime in local time', () => {
    expect(formatFieldValue('2026-08-25T14:22:41Z', 'datetime')).toBe('2026-08-25, 2:22:41 PM')
  })

  it('shows a missing value as such', () => {
    expect(formatFieldValue(null, 'text')).toBe('--')
  })
})

describe('commitDisplayValue', () => {
  it('shows the display field when the commit has a value for it', () => {
    const c = commit('45c41247', { fields: { svn_revision: 'r554973', commit_info: null } })
    expect(commitDisplayValue(c, SUITE)).toBe('r554973')
  })

  it('shows the commit string when the commit has no value for the display field', () => {
    expect(commitDisplayValue(commit('experiment'), SUITE)).toBe('experiment')
  })

  it('shows the commit string when the schema has no display field', () => {
    expect(commitDisplayValue(commit('45c41247'), BARE_SUITE)).toBe('45c41247')
  })

  it('adds the tag, unless asked not to', () => {
    const c = commit('45c41247', {
      tag: 'llvmorg-22.1.0',
      fields: { svn_revision: 'r554973', commit_info: null },
    })
    expect(commitDisplayValue(c, SUITE)).toBe('r554973 (llvmorg-22.1.0)')
    expect(commitDisplayValue(c, SUITE, { withTag: false })).toBe('r554973')
  })
})
