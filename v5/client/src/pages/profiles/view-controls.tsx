import { ControlsPanel } from '../../components/controls-panel'
import { Select } from '../../components/select'
import type { ValueMode } from './instructions'
import { VALUE_OPTIONS } from './settings'
import type { Counter } from './use-counter'
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
          // Not one offered while the profiles that would offer it have not loaded.
          value={
            counter.shown !== undefined && counter.offered.includes(counter.shown)
              ? counter.shown
              : null
          }
          // None offered once every side has settled: the profiles shown could not be loaded.
          placeholder={counter.settled ? 'No counters loaded' : 'Loading counters...'}
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
