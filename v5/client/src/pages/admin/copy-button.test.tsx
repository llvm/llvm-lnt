import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockClipboard } from '../../test/clipboard'
import { CopyButton, FEEDBACK_MS } from './copy-button'

function button() {
  return screen.getByRole('button')
}

describe('CopyButton', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('copies its text, and says so for a while in place of its label', async () => {
    const writeText = mockClipboard()
    render(<CopyButton text="the token">Copy to clipboard</CopyButton>)

    await act(async () => fireEvent.click(button()))

    expect(writeText).toHaveBeenCalledWith('the token')
    expect(button()).toHaveAccessibleName('Copied.')
    expect(screen.getByRole('status')).toHaveTextContent('Copied.')
    await act(async () => vi.advanceTimersByTime(FEEDBACK_MS))
    expect(button()).toHaveAccessibleName('Copy to clipboard')
    expect(screen.getByRole('status')).toHaveTextContent('')
  })

  it('says that it could not copy when the browser refuses', async () => {
    mockClipboard(() => Promise.reject(new Error('Denied')))
    render(<CopyButton text="the token">Copy to clipboard</CopyButton>)

    await act(async () => fireEvent.click(button()))

    expect(button()).toHaveAccessibleName('Could not copy.')
    expect(screen.getByRole('status')).toHaveTextContent('Could not copy.')
  })

  it('says that it could not copy when the page has no clipboard, as over plain HTTP', async () => {
    render(<CopyButton text="the token">Copy to clipboard</CopyButton>)

    await act(async () => fireEvent.click(button()))

    expect(screen.getByRole('status')).toHaveTextContent('Could not copy.')
  })
})
