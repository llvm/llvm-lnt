import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Tabs } from './tabs'

describe('Tabs', () => {
  const TABS = [
    { id: 'a', label: 'Alpha' },
    { id: 'b', label: 'Beta' },
    { id: 'c', label: 'Gamma' },
  ] as const

  function Harness({ onSelect }: { onSelect?: (id: string) => void }) {
    const [selected, setSelected] = useState<'a' | 'b' | 'c'>('a')
    return (
      <Tabs
        label="Greek"
        tabs={TABS}
        selected={selected}
        onSelect={(id) => {
          onSelect?.(id)
          setSelected(id)
        }}
      >
        Content of {selected}
      </Tabs>
    )
  }

  it('shows the selected tab, and its content in a panel labelled by it', () => {
    render(<Harness />)

    expect(screen.getByRole('tablist', { name: 'Greek' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel', { name: 'Alpha' })).toHaveTextContent('Content of a')
  })

  it('selects a tab that is clicked', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('tab', { name: 'Beta' }))

    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tabpanel', { name: 'Beta' })).toHaveTextContent('Content of b')
  })

  it('does not select the selected tab again when it is clicked', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<Harness onSelect={onSelect} />)

    await user.click(screen.getByRole('tab', { name: 'Alpha' }))

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('moves the focus with the arrows, Home and End, wrapping around, selecting nothing', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const alpha = screen.getByRole('tab', { name: 'Alpha' })
    const gamma = screen.getByRole('tab', { name: 'Gamma' })

    await user.tab()
    expect(alpha).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(gamma).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(alpha).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(gamma).toHaveFocus()
    await user.keyboard('{Home}')
    expect(alpha).toHaveFocus()

    expect(alpha).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Content of a')
  })

  it.each(['{Enter}', ' '])('selects the focused tab with %s', async (key) => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.tab()
    await user.keyboard(`{ArrowRight}${key}`)

    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Content of b')
  })

  it('lets only the selected tab take focus with Tab', () => {
    render(<Harness />)

    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveAttribute('tabindex', '-1')
  })
})
