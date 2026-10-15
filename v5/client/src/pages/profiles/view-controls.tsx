import { ControlsPanel } from '../../components/controls-panel'
import { Select } from '../../components/select'
import type { ValueMode } from './instructions'
import { VALUE_OPTIONS } from './settings'
import { noCountersText, type Counter } from './use-counter'
import styles from './profiles.module.css'

interface Props {
  counter: Counter
  values: ValueMode
  onValues(values: ValueMode): void
}

/** The Counter and the Values, which both sides share (PF4, PF6). */
export function ViewControls({ counter, values, onValues }: Props) {
  return (
    <ControlsPanel>
      {counter.none ? (
        <p className={styles.note}>The profiles shown have no counters.</p>
      ) : (
        <Select
          label="Counter"
          options={counter.offered.map((name) => ({ value: name, label: name }))}
          value={counter.listed ?? null}
          placeholder={noCountersText(counter)}
          onChange={counter.pick}
          isDisabled={counter.offered.length === 0}
        />
      )}
      <Select<ValueMode>
        label="Values"
        options={VALUE_OPTIONS}
        value={values}
        onChange={onValues}
      />
    </ControlsPanel>
  )
}
