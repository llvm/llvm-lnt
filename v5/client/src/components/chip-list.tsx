import { useEffect, useEffectEvent, useRef, type ReactNode } from 'react'
import styles from './chip-list.module.css'

export interface Chip {
  key: string
  /** What the chip shows, before its text: a machine's marker, say. */
  mark?: ReactNode
  text: string
}

interface Props {
  /** The list's accessible name. */
  label: string
  chips: Chip[]
  /** The accessible name of the button removing `chip`. */
  removeLabel(chip: Chip): string
  onRemove(key: string): void
  /** What takes the focus once the last chip is removed. */
  focusWhenEmpty(): HTMLElement | null | undefined
}

/**
 * Chips, one per line, each removed with its button: the Graph page's machines plotted (GR1) and
 * baselines (GR9), the Compare page's shadow (CP8). Once a chip is removed, the focus goes to the
 * button of the chip after it, or else before it, or to `focusWhenEmpty` once none is left, rather
 * than to the page.
 */
export function ChipList({ label, chips, removeLabel, onRemove, focusWhenEmpty }: Props) {
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  // The chip whose button is to take the focus once the chip removed is gone, or null for
  // `focusWhenEmpty`; undefined while no chip is being removed.
  const focusNext = useRef<string | null | undefined>(undefined)
  const moveFocus = useEffectEvent(() => {
    if (focusNext.current === undefined) return
    const next = focusNext.current
    focusNext.current = undefined
    const target = next === null ? focusWhenEmpty() : buttons.current.get(next)
    target?.focus()
  })
  const keys = chips.map((chip) => chip.key).join('\0')
  useEffect(() => moveFocus(), [keys])
  const remove = (i: number) => {
    focusNext.current = chips[i + 1]?.key ?? chips[i - 1]?.key ?? null
    onRemove(chips[i].key)
  }

  if (chips.length === 0) return null
  return (
    <ul className={styles.chips} aria-label={label}>
      {chips.map((chip, i) => (
        <li key={chip.key} className={styles.chip}>
          {chip.mark}
          {chip.text}
          <button
            type="button"
            className={styles.remove}
            aria-label={removeLabel(chip)}
            ref={(button) => {
              if (button) buttons.current.set(chip.key, button)
              else buttons.current.delete(chip.key)
            }}
            onClick={() => remove(i)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  )
}
