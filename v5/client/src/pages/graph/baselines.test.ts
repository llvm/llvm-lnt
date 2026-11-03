import { describe, expect, it } from 'vitest'
import { suiteRef } from '../../api/suites'
import { baselineParam, formatBaseline, parseBaseline } from './baselines'

describe('the baselines in the URL (GR9, GR14)', () => {
  it("names a suite's project, the suite, a machine and a commit, apart by a slash", () => {
    const baseline = { suite: suiteRef('llvm', 'nts'), machine: 'm1', commit: 'abc' }
    expect(parseBaseline('llvm/nts/m1/abc')).toEqual(baseline)
    expect(formatBaseline(baseline)).toBe('llvm/nts/m1/abc')
  })

  it('is malformed with another number of names, or an empty one', () => {
    for (const text of ['nts/m1/abc', 'llvm/nts/m1/abc/def', 'llvm/nts//abc', '/nts/m1/abc', '']) {
      expect(parseBaseline(text)).toBeNull()
    }
  })

  it('drops the malformed baselines and repeats of the URL, keeping the others in order', () => {
    expect(baselineParam().parse(['p/b/m/c', 'bad', 'p/a/m/c', 'p/b/m/c'])).toEqual([
      'p/b/m/c',
      'p/a/m/c',
    ])
  })
})
