import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { OffsetPager } from './pagination'

describe('OffsetPager', () => {
  function renderPager(offset: number, count: number, total: number, disabled = false) {
    const onChange = vi.fn()
    render(
      <OffsetPager
        label="Things pagination"
        offset={offset}
        limit={25}
        count={count}
        total={total}
        disabled={disabled}
        onChange={onChange}
      />,
    )
    return {
      onChange,
      previous: screen.getByRole('button', { name: /Previous/ }),
      next: screen.getByRole('button', { name: /Next/ }),
    }
  }

  it('shows the range of the first page, and offers only the next one', () => {
    const { previous, next, onChange } = renderPager(0, 25, 240)

    expect(screen.getByText('1-25 of 240')).toBeInTheDocument()
    expect(previous).toBeDisabled()
    fireEvent.click(next)
    expect(onChange).toHaveBeenCalledWith(25)
  })

  it('offers only the previous page on the last one', () => {
    const { previous, next, onChange } = renderPager(225, 15, 240)

    expect(screen.getByText('226-240 of 240')).toBeInTheDocument()
    expect(next).toBeDisabled()
    fireEvent.click(previous)
    expect(onChange).toHaveBeenCalledWith(200)
  })

  it('goes back to the first page from an offset that is not a multiple of the page size', () => {
    const { previous, onChange } = renderPager(10, 25, 240)

    fireEvent.click(previous)
    expect(onChange).toHaveBeenCalledWith(0)
  })

  it('offers nothing when everything fits on one page', () => {
    const { previous, next } = renderPager(0, 2, 2)

    expect(screen.getByText('1-2 of 2')).toBeInTheDocument()
    expect(previous).toBeDisabled()
    expect(next).toBeDisabled()
  })

  it('says when nothing matches', () => {
    renderPager(0, 0, 0)

    expect(screen.getByText('0 of 0')).toBeInTheDocument()
  })

  it('offers nothing while a page is on its way', () => {
    const { previous, next } = renderPager(25, 25, 240, true)

    expect(previous).toBeDisabled()
    expect(next).toBeDisabled()
  })
})
