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
  it('order the tracked machines first, then the untracked ones, each by label', () => {
    expect(inPickerOrder(LISTED).map((m) => m.name)).toEqual([
      'b-linux',
      'd-macos',
      'a-retired',
      'c-O3',
    ])
    // AR23: by label, case-insensitively, then by name.
    const labelled = [
      machine('x', { display_name: 'zeta' }),
      machine('b', { display_name: 'Alpha' }),
      machine('a', { display_name: 'alpha' }),
      machine('m'),
    ]
    expect(inPickerOrder(labelled).map((m) => m.name)).toEqual(['a', 'b', 'm', 'x'])
  })

  it('suggest the untracked machines under their heading, leaving out those excluded', () => {
    expect(machineSuggestions(LISTED, ['d-macos', 'c-O3'])).toEqual([
      { key: 'b-linux', text: 'b-linux' },
      { key: 'a-retired', text: 'a-retired', section: 'Untracked' },
    ])
  })

  it('show a machine by its label, followed by its name, by which it is found too (AR23)', () => {
    const named = [
      machine('linux-1', { display_name: 'Linux / x86' }),
      machine('linux-2', { display_name: 'Linux / x86', tracked: false }),
    ]
    // Two machines with the same label stay two suggestions, told apart by their names.
    expect(machineSuggestions(named)).toEqual([
      { key: 'linux-1', text: 'Linux / x86', aliases: ['linux-1'], note: 'linux-1' },
      {
        key: 'linux-2',
        text: 'Linux / x86',
        aliases: ['linux-2'],
        note: 'linux-2',
        section: 'Untracked',
      },
    ])
  })
})
