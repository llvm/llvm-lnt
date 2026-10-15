import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ShareBadge } from './share-badge'

describe('ShareBadge', () => {
  it('shows the share, colored by the heat scale', () => {
    render(<ShareBadge share={47} counter="cycles" />)

    const badge = screen.getByText('47%')
    expect(badge).toHaveAttribute('title', "Share of the profile's cycles")
    expect(badge.style.background).toBe('rgb(248, 113, 113)')
  })

  it('is grey below 1%', () => {
    render(<ShareBadge share={0.25} counter="cycles" />)

    expect(screen.getByText('0.3%').style.background).toBe('')
  })

  it('shows nothing without a share', () => {
    const { container } = render(<ShareBadge share={undefined} counter="cycles" />)

    expect(container).toBeEmptyDOMElement()
  })
})
