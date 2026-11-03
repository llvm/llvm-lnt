import { describe, expect, it } from 'vitest'
import { suiteRef } from './api/suites'
import { comparePath, graphPath, machinePath, profilesPath, projectPath, suitePath } from './paths'

describe('suitePath', () => {
  it("nests a suite's pages under its project's, every name encoded", () => {
    expect(projectPath('a b')).toBe('/projects/a%20b')
    expect(suitePath(suiteRef('llvm', 'n?ts'))).toBe('/projects/llvm/suites/n%3Fts')
    expect(machinePath(suiteRef('llvm', 'nts'), 'm/1')).toBe(
      '/projects/llvm/suites/nts/machines/m%2F1',
    )
  })
})

describe('comparePath', () => {
  it('sets what is given of side A only', () => {
    expect(comparePath({ suite: suiteRef('llvm', 'nts'), machine: 'm&1' })).toBe(
      '/compare?project_a=llvm&suite_a=nts&machine_a=m%261',
    )
    expect(comparePath()).toBe('/compare')
  })

  it('sets both sides, their runs one parameter each, and the metric, with CP7 names', () => {
    const path = comparePath(
      { suite: suiteRef('llvm', 'nts'), machine: 'm1', commit: 'abc', runs: ['r1', 'r2'] },
      { suite: suiteRef('llvm', 'nts'), machine: 'm1', commit: 'def', runs: ['r3'] },
      { metric: 'execution_time' },
    )
    expect(path).toBe(
      '/compare?project_a=llvm&suite_a=nts&machine_a=m1&commit_a=abc&runs_a=r1&runs_a=r2' +
        '&project_b=llvm&suite_b=nts&machine_b=m1&commit_b=def&runs_b=r3&metric=execution_time',
    )
  })

  it('sets the run and sample aggregations, with CP7 names', () => {
    const path = comparePath(
      { suite: suiteRef('llvm', 'nts'), commit: 'abc' },
      { suite: suiteRef('llvm', 'nts'), commit: 'def' },
      { metric: 'execution_time', sampleAgg: 'min', runAgg: 'max' },
    )
    expect(path).toBe(
      '/compare?project_a=llvm&suite_a=nts&commit_a=abc&project_b=llvm&suite_b=nts&commit_b=def' +
        '&metric=execution_time&run_agg=max&sample_agg=min',
    )
  })
})

describe('graphPath', () => {
  it('sets what is given, with GR14 names and a test name of any characters', () => {
    expect(graphPath()).toBe('/graph')
    expect(graphPath({ suite: suiteRef('llvm', 'nts'), machines: ['m1'] })).toBe(
      '/graph?project=llvm&suite=nts&machine=m1',
    )
    expect(
      graphPath({
        suite: suiteRef('llvm', 'nts'),
        machines: ['m1'],
        metric: 'execution_time',
        test: 'a/b c&d',
        regressions: 'all',
      }),
    ).toBe(
      '/graph?project=llvm&suite=nts&machine=m1&metric=execution_time&test=a%2Fb+c%26d&regressions=all',
    )
  })

  it('sets the run and sample aggregations, with GR14 names', () => {
    expect(
      graphPath({ suite: suiteRef('llvm', 'nts'), test: 't', sampleAgg: 'min', runAgg: 'max' }),
    ).toBe('/graph?project=llvm&suite=nts&test=t&run_agg=max&sample_agg=min')
  })

  it('repeats the highlighted commits (GR16), each once, encoded', () => {
    expect(
      graphPath({ suite: suiteRef('llvm', 'nts'), test: 't', highlight: ['abc#1', 'def', 'def'] }),
    ).toBe('/graph?project=llvm&suite=nts&test=t&highlight=abc%231&highlight=def')
  })

  it('repeats the machine parameter once per machine, in order', () => {
    expect(
      graphPath({ suite: suiteRef('llvm', 'nts'), machines: ['m2', 'm&1'], metric: 'score' }),
    ).toBe('/graph?project=llvm&suite=nts&machine=m2&machine=m%261&metric=score')
  })
})

describe('profilesPath', () => {
  it('sets side A, with a test name of any characters', () => {
    expect(
      profilesPath({
        suite: suiteRef('llvm', 'nts'),
        machine: 'm',
        commit: 'c',
        run: 'uuid-1',
        test: 'a/b c&d',
      }),
    ).toBe(
      '/profiles?project_a=llvm&suite_a=nts&machine_a=m&commit_a=c&run_a=uuid-1&test_a=a%2Fb+c%26d',
    )
  })

  it('sets side B after side A', () => {
    expect(
      profilesPath(
        { suite: suiteRef('llvm', 'nts'), run: 'u1', test: 't' },
        { suite: suiteRef('llvm', 'x'), commit: 'c2' },
      ),
    ).toBe(
      '/profiles?project_a=llvm&suite_a=nts&run_a=u1&test_a=t&project_b=llvm&suite_b=x&commit_b=c2',
    )
  })
})
