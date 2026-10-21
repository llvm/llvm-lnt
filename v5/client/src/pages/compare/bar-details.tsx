import { Fragment, useMemo } from 'react'
import { linkedAggregation } from '../../aggregation'
import { runRefKey, type SampleState } from '../../api/runs'
import { ButtonLink } from '../../components/button-link'
import dialog from '../../components/chart-dialog.module.css'
import { RunSamplesTable } from '../../components/run-samples-table'
import { graphPath } from '../../paths'
import type { Metric } from '../../schema'
import { tableColumns } from './columns'
import { testRuns, type ComparisonRow } from './comparison'
import type { Settings } from './settings'
import type { Side } from './use-side'

/** The columns of the table the details show a test's values with: all but the test's own. */
const VALUE_COLUMNS = tableColumns([]).filter((column) => column.id !== 'test')

/**
 * The runs that `side`'s samples for `test` come from, with those samples (CP2), from the samples
 * of its selected runs, which `states` holds: the page has them all once it shows a comparison.
 */
function useTestRuns(
  side: Side,
  states: ReadonlyMap<string, SampleState>,
  metric: string,
  test: string,
) {
  const { suite } = side.settings
  const { data: runs } = side.runs
  const { selected } = side
  return useMemo(() => {
    const sampled = (runs ?? []).flatMap((run) => {
      const samples = selected?.has(run.uuid)
        ? states.get(runRefKey({ suite, uuid: run.uuid }))?.samples
        : undefined
      return samples === undefined ? [] : [{ ...run, samples }]
    })
    return testRuns(sampled, metric, test)
  }, [runs, selected, states, suite, metric, test])
}

interface Props {
  /** The row of the test whose bar was clicked. */
  row: ComparisonRow
  a: Side
  b: Side
  /** The samples of the sides' runs, by `runRefKey`. */
  states: ReadonlyMap<string, SampleState>
  metric: Metric
  settings: Pick<Settings, 'sample_agg' | 'run_agg'>
  /** The test's Profiles page, if its row links to one (CP2). */
  profile: string | undefined
}

/**
 * What the details of a test whose bar was clicked on the chart show (CP3): its values, as the table
 * shows them, each side's runs with their samples, and links to the test's history on the Graph
 * page, in side B's context, and to its profiles.
 */
export function BarDetails({ row, a, b, states, metric, settings, profile }: Props) {
  const { test } = row
  const runsA = useTestRuns(a, states, metric.name, test)
  const runsB = useTestRuns(b, states, metric.name, test)
  const graph = graphPath({
    suite: b.settings.suite,
    machines: [b.settings.machine],
    metric: metric.name,
    test,
    sampleAgg: linkedAggregation(settings.sample_agg),
    runAgg: linkedAggregation(settings.run_agg),
  })

  return (
    <>
      <dl className={dialog.info}>
        {VALUE_COLUMNS.map((column) => (
          <Fragment key={column.id}>
            <dt>{column.header}</dt>
            <dd>{column.cell(row)}</dd>
          </Fragment>
        ))}
      </dl>
      {[
        { letter: 'A', side: a, runs: runsA },
        { letter: 'B', side: b, runs: runsB },
      ].map(({ letter, side, runs }) => (
        <div key={letter}>
          <h3 className={dialog.heading}>Side {letter}</h3>
          <RunSamplesTable
            label={`Side ${letter} runs`}
            suite={side.settings.suite}
            metric={metric}
            runs={runs}
          />
        </div>
      ))}
      <div className={dialog.actions}>
        <ButtonLink to={graph}>View on graph</ButtonLink>
        {profile !== undefined && <ButtonLink to={profile}>Profile</ButtonLink>}
      </div>
    </>
  )
}
