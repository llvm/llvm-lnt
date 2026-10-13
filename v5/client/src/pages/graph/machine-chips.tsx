import { useMemo, useRef } from 'react'
import { ChipList } from '../../components/chip-list'
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

  const root = useRef<HTMLDivElement>(null)
  const chips = machines.map((machine, i) => ({
    key: machine,
    mark: (
      <span className={styles.marker} aria-hidden="true">
        {markerOf(i).char}
      </span>
    ),
    text: machine,
  }))

  return (
    <div className={styles.machines} ref={root}>
      <Combobox
        label="Machines"
        suggestions={suggestions}
        onPick={(picked) => onChange([...machines, picked.key])}
        placeholder={pending ? 'Loading machines...' : 'Add a machine...'}
        isDisabled={isDisabled}
      />
      <ChipList
        label="Machines added"
        chips={chips}
        removeLabel={(chip) => `Remove ${chip.key}`}
        onRemove={(machine) => onChange(machines.filter((entry) => entry !== machine))}
        focusWhenEmpty={() => root.current?.querySelector('input')}
      />
    </div>
  )
}
