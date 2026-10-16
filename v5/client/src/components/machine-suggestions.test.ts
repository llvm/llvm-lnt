import { describe, expect, it } from 'vitest'
import { machine } from '../test/fixtures'
import { inPickerOrder, machineSuggestions } from './machine-suggestions'

// As the API lists them, by name.
const LISTED = [
  machine('a-retired', { tracked: false }),
  machine('b-linux'),
  machine('c-O3', { tracked: false }),
  machine('d-macos'),
]

describe('machine pickers (AR18)', () => {
  it('order the tracked machines first, then the untracked ones, each as the API lists them', () => {
    expect(inPickerOrder(LISTED).map((m) => m.name)).toEqual([
      'b-linux',
      'd-macos',
      'a-retired',
      'c-O3',
    ])
  })

  it('suggest the untracked machines under their heading, leaving out those excluded', () => {
    expect(machineSuggestions(LISTED, ['d-macos', 'c-O3'])).toEqual([
      { key: 'b-linux', text: 'b-linux' },
      { key: 'a-retired', text: 'a-retired', section: 'Untracked' },
    ])
  })
})
