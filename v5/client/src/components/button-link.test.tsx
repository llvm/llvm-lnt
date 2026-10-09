import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderWithProviders } from '../test/render'
import { ButtonLink } from './button-link'

describe('ButtonLink', () => {
  it('is a link while it leads somewhere', () => {
    renderWithProviders(
      <ButtonLink to="/compare?suite_a=nts" title="Compare them">
        Compare
      </ButtonLink>,
    )

    const link = screen.getByRole('link', { name: 'Compare' })
    expect(link).toHaveAttribute('href', '/compare?suite_a=nts')
    expect(link).not.toHaveAttribute('aria-disabled')
  })

  it('is disabled text, focusable and saying why, while it leads nowhere', () => {
    renderWithProviders(
      <ButtonLink to={null} title="No commit comes before it.">
        Compare
      </ButtonLink>,
    )

    const link = screen.getByRole('link', { name: 'Compare' })
    expect(link.tagName).not.toBe('A')
    expect(link).not.toHaveAttribute('href')
    expect(link).toHaveAttribute('aria-disabled', 'true')
    expect(link).toHaveAttribute('tabindex', '0')
    expect(link).toHaveAccessibleDescription('No commit comes before it.')
  })
})
