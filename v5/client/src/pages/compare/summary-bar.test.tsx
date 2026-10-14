import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { summaryCounts, type Category } from './comparison'
import { SummaryBar } from './summary-bar'

const counts = (shown: Partial<Record<Category, number>>) => ({ ...summaryCounts([]), ...shown })

// Each category's text, and the tooltip of its count.
const categories = () =>
  screen
    .getAllByRole('listitem')
    .map((item) => [item.textContent, item.lastElementChild?.getAttribute('title') ?? null])

describe('SummaryBar', () => {
  it('explains the denominator of each share on hover', () => {
    render(<SummaryBar counts={counts({ regressed: 1, onlyA: 1, zeroBaseline: 1 })} />)

    const share = 'Out of the 1 test improved, regressed, noise or unchanged.'
    expect(categories()).toEqual([
      ['Improved 0 (0%)', share],
      ['Regressed 1 (100%)', share],
      ['Noise 0 (0%)', share],
      ['Unchanged 0 (0%)', share],
      ['Only in A 1', null],
      ['Only in B 0', null],
      ['Zero baseline 1', null],
    ])
  })

  it('explains no denominator while there is no share', () => {
    render(<SummaryBar counts={counts({ onlyA: 1, onlyB: 1 })} />)

    expect(categories().map(([, title]) => title)).toEqual(Array(7).fill(null))
  })
})
