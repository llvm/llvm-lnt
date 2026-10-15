import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { fakeLayout } from '../../test/layout'
import { InstructionTable } from './instruction-table'
import { instructionValues, type Instruction, type ValueMode } from './instructions'

function instruction(cycles: number, text = 'nop', address = 4096): Instruction {
  return { address, counters: { cycles }, text }
}

const INSTRUCTIONS = [
  instruction(1, 'push\trbp', 0x401000),
  instruction(0, 'mov    rbp,  rsp', 0x401001),
  instruction(3, 'ret', 0x40101f),
]

interface Options {
  instructions?: Instruction[]
  counter?: string
  mode?: ValueMode
  highlighted?: number
}

function renderTable(options: Options = {}) {
  const { instructions = INSTRUCTIONS, mode = 'relative', highlighted } = options
  const counter = 'counter' in options ? options.counter : 'cycles'
  const values = counter === undefined ? undefined : instructionValues(instructions, counter)
  const props = { label: 'Disassembly', instructions, counter, values, mode, highlighted }
  const result = render(<InstructionTable {...props} />)
  return {
    ...result,
    rerender: (changes: Partial<typeof props>) =>
      result.rerender(<InstructionTable {...props} {...changes} />),
  }
}

/** The texts of the cells of the body's rows, as rendered. */
function bodyCells(): string[][] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent ?? ''),
    )
}

function rowOf(index: number): HTMLElement | null {
  return screen.getByRole('table').querySelector(`tr[aria-rowindex="${index + 2}"]`)
}

describe('InstructionTable', () => {
  it("shows each instruction's value, address and text, whitespace and all", () => {
    fakeLayout()
    renderTable()

    const headers = screen.getAllByRole('columnheader').map((header) => header.textContent)
    expect(headers).toEqual(['cycles', 'Address', 'Instruction'])
    expect(bodyCells()).toEqual([
      ['25%', '0x401000', 'push\trbp'],
      ['', '0x401001', 'mov    rbp,  rsp'],
      ['75%', '0x40101f', 'ret'],
    ])
  })

  it('shows the values as the Values setting says', () => {
    fakeLayout()
    const { rerender } = renderTable()

    rerender({ mode: 'absolute' })
    expect(bodyCells().map(([value]) => value)).toEqual(['1', '', '3'])

    rerender({ mode: 'cumulative' })
    expect(bodyCells().map(([value]) => value)).toEqual(['25%', '25%', '100%'])
  })

  it('colors a value by its share, whatever the Values setting', () => {
    fakeLayout()
    const { rerender } = renderTable({ instructions: [instruction(1), instruction(199)] })
    const background = () =>
      screen
        .getAllByRole('row')
        .slice(1)
        .map((row) => within(row).getAllByRole('cell')[0].style.background)

    expect(background()).toEqual(['', 'rgb(248, 113, 113)'])
    rerender({ mode: 'cumulative' })
    expect(background()).toEqual(['', 'rgb(248, 113, 113)'])
  })

  it('has no value column without a counter', () => {
    fakeLayout()
    renderTable({ counter: undefined })

    expect(screen.getAllByRole('columnheader')).toHaveLength(2)
    expect(bodyCells()[0]).toEqual(['0x401000', 'push\trbp'])
  })

  it('says so, and leaves the value column empty, when the function lacks the counter', () => {
    fakeLayout()
    renderTable({ counter: 'misses' })

    expect(screen.getByText('This function does not have the counter misses.')).toBeVisible()
    expect(bodyCells().map(([value]) => value)).toEqual(['', '', ''])
  })

  it('says so when the function has no instructions, rather than that it lacks the counter', () => {
    renderTable({ instructions: [], counter: 'misses' })

    expect(screen.getByText('This function has no instructions.')).toBeVisible()
    expect(screen.queryByText(/does not have the counter/)).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('renders only the rows around those in view, however many there are', async () => {
    fakeLayout()
    const many = Array.from({ length: 100_000 }, (_, i) => instruction(i % 7, `insn ${i}`, i))
    renderTable({ instructions: many })

    const table = screen.getByRole('table')
    expect(table).toHaveAttribute('aria-rowcount', '100001')
    expect(screen.getAllByRole('row').length).toBeLessThan(100)
    expect(rowOf(0)).toHaveTextContent('insn 0')

    // Scrolled to the 50,000th row: those around it are rendered instead.
    const scroller = screen.getByRole('region', { name: 'Disassembly' })
    expect(scroller).toContainElement(table)
    scroller.scrollTop = 50_000 * 24
    fireEvent.scroll(scroller)

    await waitFor(() => expect(rowOf(50_000)).toHaveTextContent('insn 50000'))
    expect(rowOf(0)).toBeNull()
    expect(screen.getAllByRole('row').length).toBeLessThan(100)
  })

  it('highlights a row, and scrolls it into view, whenever it is asked to', async () => {
    const { scrollTo } = fakeLayout()
    const many = Array.from({ length: 100_000 }, (_, i) => instruction(1, `insn ${i}`, i))
    const { rerender } = renderTable({ instructions: many })
    expect(rowOf(60_000)).toBeNull()

    rerender({ highlighted: 60_000 })

    await waitFor(() => expect(rowOf(60_000)).toHaveAttribute('aria-current', 'true'))
    expect(scrollTo).toHaveBeenCalled()
    expect(screen.getAllByRole('row').filter((row) => row.ariaCurrent)).toHaveLength(1)
  })
})
