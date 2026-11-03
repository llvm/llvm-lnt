import { describe, expect, it } from 'vitest'
import { commitChanged, commitKey, resolvedCommitKey } from './commits'
import { queryKeys } from './keys'
import { createQueryClient } from './query-client'
import { runKey } from './runs'
import { suiteRef } from './suites'

const LIBCXX = suiteRef('llvm', 'libcxx')

const PAGE = { items: [], cursor: { next: null, previous: null } }
/** A page of a list that `withCommits` resolved the commits of. */
const PAGE_WITH_COMMITS = { ...PAGE, commits: new Map() }

/** Cached queries, by what they hold, with their key and data. */
const SHOWING_COMMITS: [string, readonly unknown[], unknown][] = [
  ['the commit', commitKey(LIBCXX, 'abc'), PAGE],
  ['its resolution', resolvedCommitKey(LIBCXX, 'abc'), PAGE],
  ['a list of commits', [...queryKeys.commits(LIBCXX), { sort: '-first_seen' }], PAGE],
  ['a page of runs', [...queryKeys.runs(LIBCXX), { sort: '-submitted_at' }], PAGE_WITH_COMMITS],
  ['a page of regressions', [...queryKeys.regressions(LIBCXX), {}], PAGE_WITH_COMMITS],
  // Placed and windowed by ordinals, whether or not it holds its commits.
  ['a trend', [...queryKeys.trends(LIBCXX), { metric: 'm' }], { items: [] }],
]
const NOT_SHOWING_COMMITS: [string, readonly unknown[], unknown][] = [
  ['a run', runKey(LIBCXX, 'r1'), {}],
  ['a run’s samples', [...runKey(LIBCXX, 'r1'), 'samples'], { pages: [PAGE] }],
  [
    'a page of regressions without commits',
    [...queryKeys.regressions(LIBCXX), 'without commits', {}],
    PAGE,
  ],
  ['the machines', [...queryKeys.machines(LIBCXX), {}], []],
  ['a commit of another suite', commitKey(suiteRef('llvm', 'nts'), 'abc'), PAGE],
  [
    'a commit of a suite of the same name in another project',
    commitKey(suiteRef('other', 'libcxx'), 'abc'),
    PAGE,
  ],
]

/** Whether the query `key` is stale once a commit of libcxx has changed, all of them cached. */
async function staleAfterChange(key: readonly unknown[]) {
  const queryClient = createQueryClient()
  for (const [, cached, data] of [...SHOWING_COMMITS, ...NOT_SHOWING_COMMITS]) {
    queryClient.setQueryData(cached, data)
  }
  await commitChanged(queryClient, LIBCXX)
  return queryClient.getQueryState(key)?.isInvalidated
}

describe('commitChanged', () => {
  it.each(SHOWING_COMMITS)('marks %s stale', async (_, key) => {
    expect(await staleAfterChange(key)).toBe(true)
  })

  it.each(NOT_SHOWING_COMMITS)('leaves %s alone', async (_, key) => {
    expect(await staleAfterChange(key)).toBe(false)
  })
})
