import { describe, expect, it } from 'vitest'
import { commitChanged, commitKey, resolvedCommitKey } from './commits'
import { queryKeys } from './keys'
import { createQueryClient } from './query-client'
import { runKey } from './runs'

const PAGE = { items: [], cursor: { next: null, previous: null } }
/** A page of a list that `withCommits` resolved the commits of. */
const PAGE_WITH_COMMITS = { ...PAGE, commits: new Map() }

/** Cached queries, by what they hold, with their key and data. */
const SHOWING_COMMITS: [string, readonly unknown[], unknown][] = [
  ['the commit', commitKey('libcxx', 'abc'), PAGE],
  ['its resolution', resolvedCommitKey('libcxx', 'abc'), PAGE],
  ['a list of commits', [...queryKeys.commits('libcxx'), { sort: '-first_seen' }], PAGE],
  ['a page of runs', [...queryKeys.runs('libcxx'), { sort: '-submitted_at' }], PAGE_WITH_COMMITS],
  ['a page of regressions', [...queryKeys.regressions('libcxx'), {}], PAGE_WITH_COMMITS],
]
const NOT_SHOWING_COMMITS: [string, readonly unknown[], unknown][] = [
  ['a run', runKey('libcxx', 'r1'), {}],
  ['a run’s samples', [...runKey('libcxx', 'r1'), 'samples'], { pages: [PAGE] }],
  [
    'a page of regressions without commits',
    [...queryKeys.regressions('libcxx'), 'without commits', {}],
    PAGE,
  ],
  ['the machines', [...queryKeys.machines('libcxx'), {}], []],
  ['a commit of another suite', commitKey('nts', 'abc'), PAGE],
]

/** Whether the query `key` is stale once a commit of libcxx has changed, all of them cached. */
async function staleAfterChange(key: readonly unknown[]) {
  const queryClient = createQueryClient()
  for (const [, cached, data] of [...SHOWING_COMMITS, ...NOT_SHOWING_COMMITS]) {
    queryClient.setQueryData(cached, data)
  }
  await commitChanged(queryClient, 'libcxx')
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
