import { useCallback } from 'react'
import { AGGREGATION_OPTIONS, type Aggregation } from '../../aggregation'
import { useSuites } from '../../api/suites'
import { ControlsPanel } from '../../components/controls-panel'
import { ErrorMessage, Loading } from '../../components/feedback'
import { RegexFilter } from '../../components/regex-filter'
import { Select } from '../../components/select'
import { labelOf } from '../../schema'
import { useUrlState, useVisitKey } from '../../url-state'
import type { NoiseKnob } from './comparison'
import { failedRuns, runCount, waiting } from './loading'
import { useMetric } from './metrics'
import { CompareTable } from './compare-table'
import { NoiseControls } from './noise-controls'
import { NOISE_PARAMS, noiseSettings, PARAMS } from './settings'
import { SidePanel } from './side-panel'
import { SummaryBar } from './summary-bar'
import { useComparison } from './use-comparison'
import { useComparisonTable } from './use-comparison-table'
import { useSides } from './use-side'
import styles from './compare.module.css'

/**
 * The Compare page (CP1-CP7), started afresh whenever the user navigates to it -- a link to another
 * comparison while on this one, say -- so that it shows what the new URL names.
 */
export default function Compare() {
  return <ComparePage key={useVisitKey()} />
}

function ComparePage() {
  const [settings, update] = useUrlState(PARAMS)
  const suites = useSuites()

  const sides = useSides(settings, update, suites)
  const { a, b } = sides
  const { offered, metric } = useMetric(a, b, settings, update, suites)
  const comparison = useComparison(sides, metric, settings)
  const table = useComparisonTable(comparison, settings, update)

  const onNoise = useCallback(
    (knob: NoiseKnob, value: number | null) => update({ [NOISE_PARAMS[knob]]: value }),
    [update],
  )

  const failed = failedRuns(a, b, sides.states)
  const wait = waiting(a, b, sides.states, {
    suitesPending: suites.isPending,
    suitesFailed: suites.isError,
    offered: offered.length,
    metric: metric !== undefined,
    compared: comparison.tests !== undefined,
  })
  return (
    <section>
      <h1>Compare</h1>
      {suites.isError && (
        <ErrorMessage
          context="The test suites could not be listed"
          error={suites.error}
          onRetry={() => void suites.refetch()}
        />
      )}
      <div className={styles.sides}>
        <SidePanel side={a} title="Side A (Baseline)" suites={suites.data ?? []} />
        <button
          type="button"
          className={styles.swap}
          aria-label="Swap sides"
          title="Swap sides"
          onClick={sides.swap}
        >
          ⇄
        </button>
        <SidePanel side={b} title="Side B (New)" suites={suites.data ?? []} />
      </div>
      <ControlsPanel>
        <div className={styles.settings}>
          {a.settings.suite === '' && b.settings.suite === '' ? (
            <p className={styles.note}>Select a suite to load metrics...</p>
          ) : a.schema === undefined && b.schema === undefined ? null : offered.length === 0 ? (
            <p className={styles.note}>No metric can be compared.</p>
          ) : (
            <Select
              label="Metric"
              options={offered.map((entry) => ({ value: entry.name, label: labelOf(entry) }))}
              value={metric?.name ?? null}
              placeholder="-- Select metric --"
              onChange={(value) => update({ metric: value })}
            />
          )}
          <Select<Aggregation>
            label="Run aggregation"
            options={AGGREGATION_OPTIONS}
            value={settings.run_agg}
            onChange={(value) => update({ run_agg: value })}
          />
          <Select<Aggregation>
            label="Sample aggregation"
            options={AGGREGATION_OPTIONS}
            value={settings.sample_agg}
            onChange={(value) => update({ sample_agg: value })}
          />
          <RegexFilter
            filter={table.filter}
            label="Filter tests"
            placeholder="Filter tests..."
            regex={settings.test_filter_regex}
            onRegexChange={(regex) => update({ test_filter_regex: regex })}
          />
          <NoiseControls
            noise={noiseSettings(settings)}
            onNoise={onNoise}
            hideNoise={settings.hide_noise}
            onHideNoise={(hide) => update({ hide_noise: hide })}
          />
        </div>
      </ControlsPanel>
      {failed.length > 0 && (
        <ErrorMessage
          context={`The samples of ${runCount(failed.length)} could not be loaded`}
          error={failed[0].error}
          onRetry={() => failed.forEach((state) => state.retry())}
        />
      )}
      {wait?.kind === 'loading' ? (
        <Loading label={wait.label} />
      ) : wait?.kind === 'missing' ? (
        <p className={styles.note}>{wait.text}</p>
      ) : wait === null ? (
        <>
          <SummaryBar counts={table.counts} />
          <CompareTable {...table.view} />
        </>
      ) : null}
    </section>
  )
}
