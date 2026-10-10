import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { pickOption, selectButton } from '../test/select'
import { Select } from './select'

const OPTIONS = [
  { value: '', label: 'Any metric' },
  { value: 'execution_time', label: 'Execution Time' },
  { value: 'code_size', label: 'Code Size' },
]

function MetricSelect({
  onChange = () => {},
  listPicksOnly,
}: {
  onChange?: (value: string) => void
  listPicksOnly?: boolean
}) {
  const [value, setValue] = useState('')
  return (
    <Select
      label="Metric"
      options={OPTIONS}
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange(next)
      }}
      listPicksOnly={listPicksOnly}
    />
  )
}

describe('Select', () => {
  it('shows the label of its value, an empty string included', () => {
    render(<MetricSelect />)
    expect(selectButton('Metric')).toHaveTextContent('Any metric')
  })

  it('lists its options, and picks the one clicked', async () => {
    const onChange = vi.fn()
    render(<MetricSelect onChange={onChange} />)
    const user = userEvent.setup()

    await user.click(selectButton('Metric'))
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Any metric',
      'Execution Time',
      'Code Size',
    ])
    await user.click(screen.getByRole('option', { name: 'Code Size' }))

    expect(onChange).toHaveBeenCalledWith('code_size')
    expect(selectButton('Metric')).toHaveTextContent('Code Size')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('picks with the keyboard', async () => {
    const onChange = vi.fn()
    render(<MetricSelect onChange={onChange} />)
    const user = userEvent.setup()

    selectButton('Metric').focus()
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{ArrowDown}{Enter}')

    expect(onChange).toHaveBeenCalledWith('execution_time')
  })

  it('goes back to an empty string value', async () => {
    const onChange = vi.fn()
    render(<MetricSelect onChange={onChange} />)

    await pickOption('Metric', 'Code Size')
    await pickOption('Metric', 'Any metric')

    expect(onChange).toHaveBeenLastCalledWith('')
    expect(selectButton('Metric')).toHaveTextContent('Any metric')
  })

  it('steps through its options with the arrow keys and typing while closed', async () => {
    const onChange = vi.fn()
    render(<MetricSelect onChange={onChange} />)

    selectButton('Metric').focus()
    await userEvent.setup().keyboard('{ArrowRight}')

    expect(onChange).toHaveBeenCalledWith('execution_time')
  })

  it('changes only on a pick from the open list, with listPicksOnly', async () => {
    const onChange = vi.fn()
    render(<MetricSelect onChange={onChange} listPicksOnly />)
    const user = userEvent.setup()

    selectButton('Metric').focus()
    await user.keyboard('{ArrowRight}{ArrowLeft}c')
    expect(onChange).not.toHaveBeenCalled()
    expect(selectButton('Metric')).toHaveTextContent('Any metric')

    await user.keyboard('{ArrowDown}')
    await user.keyboard('{ArrowDown}{Enter}')
    await pickOption('Metric', 'Code Size')
    expect(onChange.mock.calls).toEqual([['execution_time'], ['code_size']])
  })

  it('can keep its label for assistive technology only, and say something on hover', () => {
    render(
      <Select
        label="Metric"
        options={OPTIONS}
        value=""
        onChange={() => {}}
        hideLabel
        title="Needs a token."
      />,
    )

    expect(selectButton('Metric')).toBeInTheDocument()
    expect(screen.getByText('Metric').closest('[style]')).toHaveStyle({ position: 'absolute' })
    expect(selectButton('Metric').closest('[title]')).toHaveAttribute('title', 'Needs a token.')
  })

  it('opens nothing while disabled', async () => {
    render(<Select label="Metric" options={OPTIONS} value="" onChange={() => {}} isDisabled />)

    await userEvent.setup().click(selectButton('Metric'))

    expect(selectButton('Metric')).toBeDisabled()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})
