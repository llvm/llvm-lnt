import { useMemo } from 'react'
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
  isDisabled: boolean
  onChange(machines: string[]): void
}

/**
 * The machines plotted (GR1): a combobox adding one, filtering the suite's machines as the user
 * types, and a chip per machine added, which shows its marker on the chart and removes it.
 */
export function MachineChips({ machines, names, pending, isDisabled, onChange }: Props) {
  const offered = useMemo(
    () =>
      names
        ?.filter((name) => !machines.includes(name))
        .map((name) => ({ key: name, text: name })),
    [names, machines],
  )
  const suggestions = useLocalSuggestions(offered)
  return (
    <div className={styles.machines}>
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
                onClick={() => onChange(machines.filter((name) => name !== machine))}
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
