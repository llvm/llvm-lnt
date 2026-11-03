import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { REF, commit, trendPoint } from '../test/fixtures'
import { mockResolve, mockTrends } from '../test/page'
import { providers } from '../test/render'
import { useTrends } from './trends'

const QUERY = { metric: 'execution_time', machines: ['m1'], lastN: 500 }

function renderTrend() {
  return renderHook(() => useTrends(REF, QUERY), providers())
}

describe('useTrends', () => {
  it('gives the same data again when a refetch brings nothing new', async () => {
    mockTrends(() => [trendPoint('m1', 10, 1.5)])
    mockResolve([commit('commit-10')])
    const { result } = renderTrend()
    await waitFor(() => expect(result.current.data).toBeDefined())
    const first = result.current.data

    const refetched = await act(() => result.current.refetch())

    expect(refetched.data).toBe(first)
  })

  it('gives new data when a refetch brings a changed commit, keeping the items', async () => {
    mockTrends(() => [trendPoint('m1', 10, 1.5)])
    mockResolve([commit('commit-10')])
    const { result } = renderTrend()
    await waitFor(() => expect(result.current.data).toBeDefined())
    const first = result.current.data!

    mockResolve([commit('commit-10', { tag: 'llvm-22' })])
    const { data } = await act(() => result.current.refetch())

    expect(data).not.toBe(first)
    expect(data!.items).toBe(first.items)
    expect(data!.commits.get('commit-10')?.tag).toBe('llvm-22')
  })
})
