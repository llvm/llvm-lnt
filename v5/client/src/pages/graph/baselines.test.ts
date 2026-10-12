import { describe, expect, it } from 'vitest'
import { baselineParam, formatBaseline, parseBaseline } from './baselines'

describe('the baselines in the URL (GR9, GR14)', () => {
  it('names a suite, a machine and a commit, apart by a slash', () => {
    const baseline = { suite: 'nts', machine: 'm1', commit: 'abc' }
    expect(parseBaseline('nts/m1/abc')).toEqual(baseline)
    expect(formatBaseline(baseline)).toBe('nts/m1/abc')
  })

  it('is malformed with another number of names, or an empty one', () => {
    for (const text of ['nts/m1', 'nts/m1/abc/def', 'nts//abc', '']) {
      expect(parseBaseline(text)).toBeNull()
    }
  })

  it('drops the malformed baselines and repeats of the URL, keeping the others in order', () => {
    expect(baselineParam().parse(['b/m/c', 'bad', 'a/m/c', 'b/m/c'])).toEqual(['b/m/c', 'a/m/c'])
  })
})
