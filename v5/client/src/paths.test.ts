import { describe, expect, it } from 'vitest'
import { comparePath, graphPath, profilesPath } from './paths'

describe('comparePath', () => {
  it('sets what is given of side A only', () => {
    expect(comparePath({ suite: 'nts', machine: 'm&1' })).toBe(
      '/compare?suite_a=nts&machine_a=m%261',
    )
    expect(comparePath()).toBe('/compare')
  })

  it('sets both sides, their runs one parameter each, and the metric, with CP7 names', () => {
    const path = comparePath(
      { suite: 'nts', machine: 'm1', commit: 'abc', runs: ['r1', 'r2'] },
      { suite: 'nts', machine: 'm1', commit: 'def', runs: ['r3'] },
      'execution_time',
    )
    expect(path).toBe(
      '/compare?suite_a=nts&machine_a=m1&commit_a=abc&runs_a=r1&runs_a=r2' +
        '&suite_b=nts&machine_b=m1&commit_b=def&runs_b=r3&metric=execution_time',
    )
  })

  it("sets each side's run aggregation and the sample aggregation, with CP7 names", () => {
    const path = comparePath(
      { suite: 'nts', commit: 'abc', runAgg: 'max' },
      { suite: 'nts', commit: 'def', runAgg: 'max' },
      'execution_time',
      'min',
    )
    expect(path).toBe(
      '/compare?suite_a=nts&commit_a=abc&run_agg_a=max&suite_b=nts&commit_b=def&run_agg_b=max' +
        '&metric=execution_time&sample_agg=min',
    )
  })
})

describe('graphPath', () => {
  it('sets what is given, with GR14 names and a test name of any characters', () => {
    expect(graphPath()).toBe('/graph')
    expect(graphPath({ suite: 'nts', machines: ['m1'] })).toBe('/graph?suite=nts&machine=m1')
    expect(
      graphPath({
        suite: 'nts',
        machines: ['m1'],
        metric: 'execution_time',
        test: 'a/b c&d',
        regressions: 'all',
      }),
    ).toBe('/graph?suite=nts&machine=m1&metric=execution_time&test=a%2Fb+c%26d&regressions=all')
  })

  it('repeats the machine parameter once per machine, in order', () => {
    expect(graphPath({ suite: 'nts', machines: ['m2', 'm&1'], metric: 'score' })).toBe(
      '/graph?suite=nts&machine=m2&machine=m%261&metric=score',
    )
  })
})

describe('profilesPath', () => {
  it('sets side A, with a test name of any characters', () => {
    expect(profilesPath({ suite: 'nts', run: 'uuid-1', test: 'a/b c&d' })).toBe(
      '/profiles?suite_a=nts&run_a=uuid-1&test_a=a%2Fb+c%26d',
    )
  })
})
