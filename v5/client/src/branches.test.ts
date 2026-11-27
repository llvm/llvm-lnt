import { describe, expect, it } from 'vitest'
import { branchOptions, defaultBranch, shownBranch } from './branches'

describe('defaultBranch (AR25)', () => {
  it("is the schema's default branch, if listed, and otherwise the list's first entry", () => {
    expect(defaultBranch([null, 'main', 'release/1.x'], 'main')).toBe('main')
    expect(defaultBranch([null, 'release/1.x'], 'main')).toBeNull()
    expect(defaultBranch(['dev', 'main'], 'trunk')).toBe('dev')
    expect(defaultBranch(['dev', 'main'], null)).toBe('dev')
    // A suite without commits with an ordinal lists nothing, which no branch stands for.
    expect(defaultBranch([], 'main')).toBeNull()
  })
})

describe('shownBranch', () => {
  it('is the branch asked for, if listed, and otherwise the default', () => {
    expect(shownBranch([null, 'main'], null, 'main')).toBeNull()
    expect(shownBranch([null, 'main'], 'gone', 'main')).toBe('main')
    expect(shownBranch(['main'], null, 'main')).toBe('main')
    expect(shownBranch([null, 'main'], undefined, null)).toBeNull()
  })
})

describe('branchOptions', () => {
  it("marks the schema's default branch, if listed, and only it (AR25)", () => {
    expect(branchOptions([null, 'main', 'release/1.x'], 'main')).toEqual([
      { value: '', label: 'No branch' },
      { value: 'main', label: 'main', note: 'default' },
      { value: 'release/1.x', label: 'release/1.x' },
    ])
    expect(branchOptions([null, 'release/1.x'], 'main')).toEqual([
      { value: '', label: 'No branch' },
      { value: 'release/1.x', label: 'release/1.x' },
    ])
  })
})
