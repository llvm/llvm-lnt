import { describe, expect, it } from 'vitest'
import type { SuiteSchema } from '../../api/suites'
import { BARE_SUITE, metric } from '../../test/fixtures'
import { offeredMetrics } from './metrics'

const suite = (name: string, metrics: SuiteSchema['metrics']): SuiteSchema => ({
  ...BARE_SUITE,
  name,
  metrics,
})

const names = (a?: SuiteSchema, b?: SuiteSchema) => offeredMetrics(a, b).map((entry) => entry.name)

describe('offeredMetrics', () => {
  it('offers nothing without a suite', () => {
    expect(names()).toEqual([])
  })

  it('offers the numeric metrics of the one suite given, whichever side it is on', () => {
    const only = suite('one', [
      metric('time'),
      metric('size', { type: 'integer' }),
      metric('note', { type: 'text' }),
      metric('when', { type: 'datetime' }),
    ])
    expect(names(only)).toEqual(['time', 'size'])
    expect(names(undefined, only)).toEqual(['time', 'size'])
  })

  it('offers those both suites declare alike, labelled as the first labels them', () => {
    const a = suite('a', [
      metric('time', { unit: 'seconds', display_name: 'Time' }),
      metric('size', { type: 'integer' }),
      metric('score', { bigger_is_better: true }),
      metric('memory', { unit: 'bytes' }),
      metric('alone'),
    ])
    const b = suite('b', [
      metric('time', { unit: 'seconds', display_name: 'Duration' }),
      metric('size', { type: 'real' }),
      metric('score'),
      metric('memory', { unit: 'kilobytes' }),
      metric('extra'),
    ])
    expect(offeredMetrics(a, b)).toEqual([a.metrics[0], a.metrics[1]])
    expect(offeredMetrics(b, a)).toEqual([b.metrics[0], b.metrics[1]])
  })

  it('offers no metric the second suite declares as non-numeric', () => {
    const a = suite('a', [metric('value')])
    const b = suite('b', [metric('value', { type: 'text' })])
    expect(names(a, b)).toEqual([])
  })

  it('matches an unset unit only with an unset one', () => {
    const a = suite('a', [metric('time')])
    const b = suite('b', [metric('time', { unit: 'seconds' })])
    expect(names(a, b)).toEqual([])
  })
})
