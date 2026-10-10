import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { useRangeSelection } from './range-selection'
import { SelectAllBox, SelectBox } from './select-box'

const ROWS = ['a', 'b', 'c', 'd']

/** A list of `ROWS`, each with a checkbox, under a select-all checkbox. */
function List({ shown = ROWS }: { shown?: string[] }) {
  const { rows } = useRangeSelection(undefined, shown)
  return (
    <>
      <SelectAllBox rows={rows} shown={shown} label="Select all" />
      {shown.map((key) => (
        <SelectBox key={key} rows={rows} rowKey={key} label={`Select ${key}`} />
      ))}
    </>
  )
}

const box = (key: string) => screen.getByRole('checkbox', { name: `Select ${key}` })
const all = () => screen.getByRole('checkbox', { name: 'Select all' })
const checked = () => ROWS.filter((key) => (box(key) as HTMLInputElement).checked)

describe('SelectBox', () => {
  it('selects a range with Shift held, by mouse', async () => {
    const user = userEvent.setup()
    render(<List />)

    await user.click(box('a'))
    await user.keyboard('{Shift>}')
    await user.click(box('c'))
    await user.keyboard('{/Shift}')

    expect(checked()).toEqual(['a', 'b', 'c'])
  })

  it('selects a range with Shift held, from the keyboard', async () => {
    const user = userEvent.setup()
    render(<List />)

    await user.click(box('d'))
    box('b').focus()
    await user.keyboard('{Shift>} {/Shift}')

    expect(checked()).toEqual(['b', 'c', 'd'])
  })
})

describe('SelectAllBox', () => {
  it('is checked when every row is, and mixed when only some are', async () => {
    const user = userEvent.setup()
    render(<List />)
    expect(all()).not.toBeChecked()

    await user.click(box('a'))
    expect(all()).toBePartiallyChecked()

    await user.click(all())
    expect(checked()).toEqual(ROWS)
    expect(all()).toBeChecked()

    await user.click(all())
    expect(checked()).toEqual([])
  })

  it('cannot be used with no rows shown', () => {
    render(<List shown={[]} />)
    expect(all()).toBeDisabled()
  })
})
