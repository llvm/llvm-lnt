import { describe, expect, it } from 'vitest'
import { run, uuidOf } from '../../test/fixtures'
import { runChoice, sideStatus, testChoice } from './selection'

describe('runChoice', () => {
  const runs = [run('1'), run('2')]

  it('keeps a run that is listed', () => {
    expect(runChoice(runs, run('1').uuid)).toBe(run('1').uuid)
  })

  it('selects the latest run in place of none, or of one that is not listed', () => {
    expect(runChoice(runs, '')).toBe(run('2').uuid)
    expect(runChoice(runs, run('9').uuid)).toBe(run('2').uuid)
  })

  it('selects none among no runs', () => {
    expect(runChoice([], run('1').uuid)).toBe('')
  })
})

describe('testChoice', () => {
  const tests = new Set(['alpha', 'beta'])

  it('keeps a test the run has a profile of', () => {
    expect(testChoice(tests, 'alpha', 'beta', false)).toBe('alpha')
    expect(testChoice(tests, 'alpha', 'beta', true)).toBe('alpha')
  })

  it("takes the other side's test only while the user's picks change the profile", () => {
    expect(testChoice(tests, 'gamma', 'beta', true)).toBe('beta')
    expect(testChoice(tests, '', 'beta', true)).toBe('beta')
    expect(testChoice(tests, 'gamma', 'beta', false)).toBe('')
    expect(testChoice(tests, '', 'beta', false)).toBe('')
  })

  it("has none when the run has a profile of neither the side's test nor the other's", () => {
    expect(testChoice(tests, 'gamma', 'delta', true)).toBe('')
  })
})

describe('sideStatus', () => {
  const run = uuidOf('1')
  const profile = {
    uuid: 'p',
    test: 'alpha',
    run_uuid: run,
    counters: {},
    disassembly_format: 'llvm-objdump',
  }
  const base = {
    test: 'alpha',
    run,
    runPick: run,
    runsFailed: false,
    profiles: { data: [], error: null },
    testPick: 'alpha',
    uuid: 'p',
    metadata: { data: profile, error: null },
  }
  const boom = new Error('Boom')

  it('is none without a test', () => {
    expect(sideStatus({ ...base, test: '' })).toEqual({ kind: 'none' })
  })

  it('shows the profile once everything it depends on has arrived', () => {
    expect(sideStatus(base)).toEqual({ kind: 'shown', uuid: 'p', profile })
  })

  it('is pending while anything the profile depends on is on its way', () => {
    const pending = { kind: 'pending' }
    // The runs are not listed, or the run is about to be replaced by the latest.
    expect(sideStatus({ ...base, runPick: undefined })).toEqual(pending)
    expect(sideStatus({ ...base, runPick: uuidOf('2') })).toEqual(pending)
    expect(sideStatus({ ...base, profiles: { data: undefined, error: null } })).toEqual(pending)
    // The test is about to be replaced, or dropped.
    expect(sideStatus({ ...base, testPick: 'beta' })).toEqual(pending)
    expect(sideStatus({ ...base, metadata: { data: undefined, error: null } })).toEqual(pending)
  })

  it('fails when anything the profile depends on could not be fetched', () => {
    const failed = { kind: 'failed' }
    expect(sideStatus({ ...base, runPick: undefined, runsFailed: true })).toEqual(failed)
    expect(sideStatus({ ...base, profiles: { data: undefined, error: boom } })).toEqual(failed)
    expect(sideStatus({ ...base, metadata: { data: undefined, error: boom } })).toEqual(failed)
  })

  it("reports no failure of the profiles of a run that is not the side's", () => {
    expect(
      sideStatus({ ...base, runPick: uuidOf('2'), profiles: { data: undefined, error: boom } }),
    ).toEqual({ kind: 'pending' })
  })
})
