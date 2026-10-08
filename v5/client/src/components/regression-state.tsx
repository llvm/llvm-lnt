import clsx from 'clsx'
import { REGRESSION_STATES, stateLabel, type RegressionState } from '../regression-states'
import styles from './regression-state.module.css'

/** The class giving each state its colours. */
const STATE_CLASS: Record<RegressionState, string> = {
  detected: styles.detected,
  active: styles.active,
  not_to_be_fixed: styles.notToBeFixed,
  fixed: styles.fixed,
  false_positive: styles.falsePositive,
}

/**
 * A regression's state, coloured as the Graph page colours its annotations (GR15): red for
 * `active`, yellow for `detected`, and grey for the resolved states.
 */
export function StateBadge({ state }: { state: RegressionState }) {
  return <span className={clsx(styles.badge, STATE_CLASS[state])}>{stateLabel(state)}</span>
}

interface StateChipsProps {
  /** The states selected. None selected means every state (TS5). */
  selected: readonly RegressionState[]
  onChange(selected: RegressionState[]): void
}

/** A toggle per state, any number of which can be selected. */
export function StateChips({ selected, onChange }: StateChipsProps) {
  const toggle = (state: RegressionState) =>
    onChange(
      REGRESSION_STATES.filter((s) => (s === state ? !selected.includes(s) : selected.includes(s))),
    )
  return (
    <div className={styles.chips} role="group" aria-label="State">
      {REGRESSION_STATES.map((state) => (
        <button
          key={state}
          type="button"
          className={clsx(styles.chip, STATE_CLASS[state])}
          aria-pressed={selected.includes(state)}
          onClick={() => toggle(state)}
        >
          {stateLabel(state)}
        </button>
      ))}
    </div>
  )
}
