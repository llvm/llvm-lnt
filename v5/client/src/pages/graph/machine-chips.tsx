import { useEffect, useMemo, useRef } from 'react'
import { Combobox } from '../../components/combobox'
import { useLocalSuggestions } from '../../components/suggestions'
import { markerOf } from './chart'
import styles from './graph.module.css'

interface Props {
  /** The machines added, in order. */
  machines: string[]
  /** Every machine of the suite, once they are listed. */
  names: string[] | undefined
  /** Whether the suite's machines are still being listed. */
  pending: boolean
  /** Why the suite's machines could not be listed, if they could not. */
  error: Error | null
  isDisabled: boolean
  onChange(machines: string[]): void
}

/**
 * The machines plotted (GR1): a combobox adding one, filtering the suite's machines as the user
 * types, and a chip per machine added, which shows its marker on the chart and removes it.
 */
export function MachineChips({ machines, names, pending, error, isDisabled, onChange }: Props) {
  const offered = useMemo(
    () =>
      names
        ?.filter((name) => !machines.includes(name))
        .map((name) => ({ key: name, text: name })),
    [names, machines],
  )
  const suggestions = useLocalSuggestions(offered, error)

  // Once a chip is removed with its button, the focus goes to the button of the chip after it, or
  // else before it, or to the combobox once none is left, rather than to the page.
  const root = useRef<HTMLDivElement>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  // The chip whose button is to take the focus once the page shows the chip removed gone, or null
  // for the combobox; undefined while no chip is being removed.
  const focusNext = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (focusNext.current === undefined) return
    const next = focusNext.current
    focusNext.current = undefined
    const target = next === null ? root.current?.querySelector('input') : buttons.current.get(next)
    target?.focus()
  }, [machines])
  const remove = (i: number) => {
    focusNext.current = machines[i + 1] ?? machines[i - 1] ?? null
    onChange(machines.filter((_, j) => j !== i))
  }

  return (
    <div className={styles.machines} ref={root}>
      <Combobox
        label="Machines"
        suggestions={suggestions}
        onPick={(picked) => onChange([...machines, picked.key])}
        placeholder={pending ? 'Loading machines...' : 'Add a machine...'}
        isDisabled={isDisabled}
      />
      {machines.length > 0 && (
        <ul className={styles.chips} aria-label="Machines added">
          {machines.map((machine, i) => (
            <li key={machine} className={styles.chip}>
              <span className={styles.marker} aria-hidden="true">
                {markerOf(i).char}
              </span>
              {machine}
              <button
                type="button"
                className={styles.remove}
                aria-label={`Remove ${machine}`}
                ref={(button) => {
                  if (button) buttons.current.set(machine, button)
                  else buttons.current.delete(machine)
                }}
                onClick={() => remove(i)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
