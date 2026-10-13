import { describe, expect, it } from 'vitest'
import type { SampleState } from '../../api/runs'
import { SUITE } from '../../test/fixtures'
import { waiting, type SideProgress } from './loading'

/** Side `id`, on libcxx's m1 at c1, with the run `1` selected and listed, unless told otherwise. */
function side(id: 'a' | 'b', overrides: Partial<SideProgress> = {}): SideProgress {
  return {
    id,
    settings: { suite: 'libcxx', machine: 'm1', commit: 'c1', runs: [] },
    schema: SUITE,
    selected: new Set(['1']),
    wanted: ['libcxx/1'],
    runs: { isError: false },
    ...overrides,
  }
}

const state = (state: Partial<SampleState>): SampleState => ({
  samples: undefined,
  error: null,
  retry: () => {},
  ...state,
})

const LOADED = new Map([['libcxx/1', state({ samples: [] })]])

const READY = {
  suitesPending: false,
  suitesFailed: false,
  offered: 1,
  metric: true,
  compared: false,
}

describe('waiting', () => {
  it('waits for the suites first', () => {
    expect(waiting(side('a'), side('b'), LOADED, { ...READY, suitesPending: true })).toEqual({
      kind: 'loading',
    })
  })

  it('shows nothing once the suites could not be listed, which is reported already', () => {
    const noSuite = side('a', { schema: undefined })
    expect(waiting(noSuite, side('b'), LOADED, { ...READY, suitesFailed: true })).toEqual({
      kind: 'failed',
    })
  })

  it('says what each side misses, side A first, then the metric', () => {
    const { settings } = side('b')
    const noMachine = side('b', { settings: { ...settings, machine: '' } })
    const noCommit = side('b', { settings: { ...settings, commit: '' } })
    const cases: [SideProgress, SideProgress, Partial<typeof READY>, string][] = [
      [side('a', { schema: undefined }), side('b'), {}, 'Select a suite for side A.'],
      [side('a'), side('b', { schema: undefined }), {}, 'Select a suite for side B.'],
      [side('a'), noMachine, {}, 'Select a machine for side B.'],
      [side('a'), noCommit, {}, 'Select a commit for side B.'],
      [side('a', { selected: new Set() }), side('b'), {}, 'Select a run for side A.'],
      [side('a'), side('b'), { offered: 0 }, 'The two suites have no metric that can be compared.'],
      [side('a'), side('b'), { metric: false }, 'Select a metric.'],
    ]
    for (const [a, b, status, text] of cases) {
      expect(waiting(a, b, LOADED, { ...READY, ...status })).toEqual({ kind: 'missing', text })
    }
  })

  it('shows nothing once what it could not load is reported', () => {
    const failed = new Map([['libcxx/1', state({ error: new Error('no') })]])
    expect(waiting(side('a'), side('b'), failed, READY)).toEqual({ kind: 'failed' })
    const unlisted = side('b', { runs: { isError: true } })
    expect(waiting(side('a'), unlisted, LOADED, READY)).toEqual({ kind: 'failed' })
  })

  it('waits for the runs, then counts the runs whose samples have arrived, each once', () => {
    const unknown = side('b', { selected: undefined })
    expect(waiting(side('a'), unknown, LOADED, READY)).toEqual({
      kind: 'loading',
      label: 'Loading runs...',
    })
    const other = side('b', { selected: new Set(['1', '2']), wanted: ['libcxx/1', 'libcxx/2'] })
    expect(waiting(side('a'), other, LOADED, READY)).toEqual({
      kind: 'loading',
      label: 'Loading samples: 1 of 2 runs...',
    })
  })

  it('waits for nothing once the comparison is computed', () => {
    expect(waiting(side('a'), side('b'), LOADED, { ...READY, compared: true })).toBeNull()
  })
})
