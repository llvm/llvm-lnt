import { describe, expect, it } from 'vitest'
import {
  commitDisplayValue,
  defaultMetric,
  displayValueOf,
  formatFieldValue,
  formatMetricValue,
  labelOf,
  metricOptions,
  formatUnit,
} from './schema'
import { BARE_SUITE, SUITE, commit, metric } from './test/fixtures'

describe('labelOf', () => {
  it('uses the display name when the schema sets one', () => {
    expect(labelOf({ name: 'hardware', display_name: 'Hardware' })).toBe('Hardware')
  })

  it('falls back to the name', () => {
    expect(labelOf({ name: 'os', display_name: null })).toBe('os')
  })
})

describe('formatUnit', () => {
  const metric = SUITE.metrics[0]

  it('writes the unit and its abbreviation, as much of either as is set', () => {
    expect(formatUnit(metric)).toBe('seconds (s)')
    expect(formatUnit({ ...metric, unit_abbrev: null })).toBe('seconds')
    expect(formatUnit({ ...metric, unit: null })).toBe('(s)')
  })

  it('writes the unit once when its abbreviation is identical', () => {
    expect(formatUnit({ ...metric, unit: 'cycles', unit_abbrev: 'cycles' })).toBe('cycles')
    expect(formatUnit({ ...metric, unit: 'Cycles', unit_abbrev: 'cycles' })).toBe('Cycles (cycles)')
  })

  it('is null when neither is set', () => {
    expect(formatUnit({ ...metric, unit: null, unit_abbrev: null })).toBeNull()
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

describe('displayValueOf', () => {
  const resolved = commit('45c41247', { fields: { svn_revision: 'r554973', commit_info: null } })
  const commits = new Map([['45c41247', resolved]])

  it('is the display value of the commit resolved', () => {
    expect(displayValueOf('45c41247', commits, SUITE)).toBe('r554973')
  })

  it('is the commit string while the commit is not resolved, with the tag given, if any', () => {
    expect(displayValueOf('abc', commits, SUITE)).toBe('abc')
    expect(displayValueOf('abc', undefined, SUITE, 'llvm-22')).toBe('abc (llvm-22)')
  })
})

describe('defaultMetric', () => {
  it('is the first numeric metric, in schema order', () => {
    const metrics = [
      metric('status', { type: 'text' }),
      metric('size', { type: 'integer' }),
      metric('time'),
    ]
    expect(defaultMetric({ ...BARE_SUITE, metrics })?.name).toBe('size')
  })

  it('is the first metric when none is numeric, and none without metrics', () => {
    const metrics = [metric('status', { type: 'text' }), metric('when', { type: 'datetime' })]
    expect(defaultMetric({ ...BARE_SUITE, metrics })?.name).toBe('status')
    expect(defaultMetric(BARE_SUITE)).toBeUndefined()
  })
})

describe('formatMetricValue', () => {
  it('shows a real to 4 significant digits, and an integer in full', () => {
    expect(formatMetricValue(1.2643218, metric('time'))).toBe('1.264')
    expect(formatMetricValue(1234567891, metric('size', { type: 'integer' }))).toBe('1234567891')
  })

  it('shows text as it is, a timestamp in local time, and a missing value as such', () => {
    expect(formatMetricValue('ok', metric('status', { type: 'text' }))).toBe('ok')
    expect(formatMetricValue('2026-08-25T14:22:41Z', metric('when', { type: 'datetime' }))).toBe(
      '2026-08-25, 2:22:41 PM',
    )
    expect(formatMetricValue(undefined, metric('time'))).toBe('--')
  })
})

describe('metricOptions', () => {
  it('offers every metric, in schema order, by label', () => {
    const metrics = [metric('time', { display_name: 'Time' }), metric('size', { type: 'integer' })]
    expect(metricOptions({ ...BARE_SUITE, metrics })).toEqual([
      { value: 'time', label: 'Time' },
      { value: 'size', label: 'size' },
    ])
  })
})
