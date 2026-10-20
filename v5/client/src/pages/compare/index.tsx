import { useCallback, useRef, useState } from 'react'
import { AGGREGATION_OPTIONS, type Aggregation } from '../../aggregation'
import { useSuites } from '../../api/suites'
import { ActionButton } from '../../components/action-button'
import { ControlsPanel } from '../../components/controls-panel'
import { ErrorMessage, Loading } from '../../components/feedback'
import { RegexFilter } from '../../components/regex-filter'
import { Select } from '../../components/select'
import { labelOf } from '../../schema'
import { useUrlState, useVisitKey } from '../../url-state'
import { ValueStore } from '../../value-store'
import type { NoiseKnob } from './comparison'
import { AddToRegression } from './add-to-regression'
import { ColumnsMenu } from './columns-menu'
import { chosenRuns, failedRuns, runCount, waiting } from './loading'
import { useMetric } from './metrics'
import { CompareChart } from './compare-chart'
import { CompareTable } from './compare-table'
import { NoiseControls } from './noise-controls'
import { NOISE_PARAMS, noiseSettings, PARAMS } from './settings'
import { useShadowLines, useShadows } from './shadows'
import { ShadowStatus } from './shadow-status'
import { SidePanel } from './side-panel'
import { SummaryBar } from './summary-bar'
import { useComparison } from './use-comparison'
import { useComparisonTable } from './use-comparison-table'
import { useProfileLinks } from './use-profile-links'
import { useSides } from './use-side'
import styles from './compare.module.css'

/**
 * The Compare page (CP1-CP9), started afresh whenever the user navigates to it -- a link to another
 * comparison while on this one, say -- so that it shows what the new URL names.
 */
export default function Compare() {
  return <ComparePage key={useVisitKey()} />
}

function ComparePage() {
  const [settings, update] = useUrlState(PARAMS)
  const suites = useSuites()
  // The test whose row is hovered in the table, and the one whose bar is hovered on the chart (CP5).
  const [emphasis] = useState(() => new ValueStore<string | null>(null))
  const [hovered] = useState(() => new ValueStore<string | null>(null))

  const sides = useSides(settings, update, suites)
  const { a, b } = sides
  // The button pinning a shadow, which takes the focus once the last shadow is dismissed (CP8).
  const pinButton = useRef<HTMLButtonElement>(null)
  const shadows = useShadows(settings.shadow, sides, suites.data, update)
  const { offered, metric } = useMetric(a, b, settings, update, suites)
  const profiles = useProfileLinks(a, b)
  const comparison = useComparison(sides, metric, settings)
  const table = useComparisonTable(comparison, settings, update, profiles.links)
  const lines = useShadowLines(
    shadows.shadows,
    a.schema,
    metric,
    settings,
    comparison,
    table.plotted,
  )

  const onNoise = useCallback(
    (knob: NoiseKnob, value: number | null) => update({ [NOISE_PARAMS[knob]]: value }),
    [update],
  )

  // Neither side has a suite whose schema is known: none is picked, or the suites the URL names
  // have not loaded.
  const noSchema = a.schema === undefined && b.schema === undefined
  const noise = noiseSettings(settings)
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
        <SidePanel
          side={b}
          title="Side B (New)"
          suites={suites.data ?? []}
          action={
            comparison.tests !== undefined && (
              <ActionButton ref={pinButton} reason={shadows.pinReason} onClick={shadows.pin}>
                Pin as shadow
              </ActionButton>
            )
          }
        />
      </div>
      <ControlsPanel>
        <div className={styles.settings}>
          {!noSchema && offered.length === 0 ? (
            <p className={styles.note}>No metric can be compared.</p>
          ) : (
            <Select
              label="Metric"
              options={offered.map((entry) => ({ value: entry.name, label: labelOf(entry) }))}
              value={metric?.name ?? null}
              placeholder="-- Select metric --"
              onChange={(value) => update({ metric: value })}
              isDisabled={noSchema}
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
            noise={noise}
            onNoise={onNoise}
            hideNoise={settings.hide_noise}
            onHideNoise={(hide) => update({ hide_noise: hide })}
          />
        </div>
      </ControlsPanel>
      <ControlsPanel>
        <AddToRegression
          suite={b.settings.suite}
          schema={b.schema}
          machine={b.settings.machine}
          commit={b.settings.commit}
          metric={metric?.name ?? ''}
          metricLabel={metric === undefined ? '' : labelOf(metric)}
          rows={comparison.tests === undefined ? undefined : table.plotted}
          swapped={sides.swapped}
        />
      </ControlsPanel>
      {failed.length > 0 && (
        <ErrorMessage
          context={`The samples of ${runCount(failed.length)} could not be loaded`}
          error={failed[0].error}
          onRetry={() => failed.forEach((state) => state.retry())}
        />
      )}
      <ShadowStatus shadows={shadows} lines={lines} pinButton={pinButton} />
      {profiles.failure.error !== null && (
        <ErrorMessage
          context="The profiles could not be listed"
          error={profiles.failure.error}
          onRetry={profiles.failure.retry}
        />
      )}
      {wait?.kind === 'loading' ? (
        <Loading label={wait.label} />
      ) : wait?.kind === 'missing' ? (
        <p className={styles.note}>{wait.text}</p>
      ) : wait === null ? (
        <>
          <CompareChart
            rows={table.plotted}
            shadows={lines}
            noisePct={noise.pct}
            revision={[...chosenRuns(a), '|', ...chosenRuns(b), '|', metric?.name].join('\n')}
            emphasis={emphasis}
            hovered={hovered}
          />
          <SummaryBar counts={table.counts} />
          <CompareTable
            {...table.view}
            menu={
              <ColumnsMenu shown={settings.columns} onChange={(keys) => update({ columns: keys })} />
            }
            hovered={hovered}
            emphasis={emphasis}
          />
        </>
      ) : null}
    </section>
  )
}
