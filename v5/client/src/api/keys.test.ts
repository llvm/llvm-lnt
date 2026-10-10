import { QueryObserver } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { forgetSuite } from './keys'
import { createQueryClient } from './query-client'

let unsubscribe = () => {}
afterEach(() => unsubscribe())

const SHOWN = ['suite', 'nts', 'machines', 'detail', 'm1']
const HIDDEN = ['suite', 'nts', 'runs', { machine: 'm1' }]
const OTHER_SUITE = ['suite', 'libcxx', 'runs']
const SUITES = ['suites']

/**
 * A client with a query of the suite `nts` that a page shows, one that no page shows, and queries
 * outside the suite; returns the query function of the one shown, which fetched it once.
 */
async function populated() {
  const queryClient = createQueryClient()
  const queryFn = vi.fn().mockResolvedValue('data')
  await queryClient.prefetchQuery({ queryKey: SHOWN, queryFn })
  unsubscribe = new QueryObserver(queryClient, { queryKey: SHOWN, queryFn }).subscribe(() => {})
  for (const key of [HIDDEN, OTHER_SUITE, SUITES]) queryClient.setQueryData(key, 'data')
  return { queryClient, queryFn }
}

describe('forgetSuite', () => {
  it('drops what no page shows, fetches again what a page shows, and leaves other suites alone', async () => {
    const { queryClient, queryFn } = await populated()

    await forgetSuite(queryClient, 'nts', { leaving: false })

    expect(queryClient.getQueryData(HIDDEN)).toBeUndefined()
    expect(queryFn).toHaveBeenCalledTimes(2)
    for (const key of [OTHER_SUITE, SUITES]) {
      expect(queryClient.getQueryData(key)).toBe('data')
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false)
    }
  })

  it('does not fetch again what the page about to leave shows, but marks it stale', async () => {
    const { queryClient, queryFn } = await populated()

    await forgetSuite(queryClient, 'nts', { leaving: true })

    expect(queryClient.getQueryState(SHOWN)?.isInvalidated).toBe(true)
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryData(HIDDEN)).toBeUndefined()
  })
})
