import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import clsx from 'clsx'
import { heatColor } from './heat'
import {
  formatAddress,
  formatInstructionValue,
  textColumns,
  valueColumns,
  type Instruction,
  type InstructionValues,
  type ValueMode,
} from './instructions'
import styles from './instruction-table.module.css'

/** How tall a row is, in rem, so that it grows with the user's font size. */
const ROW_REM = 1.5

/** How many rows are rendered beyond those in view, on either side. */
const OVERSCAN = 20

/** A row's height in pixels, from the root font size, whole so that rows do not drift. */
function rowHeight(): number {
  const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  return Math.round(ROW_REM * rootFontSize)
}

/**
 * How wide the address and text columns must be, in columns of a fixed-width font, for every
 * instruction's, so that they hold still as rows are rendered while scrolling.
 */
function instructionWidths(instructions: readonly Instruction[]) {
  let address = 0
  let text = 0
  for (const instruction of instructions) {
    address = Math.max(address, instruction.address)
    text = Math.max(text, textColumns(instruction.text))
  }
  return { address: formatAddress(address).length, text }
}

interface Props {
  /** The table's accessible name. */
  label: string
  /** The function's instructions, in order. */
  instructions: readonly Instruction[]
  /** The selected counter, which heads the value column: none, and no such column, without one. */
  counter: string | undefined
  /** The instructions' values for `counter`: none when the function does not have it. */
  values: InstructionValues | undefined
  mode: ValueMode
  /** The index of the instruction to highlight, scrolled into view whenever it changes. */
  highlighted?: number
}

/**
 * A function's disassembly (PF5): each instruction's value for the selected counter, colored by the
 * heat scale, its address and its text, in a fixed-width font that keeps its whitespace.
 *
 * Only the rows in view are rendered, so that a function of 100,000 instructions scrolls smoothly,
 * in a scrolling box of its own, under a header that stays in view. Every row is the same height,
 * and a row's text is cut to it, should it hold a line break. The columns are as wide as the widest
 * instruction's, so that they hold still while scrolling, and the box scrolls sideways to show long
 * instructions in full.
 *
 * Its owner renders it with a `key` naming the profile and the function shown, so that showing
 * another starts at the top, whereas a refetch of the same function, which brings new arrays of
 * the same data, leaves the scroll position as it is.
 */
export const InstructionTable = memo(function InstructionTable({
  label,
  instructions,
  counter,
  values,
  mode,
  highlighted,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const [height] = useState(rowHeight)
  // Apart, so that changing the counter does not go through every instruction's text again.
  const widths = useMemo(() => instructionWidths(instructions), [instructions])
  const valueWidth = useMemo(() => valueColumns(values), [values])
  // The React Compiler cannot memoize what uses TanStack Virtual's result. There is no compiler here,
  // and the virtualizer is passed to no memoized computation, only read while rendering.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: instructions.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => height,
    // The header row, which is as tall as the others (see the module's CSS).
    paddingStart: height,
    overscan: OVERSCAN,
    // Scrolling renders the rows as an ordinary update rather than through `flushSync`, as TanStack
    // Virtual advises with React 19.
    useFlushSync: false,
  })

  // Also on mounting with a row highlighted, as when the instructions are fetched again after a
  // failure, which replaces the table with the error until then.
  useEffect(() => {
    if (highlighted === undefined) return
    virtualizer.scrollToIndex(highlighted, { align: 'center' })
    // The box is shorter than the window, so this brings the row into the window too, should the
    // page be scrolled away from the box.
    scroller.current?.scrollIntoView({ block: 'nearest' })
  }, [highlighted, virtualizer])

  if (instructions.length === 0) {
    return <p className={styles.note}>This function has no instructions.</p>
  }

  const items = virtualizer.getVirtualItems()
  const first = items.at(0)
  const last = items.at(-1)
  const columns = counter === undefined ? 2 : 3
  const style = {
    '--row-height': `${height}px`,
    '--value-width': `${valueWidth}ch`,
    '--address-width': `${widths.address}ch`,
    '--text-width': `${widths.text}ch`,
  } as CSSProperties

  return (
    <>
      {counter !== undefined && values === undefined && (
        <p className={styles.note}>This function does not have the counter {counter}.</p>
      )}
      {/* Focusable, so that it can be scrolled from the keyboard, and named for when it has focus. */}
      <div ref={scroller} className={styles.scroller} tabIndex={0} role="region" aria-label={label}>
        <table
          className={styles.table}
          aria-label={label}
          aria-rowcount={instructions.length + 1}
          style={style}
        >
          <colgroup>
            {counter !== undefined && <col className={styles.fit} />}
            <col className={styles.fit} />
            <col />
          </colgroup>
          <thead>
            <tr aria-rowindex={1}>
              {counter !== undefined && (
                <th scope="col" className={clsx(styles.header, styles.numeric)}>
                  {counter}
                </th>
              )}
              <th scope="col" className={styles.header}>
                Address
              </th>
              <th scope="col" className={styles.header}>
                Instruction
              </th>
            </tr>
          </thead>
          <tbody>
            <Spacer columns={columns} height={first ? first.start - height : 0} />
            {items.map(({ index }) => (
              <Row
                key={index}
                index={index}
                instruction={instructions[index]}
                values={counter === undefined ? null : values}
                mode={mode}
                highlighted={index === highlighted}
              />
            ))}
            <Spacer columns={columns} height={last ? virtualizer.getTotalSize() - last.end : 0} />
          </tbody>
        </table>
      </div>
    </>
  )
})

/** Where the rows that are not rendered would be, above or below those that are. */
function Spacer({ columns, height }: { columns: number; height: number }) {
  if (height <= 0) return null
  return (
    <tr aria-hidden="true">
      <td colSpan={columns} className={styles.spacer} style={{ height }} />
    </tr>
  )
}

interface RowProps {
  index: number
  instruction: Instruction
  /** The values of the function's instructions: null when there is no value column. */
  values: InstructionValues | undefined | null
  mode: ValueMode
  highlighted: boolean
}

/**
 * The instruction at `index`. Rendered again only when what it shows changes, so that scrolling
 * renders only the rows coming into view.
 */
const Row = memo(function Row({ index, instruction, values, mode, highlighted }: RowProps) {
  return (
    <tr aria-rowindex={index + 2} aria-current={highlighted || undefined} className={styles.row}>
      {values !== null && (
        <td
          className={styles.cell}
          style={{ background: values && heatColor(values.shares[index]) }}
        >
          <div className={clsx(styles.content, styles.value)}>
            {values && formatInstructionValue(values, index, mode)}
          </div>
        </td>
      )}
      <td className={styles.cell}>
        <div className={clsx(styles.content, styles.address)}>
          {formatAddress(instruction.address)}
        </div>
      </td>
      <td className={styles.cell}>
        <div className={clsx(styles.content, styles.text)}>{instruction.text}</div>
      </td>
    </tr>
  )
})
