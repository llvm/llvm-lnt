import { createRef, useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { optionsIn, pickOption, selectButton } from '../test/select'
import { Select, type Option } from './select'

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

  it('shows its placeholder while no option is picked, until one is', async () => {
    function Unpicked() {
      const [value, setValue] = useState<string | null>(null)
      return (
        <Select
          label="Metric"
          options={OPTIONS}
          value={value}
          onChange={setValue}
          placeholder="-- Select metric --"
        />
      )
    }
    render(<Unpicked />)
    expect(selectButton('Metric')).toHaveTextContent('-- Select metric --')

    await pickOption('Metric', 'Code Size')

    expect(selectButton('Metric')).toHaveTextContent('Code Size')
  })

  it('refuses an option with a reason, saying why on hover and to assistive technology', async () => {
    const onChange = vi.fn()
    render(
      <Select
        label="Project"
        options={[
          { value: 'llvm', label: 'LLVM' },
          { value: 'swift', label: 'Swift', reason: 'Needs a token covering it.' },
        ]}
        value={null}
        placeholder="Select a project"
        onChange={onChange}
      />,
    )
    const user = userEvent.setup()

    await user.click(selectButton('Project'))
    const refused = screen.getByRole('option', { name: 'Swift: Needs a token covering it.' })
    expect(screen.getByTitle('Needs a token covering it.')).toHaveTextContent(/^Swift/)

    // It can be reached from the keyboard, so that its reason can be read, but not picked.
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(refused).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onChange).not.toHaveBeenCalled()
    await user.click(selectButton('Project'))
    await user.click(screen.getByRole('option', { name: 'Swift: Needs a token covering it.' }))
    expect(onChange).not.toHaveBeenCalled()
    await user.click(selectButton('Project'))
    await user.click(screen.getByRole('option', { name: 'LLVM' }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('llvm')
  })

  it('gives its button to a ref, to focus it from script', () => {
    const ref = createRef<HTMLButtonElement>()
    render(<Select label="Metric" options={OPTIONS} value="" onChange={() => {}} ref={ref} />)

    ref.current!.focus()

    expect(selectButton('Metric')).toHaveFocus()
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
    expect(selectButton('Metric')).toHaveAccessibleDescription('Needs a token.')
  })

  it('cannot be opened while pending, but can take the focus', async () => {
    render(<Select label="Metric" options={OPTIONS} value="" onChange={() => {}} isPending />)
    const user = userEvent.setup()

    await user.click(selectButton('Metric'))
    await user.keyboard('{ArrowDown}')

    expect(selectButton('Metric')).toHaveFocus()
    expect(selectButton('Metric')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('opens nothing while disabled', async () => {
    render(<Select label="Metric" options={OPTIONS} value="" onChange={() => {}} isDisabled />)

    await userEvent.setup().click(selectButton('Metric'))

    expect(selectButton('Metric')).toBeDisabled()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})

describe('Select with options in groups', () => {
  // As a suite dropdown lists them (AR22), after an option in no group. Two projects share a label,
  // and their groups stay apart.
  const section = (key: string, heading: string) => ({ key, heading })
  const GROUPED: Option<string>[] = [
    { value: '', label: 'Any suite' },
    {
      value: 'llvm/nts',
      label: 'nts',
      selectedLabel: 'LLVM/nts',
      section: section('llvm', 'LLVM'),
    },
    {
      value: 'llvm/micro',
      label: 'Microbenchmarks',
      selectedLabel: 'LLVM/Microbenchmarks',
      section: section('llvm', 'LLVM'),
    },
    {
      value: 'llvm2/nts',
      label: 'Tests',
      selectedLabel: 'LLVM/Tests',
      section: section('llvm2', 'LLVM'),
    },
    {
      value: 'swift/bench',
      label: 'bench',
      selectedLabel: 'Swift/bench',
      section: section('swift', 'Swift'),
    },
  ]

  function SuiteSelect({
    options = GROUPED,
    onChange = () => {},
    listPicksOnly,
  }: {
    options?: Option<string>[]
    onChange?: (value: string) => void
    listPicksOnly?: boolean
  }) {
    const [value, setValue] = useState('')
    return (
      <Select
        label="Suite"
        options={options}
        value={value}
        onChange={(next) => {
          setValue(next)
          onChange(next)
        }}
        listPicksOnly={listPicksOnly}
      />
    )
  }

  it('lists each group under its heading, which is not an option, after the options in none', async () => {
    render(<SuiteSelect />)

    await userEvent.setup().click(selectButton('Suite'))

    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Any suite',
      'nts',
      'Microbenchmarks',
      'Tests',
      'bench',
    ])
    const groups = screen.getAllByRole('group')
    expect(groups.map((group) => optionsIn(group))).toEqual([
      ['nts', 'Microbenchmarks'],
      ['Tests'],
      ['bench'],
    ])
    expect(groups[0]).toHaveAccessibleName('LLVM')
    expect(groups[1]).toHaveAccessibleName('LLVM')
    expect(groups[2]).toHaveAccessibleName('Swift')
    expect(screen.queryByRole('option', { name: /^LLVM|^Swift/ })).toBeNull()
  })

  it('shows the label an option is picked by once picked, and its own label in the list', async () => {
    const onChange = vi.fn()
    render(<SuiteSelect onChange={onChange} />)

    await pickOption('Suite', 'Tests')

    expect(onChange).toHaveBeenCalledWith('llvm2/nts')
    expect(selectButton('Suite')).toHaveTextContent('LLVM/Tests')
    expect(selectButton('Suite')).toHaveAccessibleName('LLVM/Tests Suite')
    await userEvent.setup().click(selectButton('Suite'))
    expect(screen.getByRole('option', { name: 'Tests' })).toHaveAttribute('aria-selected', 'true')
  })

  it('shows the label of an option without a label to be picked by, as in no group', async () => {
    render(<SuiteSelect />)
    expect(selectButton('Suite')).toHaveTextContent('Any suite')
  })

  it('skips the headings when moving through the options, in the open list and closed', async () => {
    const onChange = vi.fn()
    render(<SuiteSelect onChange={onChange} />)
    const user = userEvent.setup()

    await user.click(selectButton('Suite'))
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(screen.getByRole('option', { name: 'Tests' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('option', { name: 'bench' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenLastCalledWith('swift/bench')

    selectButton('Suite').focus()
    await user.keyboard('{ArrowLeft}')
    expect(onChange).toHaveBeenLastCalledWith('llvm2/nts')
    await user.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}')
    expect(onChange).toHaveBeenLastCalledWith('')
  })

  it('finds an option by typing its own label, in the open list and closed', async () => {
    const onChange = vi.fn()
    render(<SuiteSelect onChange={onChange} />)
    const user = userEvent.setup()

    await user.click(selectButton('Suite'))
    await user.keyboard('micro')
    expect(screen.getByRole('option', { name: 'Microbenchmarks' })).toHaveFocus()
    await user.keyboard('{Escape}')

    selectButton('Suite').focus()
    await user.keyboard('b')
    expect(onChange).toHaveBeenLastCalledWith('swift/bench')
  })

  it('refuses an option with a reason in a group, which can be focused but not picked', async () => {
    const onChange = vi.fn()
    const refused = { ...GROUPED[4], reason: 'Needs a token covering it.' }
    render(<SuiteSelect options={[...GROUPED.slice(0, 4), refused]} onChange={onChange} />)
    const user = userEvent.setup()

    await user.click(selectButton('Suite'))
    const option = screen.getByRole('option', {
      name: 'bench: Needs a token covering it.',
    })
    expect(screen.getByRole('group', { name: 'Swift' })).toContainElement(option)
    await user.keyboard('{End}')
    expect(option).toHaveFocus()
    await user.keyboard('{Enter}')
    await user.click(selectButton('Suite'))
    await user.click(screen.getByRole('option', { name: 'bench: Needs a token covering it.' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})
