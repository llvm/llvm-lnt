import { QueryObserver } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { forgetSuite, forgetUnobserved } from './keys'
import { createQueryClient } from './query-client'
import { suiteRef } from './suites'

let unsubscribe = () => {}
afterEach(() => unsubscribe())

const NTS = suiteRef('llvm', 'nts')
const SHOWN = ['suite', 'llvm', 'nts', 'machines', 'detail', 'm1']
const HIDDEN = ['suite', 'llvm', 'nts', 'runs', { machine: 'm1' }]
const OTHER_SUITE = ['suite', 'llvm', 'libcxx', 'runs']
// A suite of the same name in another project is another suite.
const OTHER_PROJECT = ['suite', 'other', 'nts', 'runs']
const SUITES = ['projects']

/**
 * A client with a query of the suite `llvm/nts` that a page shows, one that no page shows, and queries
 * outside the suite; returns the query function of the one shown, which fetched it once.
 */
async function populated() {
  const queryClient = createQueryClient()
  const queryFn = vi.fn().mockResolvedValue('data')
  await queryClient.prefetchQuery({ queryKey: SHOWN, queryFn })
  unsubscribe = new QueryObserver(queryClient, { queryKey: SHOWN, queryFn }).subscribe(() => {})
  for (const key of [HIDDEN, OTHER_SUITE, OTHER_PROJECT, SUITES])
    queryClient.setQueryData(key, 'data')
  return { queryClient, queryFn }
}

describe('forgetSuite', () => {
  it('drops what no page shows, fetches again what a page shows, and leaves other suites alone', async () => {
    const { queryClient, queryFn } = await populated()

    await forgetSuite(queryClient, NTS, { leaving: false })

    expect(queryClient.getQueryData(HIDDEN)).toBeUndefined()
    expect(queryFn).toHaveBeenCalledTimes(2)
    for (const key of [OTHER_SUITE, OTHER_PROJECT, SUITES]) {
      expect(queryClient.getQueryData(key)).toBe('data')
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false)
    }
  })

  it('does not fetch again what the page about to leave shows, but marks it stale', async () => {
    const { queryClient, queryFn } = await populated()

    await forgetSuite(queryClient, NTS, { leaving: true })

    expect(queryClient.getQueryState(SHOWN)?.isInvalidated).toBe(true)
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryData(HIDDEN)).toBeUndefined()
  })
})

describe('forgetUnobserved', () => {
  it('drops what nothing observes, keeps what only a disabled observer reads, and leaves other suites alone', async () => {
    const { queryClient } = await populated()
    const DISABLED = ['suite', 'llvm', 'nts', 'regressions', 'detail', 'r1']
    queryClient.setQueryData(DISABLED, 'data')
    new QueryObserver(queryClient, { queryKey: DISABLED, enabled: false }).subscribe(() => {})

    forgetUnobserved(queryClient, NTS)

    expect(queryClient.getQueryData(HIDDEN)).toBeUndefined()
    for (const key of [SHOWN, DISABLED, OTHER_SUITE, OTHER_PROJECT, SUITES]) {
      expect(queryClient.getQueryData(key)).toBe('data')
    }
  })
})
