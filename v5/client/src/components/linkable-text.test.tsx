import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LinkableText } from './linkable-text'

describe('LinkableText', () => {
  it.each(['http://example.com', 'https://example.com/a?b=c#d', 'HTTPS://EXAMPLE.COM'])(
    'is a link opening %s in a new tab',
    (url) => {
      render(<LinkableText text={url} />)

      const link = screen.getByRole('link', { name: url })
      expect(link).toHaveAttribute('href', url)
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    },
  )

  it.each([
    'javascript:alert(1)',
    'ftp://example.com',
    'mailto:someone@example.com',
    // Accepted by a browser, but AR6 asks for the slashes.
    'https:example.com',
    'http:/x',
    'https://example.com/1 (fixed in r5)',
    'clang version 22.1.0 (https://github.com/llvm/llvm-project)',
    'PR1234',
    '',
  ])('is plain text for %j', (text) => {
    const { container } = render(<LinkableText text={text} />)

    expect(screen.queryByRole('link')).toBeNull()
    expect(container.textContent).toBe(text)
  })

  it('ignores whitespace at either end of a URL, linking to the URL alone', () => {
    const text = '  https://example.com/x\n'
    const { container } = render(<LinkableText text={text} />)

    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com/x')
    // The text itself is shown, as it is.
    expect(container.textContent).toBe(text)
  })

  it('cuts long text short, whole on hover and to assistive technology', () => {
    const text = 'abcdefghij'
    render(<LinkableText text={text} max={5} />)

    const cut = screen.getByTitle(text)
    expect(cut).toHaveTextContent(/^abcd…$/)
    expect(cut).toHaveAttribute('aria-hidden', 'true')
    screen.getByText(text)
  })

  it('leaves text that is short enough whole', () => {
    const { container } = render(<LinkableText text="abcde" max={5} />)

    expect(container.innerHTML).toBe('abcde')
  })

  it('cuts a long URL short, linking to it whole, which assistive technology reads', () => {
    const url = 'https://github.com/llvm/llvm-project/issues/1234'
    render(<LinkableText text={url} max={20} />)

    const link = screen.getByRole('link', { name: url })
    expect(link).toHaveAttribute('href', url)
    expect(link).not.toHaveAttribute('aria-hidden')
    const cut = screen.getByTitle(url)
    expect(cut).toHaveTextContent(/^https:\/\/github\.com\/…$/)
    expect(link).toContainElement(cut)
  })
})
