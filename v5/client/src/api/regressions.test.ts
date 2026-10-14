import { describe, expect, it } from 'vitest'
import { regression, uuidOf } from '../test/fixtures'
import { mockResolveRegressions } from '../test/page'
import { resolveRegressions } from './regressions'

describe('resolveRegressions', () => {
  it('returns an empty map for an empty array without making a request', async () => {
    const result = await resolveRegressions('libcxx', [])
    expect(result.size).toBe(0)
  })

  it('resolves distinct regression UUIDs and keys results by UUID', async () => {
    const r1 = regression('1', { title: 'Slowdown 1' })
    const r2 = regression('2', { title: 'Slowdown 2' })
    const requests = mockResolveRegressions([r1, r2])

    const result = await resolveRegressions('libcxx', [
      uuidOf('1'),
      uuidOf('1'),
      uuidOf('2'),
      uuidOf('3'),
    ])

    expect(requests).toEqual([[uuidOf('1'), uuidOf('2'), uuidOf('3')]])
    expect(result.size).toBe(2)
    expect(result.get(uuidOf('1'))?.title).toBe('Slowdown 1')
    expect(result.get(uuidOf('2'))?.title).toBe('Slowdown 2')
    expect(result.get(uuidOf('3'))).toBeUndefined()
  })
})
