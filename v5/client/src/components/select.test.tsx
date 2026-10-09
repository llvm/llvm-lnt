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

function MetricSelect({ onChange = () => {} }: { onChange?: (value: string) => void }) {
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

  it('opens nothing while disabled', async () => {
    render(<Select label="Metric" options={OPTIONS} value="" onChange={() => {}} isDisabled />)

    await userEvent.setup().click(selectButton('Metric'))

    expect(selectButton('Metric')).toBeDisabled()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})
