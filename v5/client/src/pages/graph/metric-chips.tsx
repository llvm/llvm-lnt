import { useMemo, useRef } from 'react'
import { ChipList } from '../../components/chip-list'
import { Combobox } from '../../components/combobox'
import { useLocalSuggestions, type Suggestion } from '../../components/suggestions'
import { labelOf, type Metric } from '../../schema'
import styles from './graph.module.css'

interface Props {
  /** The metrics added, in order. */
  metrics: readonly Metric[]
  /** The suite's numeric metrics, in schema order: those that can be plotted. */
  all: readonly Metric[]
  isDisabled: boolean
  onChange(metrics: string[]): void
}

/**
 * The metrics plotted (GR1): a combobox adding one, filtering the suite's numeric metrics as the
 * user types, by label or name, and a chip per metric added, which removes it. The chips are in the
 * order of the chart's panels.
 */
export function MetricChips({ metrics, all, isDisabled, onChange }: Props) {
  const added = metrics.map((metric) => metric.name)
  const offered = useMemo(
    () =>
      all
        .filter((metric) => !metrics.includes(metric))
        .map(
          (metric): Suggestion => ({
            key: metric.name,
            text: labelOf(metric),
            ...(metric.display_name === null ? {} : { aliases: [metric.name] }),
          }),
        ),
    [all, metrics],
  )
  const suggestions = useLocalSuggestions(offered)

  const root = useRef<HTMLDivElement>(null)
  const chips = metrics.map((metric) => ({ key: metric.name, text: labelOf(metric) }))

  return (
    <div className={styles.chipInput} ref={root}>
      <Combobox
        label="Metrics"
        suggestions={suggestions}
        onPick={(picked) => onChange([...added, picked.key])}
        placeholder="Add a metric..."
        isDisabled={isDisabled}
      />
      <ChipList
        label="Metrics added"
        chips={chips}
        removeLabel={(chip) => `Remove ${chip.text}`}
        onRemove={(metric) => onChange(added.filter((entry) => entry !== metric))}
        focusWhenEmpty={() => root.current?.querySelector('input')}
      />
    </div>
  )
}
