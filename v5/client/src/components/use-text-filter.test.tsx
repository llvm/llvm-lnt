import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { RegexFilter } from './regex-filter'
import { search } from '../test/page'
import { useTextFilter } from './use-text-filter'

const TESTS = ['BM_find/1024', 'BM_find/4096', 'BM_Sort/1024', 'BM_sort_stable/1024']

const nameOf = (name: string) => name

/** The tests `TESTS` under a filter with a regex mode, in state as a page keeps it in its URL. */
function Filtered({ rows = TESTS, initial = '', initialRegex = false }) {
  const [stored, setStored] = useState(initial)
  const [regex, setRegex] = useState(initialRegex)
  const filter = useTextFilter(rows, nameOf, stored, setStored, { regex })
  return (
    <>
      <RegexFilter
        filter={filter}
        label="Filter tests"
        placeholder="Filter tests..."
        regex={regex}
        onRegexChange={setRegex}
      />
      <p data-testid="active">{String(filter.active)}</p>
      <ul>
        {filter.rows.map((row, i) => (
          <li key={i}>{row}</li>
        ))}
      </ul>
    </>
  )
}

const input = () => screen.getByRole('searchbox', { name: 'Filter tests' })
const regexBox = () => screen.getByRole('checkbox', { name: 'Regex' })
const shown = () => screen.queryAllByRole('listitem').map((item) => item.textContent)
const type = (text: string) => search('Filter tests', text)

describe('useTextFilter (AR9)', () => {
  it('keeps the rows containing the text, whatever its case', () => {
    render(<Filtered />)

    type('sort')

    expect(shown()).toEqual(['BM_Sort/1024', 'BM_sort_stable/1024'])
    expect(screen.getByTestId('active')).toHaveTextContent('true')
    expect(input()).not.toHaveAttribute('aria-invalid')
  })

  it('matches its text as a case-insensitive regex in regex mode', async () => {
    render(<Filtered />)

    type('^bm_(find|sort)/1024$')
    expect(shown()).toEqual([])
    await userEvent.setup().click(regexBox())

    expect(shown()).toEqual(['BM_find/1024', 'BM_Sort/1024'])
  })

  it('matches every row the same way, whatever the rows before it', () => {
    // A regex with the `g` flag would resume after the first match, and miss the second row.
    render(<Filtered rows={['ab', 'ab']} initial="a" initialRegex />)
    expect(shown()).toEqual(['ab', 'ab'])
  })

  it('shows the red halo on an invalid regex, and keeps applying the last valid one', () => {
    render(<Filtered initialRegex />)

    type('find/(1024|4096)')
    expect(shown()).toEqual(['BM_find/1024', 'BM_find/4096'])
    type('find/(1024|4096')

    expect(input()).toHaveAttribute('aria-invalid', 'true')
    expect(input()).toHaveAccessibleDescription('Not a valid regular expression.')
    expect(shown()).toEqual(['BM_find/1024', 'BM_find/4096'])

    type('find/(4096)')
    expect(input()).not.toHaveAttribute('aria-invalid')
    expect(shown()).toEqual(['BM_find/4096'])
  })

  it('applies no filter while there has been no valid regex', () => {
    render(<Filtered initial="find(" initialRegex />)

    expect(input()).toHaveAttribute('aria-invalid', 'true')
    expect(shown()).toEqual(TESTS)
    expect(screen.getByTestId('active')).toHaveTextContent('false')
  })

  it('keeps matching a substring when switched to regex mode on an invalid regex', async () => {
    const user = userEvent.setup()
    render(<Filtered rows={[...TESTS, 'BM_Bitset/Dense_(90%)']} />)
    type('Dense_(')

    await user.click(regexBox())
    expect(input()).toHaveAttribute('aria-invalid', 'true')
    expect(shown()).toEqual(['BM_Bitset/Dense_(90%)'])

    // Back to substrings, the text is valid again.
    await user.click(regexBox())
    expect(input()).not.toHaveAttribute('aria-invalid')
    expect(shown()).toEqual(['BM_Bitset/Dense_(90%)'])
  })

  it('applies no filter to empty text, in either mode', async () => {
    render(<Filtered initial="sort" initialRegex />)

    type('')

    expect(shown()).toEqual(TESTS)
    expect(screen.getByTestId('active')).toHaveTextContent('false')
  })
})
