import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RegressionState } from '../regression-states'
import { StateBadge, StateChips } from './regression-state'

describe('StateBadge', () => {
  it('shows the state in words, coloured by state', () => {
    render(<StateBadge state="not_to_be_fixed" />)

    expect(screen.getByText('not to be fixed')).toHaveClass('badge', 'notToBeFixed')
  })
})

describe('StateChips', () => {
  function Harness() {
    const [selected, setSelected] = useState<RegressionState[]>([])
    return (
      <>
        <StateChips selected={selected} onChange={setSelected} />
        <output>{selected.join(',')}</output>
      </>
    )
  }

  it('offers every state, none selected', () => {
    render(<Harness />)

    const chips = within(screen.getByRole('group', { name: 'State' })).getAllByRole('button')
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'detected',
      'active',
      'not to be fixed',
      'fixed',
      'false positive',
    ])
    expect(chips.every((chip) => chip.getAttribute('aria-pressed') === 'false')).toBe(true)
  })

  it('toggles states, keeping them in the order they are offered', () => {
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: 'fixed' }))
    fireEvent.click(screen.getByRole('button', { name: 'detected' }))
    expect(screen.getByRole('status')).toHaveTextContent('detected,fixed')
    expect(screen.getByRole('button', { name: 'fixed' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'fixed' }))
    expect(screen.getByRole('status')).toHaveTextContent(/^detected$/)
  })
})
