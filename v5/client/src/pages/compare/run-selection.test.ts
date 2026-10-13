import { describe, expect, it } from 'vitest'
import { runsParam, selectedRuns } from './run-selection'

const RUNS = ['1', '2', '3']
const sorted = (runs: ReadonlySet<string> | undefined) => runs && [...runs].sort()

describe('selectedRuns', () => {
  it('is unknown until the runs are listed, then selects every run', () => {
    expect(selectedRuns(undefined, ['2'], false)).toBeUndefined()
    expect(sorted(selectedRuns(RUNS, [], false))).toEqual(RUNS)
  })

  it('selects the runs the URL names that are listed, or else every run', () => {
    expect(sorted(selectedRuns(RUNS, ['3', '9'], false))).toEqual(['3'])
    expect(sorted(selectedRuns(RUNS, ['9'], false))).toEqual(RUNS)
  })

  it('selects none once the user has deselected every run', () => {
    expect(sorted(selectedRuns(RUNS, [], true))).toEqual([])
  })
})

describe('runsParam', () => {
  it('leaves out every run, and none, which is the default', () => {
    expect(runsParam(RUNS, new Set(RUNS))).toEqual([])
    expect(runsParam(RUNS, new Set(['3', '1']))).toEqual(['1', '3'])
  })
})
