import { useEffect, useMemo, useRef, useState } from 'react'
import type { SuiteSchema } from '../../api/suites'
import { Combobox } from '../../components/combobox'
import { CommitPicker } from '../../components/commit-picker'
import { useMachineSuggestions } from '../../components/machine-suggestions'
import { Select } from '../../components/select'
import { NO_SUGGESTIONS, type Suggestion } from '../../components/suggestions'
import { formatBaseline, type Baseline, type BaselineState } from './baselines'
import { ChipList } from '../../components/chip-list'
import styles from './graph.module.css'

interface Props {
  /** The suites a baseline can be taken from. */
  suites: readonly SuiteSchema[]
  baselines: BaselineState[]
  onAdd(baseline: Baseline): void
  onRemove(baseline: string): void
  isDisabled: boolean
}

/**
 * The baselines (GR9): a "+" button beside their label, opening a form that adds one, picking its
 * suite, then one of the suite's machines, then a commit at which the machine has runs, and a chip
 * per baseline, which removes it. Picking the commit adds the baseline and closes the form.
 */
export function BaselinePanel({ suites, baselines, onAdd, onRemove, isDisabled }: Props) {
  const [adding, setAdding] = useState(false)
  const toggle = useRef<HTMLButtonElement>(null)
  const chips = baselines.map(({ baseline, display }) => ({
    key: formatBaseline(baseline),
    text: `${baseline.suite}/${baseline.machine}/${display}`,
  }))

  // Once a baseline is added, the form it was picked in is gone: the focus goes back to "+".
  const added = useRef(false)
  useEffect(() => {
    if (adding || !added.current) return
    added.current = false
    toggle.current?.focus()
  }, [adding])
  const add = (baseline: Baseline) => {
    onAdd(baseline)
    added.current = true
    setAdding(false)
  }

  return (
    <div className={styles.baselines}>
      <div className={styles.baselinesHeader}>
        <span className={styles.baselinesLabel}>Baselines</span>
        <button
          ref={toggle}
          type="button"
          className={styles.addBaseline}
          aria-expanded={adding}
          aria-label="Add a baseline"
          title="Add a baseline"
          disabled={isDisabled}
          onClick={() => setAdding(!adding)}
        >
          +
        </button>
      </div>
      {adding && !isDisabled && <BaselineForm suites={suites} onAdd={add} />}
      <ChipList
        label="Baselines added"
        chips={chips}
        removeLabel={(chip) => `Remove baseline ${chip.text}`}
        onRemove={onRemove}
        focusWhenEmpty={() => toggle.current}
      />
    </div>
  )
}

/** The form adding a baseline: its suite, its machine, then its commit, which adds it. */
function BaselineForm({ suites, onAdd }: Pick<Props, 'suites' | 'onAdd'>) {
  const [suite, setSuite] = useState<string | null>(null)
  const [machine, setMachine] = useState<Suggestion | null>(null)
  const schema = suites.find((entry) => entry.name === suite)
  const { suggestions: machineSuggestions } = useMachineSuggestions(
    suite ?? '',
    schema !== undefined,
  )
  const filters = useMemo(() => machine && { machine: machine.key }, [machine])

  return (
    <div className={styles.baselineForm} role="group" aria-label="New baseline">
      <Select
        label="Baseline suite"
        options={suites.map(({ name }) => ({ value: name, label: name }))}
        value={suite}
        placeholder="-- Suite --"
        onChange={(name) => {
          setSuite(name)
          setMachine(null)
        }}
      />
      <Combobox
        label="Baseline machine"
        suggestions={machineSuggestions}
        value={machine}
        onChange={setMachine}
        placeholder={schema ? 'Select a machine...' : 'Select a suite first'}
        isDisabled={schema === undefined}
      />
      {schema !== undefined && filters !== null ? (
        <CommitPicker
          label="Baseline commit"
          schema={schema}
          filters={filters}
          onPick={(commit) => onAdd({ suite: schema.name, machine: filters.machine, commit })}
          placeholder="Select a commit..."
        />
      ) : (
        <Combobox
          label="Baseline commit"
          suggestions={NO_SUGGESTIONS}
          onPick={() => {}}
          placeholder="Select a machine first"
          isDisabled
        />
      )}
    </div>
  )
}
