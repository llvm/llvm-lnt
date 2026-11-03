import { describe, expect, it } from 'vitest'
import { suiteRef } from '../../api/suites'
import { formatShadow, MAX_SHADOWS, parseShadow, shadowParam } from './shadow-specs'

describe('the shadows in the URL (CP7, CP8)', () => {
  it("names a suite's project, the suite, a machine and a commit, apart by a slash", () => {
    const spec = { suite: suiteRef('llvm', 'nts'), machine: 'm1', commit: 'abc', runs: [] }
    expect(parseShadow('llvm/nts/m1/abc')).toEqual(spec)
    expect(formatShadow(spec)).toBe('llvm/nts/m1/abc')
  })

  it('names the runs it selects after them, apart by commas, each once and in order', () => {
    expect(parseShadow('llvm/nts/m1/abc/r2,r1,r2')).toEqual({
      suite: suiteRef('llvm', 'nts'),
      machine: 'm1',
      commit: 'abc',
      runs: ['r1', 'r2'],
    })
    expect(formatShadow(parseShadow('llvm/nts/m1/abc/r2,r1')!)).toBe('llvm/nts/m1/abc/r1,r2')
  })

  it('takes commas in a machine or a commit as part of its name', () => {
    expect(parseShadow('llvm/nts/m,1/a,b/r1')).toMatchObject({ machine: 'm,1', commit: 'a,b' })
  })

  it('is malformed with another number of parts, or an empty part or run', () => {
    for (const text of [
      'nts/m1/abc',
      'llvm/nts/m1',
      'llvm/nts/m1/abc/r1/r2',
      'llvm/nts//abc',
      '/nts/m1/abc',
      'llvm//m1/abc',
      'llvm/nts/m1/abc/',
      'llvm/nts/m1/abc/r1,,r2',
      '',
    ]) {
      expect(parseShadow(text)).toBeNull()
    }
  })

  it('drops the malformed shadows and repeats, keeping the others in order', () => {
    const parsed = shadowParam().parse(['p/b/m/c/r2,r1', 'bad', 'p/a/m/c', 'p/b/m/c/r1,r2'])
    expect(parsed?.map(formatShadow)).toEqual(['p/b/m/c/r1,r2', 'p/a/m/c'])
  })

  it('tells apart suites of the same name in two projects', () => {
    const parsed = shadowParam().parse(['p/s/m/c', 'q/s/m/c'])
    expect(parsed?.map(formatShadow)).toEqual(['p/s/m/c', 'q/s/m/c'])
  })

  it('keeps the first five shadows, once malformed ones and repeats are dropped', () => {
    const values = ['bad', 'p/s/m/c', 'p/s/m/c', ...[1, 2, 3, 4, 5].map((i) => `p/s/m/c${i}`)]
    const parsed = shadowParam().parse(values)
    expect(parsed).toHaveLength(MAX_SHADOWS)
    expect(parsed?.map(formatShadow)).toEqual([
      'p/s/m/c',
      'p/s/m/c1',
      'p/s/m/c2',
      'p/s/m/c3',
      'p/s/m/c4',
    ])
  })
})
