import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Category } from './comparison'
import { SummaryBar } from './summary-bar'

const counts = (shown: Partial<Record<Category, number>>): Record<Category, number> => ({
  improved: 0,
  regressed: 0,
  noise: 0,
  unchanged: 0,
  onlyA: 0,
  onlyB: 0,
  na: 0,
  ...shown,
})

describe('the summary bar (CP4)', () => {
  it('explains the denominator of a share, and what N/A counts, on hover', () => {
    render(<SummaryBar counts={counts({ regressed: 1, onlyA: 1, onlyB: 1 })} />)

    const share = 'Out of the 1 test improved, regressed, noise or unchanged.'
    const comparable = ['Improved 0 (0%)', 'Regressed 1 (100%)', 'Noise 0 (0%)', 'Unchanged 0 (0%)']
    for (const category of comparable) {
      expect(screen.getByText(category)).toHaveAttribute('title', share)
      expect(screen.getByText(category)).toHaveClass('explained')
    }
    const na = screen.getByText('N/A 0')
    expect(na.title).toMatch(/^Tests with a value on both sides, /)
    expect(na.title).toMatch(/Value A of 0: .* are N\/A\. .* count in Only in A or Only in B\.$/)
    expect(na).toHaveClass('explained')
    for (const category of ['Only in A 1', 'Only in B 1']) {
      expect(screen.getByText(category)).not.toHaveAttribute('title')
      expect(screen.getByText(category)).not.toHaveClass('explained')
    }
  })

  it('explains no denominator while there is no share', () => {
    render(<SummaryBar counts={counts({ onlyA: 1, onlyB: 1 })} />)

    for (const category of ['Improved 0', 'Regressed 0', 'Noise 0', 'Unchanged 0']) {
      expect(screen.getByText(category)).not.toHaveAttribute('title')
      expect(screen.getByText(category)).not.toHaveClass('explained')
    }
  })
})
