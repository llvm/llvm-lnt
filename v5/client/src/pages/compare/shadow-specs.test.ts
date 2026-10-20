import { describe, expect, it } from 'vitest'
import { formatShadow, MAX_SHADOWS, parseShadow, shadowParam } from './shadow-specs'

describe('the shadows in the URL (CP7, CP8)', () => {
  it('names a suite, a machine and a commit, apart by a slash', () => {
    const spec = { suite: 'nts', machine: 'm1', commit: 'abc', runs: [] }
    expect(parseShadow('nts/m1/abc')).toEqual(spec)
    expect(formatShadow(spec)).toBe('nts/m1/abc')
  })

  it('names the runs it selects after them, apart by commas, each once and in order', () => {
    expect(parseShadow('nts/m1/abc/r2,r1,r2')).toEqual({
      suite: 'nts',
      machine: 'm1',
      commit: 'abc',
      runs: ['r1', 'r2'],
    })
    expect(formatShadow(parseShadow('nts/m1/abc/r2,r1')!)).toBe('nts/m1/abc/r1,r2')
  })

  it('takes commas in a machine or a commit as part of its name', () => {
    expect(parseShadow('nts/m,1/a,b/r1')).toMatchObject({ machine: 'm,1', commit: 'a,b' })
  })

  it('is malformed with another number of parts, or an empty part or run', () => {
    for (const text of [
      'nts/m1',
      'nts/m1/abc/r1/r2',
      'nts//abc',
      'nts/m1/abc/',
      'nts/m1/abc/r1,,r2',
      '',
    ]) {
      expect(parseShadow(text)).toBeNull()
    }
  })

  it('drops the malformed shadows and repeats, keeping the others in order', () => {
    const parsed = shadowParam().parse(['b/m/c/r2,r1', 'bad', 'a/m/c', 'b/m/c/r1,r2'])
    expect(parsed?.map(formatShadow)).toEqual(['b/m/c/r1,r2', 'a/m/c'])
  })

  it('keeps the first five shadows, once malformed ones and repeats are dropped', () => {
    const values = ['bad', 's/m/c', 's/m/c', ...[1, 2, 3, 4, 5].map((i) => `s/m/c${i}`)]
    const parsed = shadowParam().parse(values)
    expect(parsed).toHaveLength(MAX_SHADOWS)
    expect(parsed?.map(formatShadow)).toEqual(['s/m/c', 's/m/c1', 's/m/c2', 's/m/c3', 's/m/c4'])
  })
})
