import { useDeferredValue, useEffect, useMemo } from 'react'
import { Link, useParams } from 'react-router'
import { VisuallyHidden } from 'react-aria-components'
import { api, authedApi, errorMessage, MAX_PAGE_SIZE, unwrap, type Schemas } from '../../api/client'
import { runKey, useRun, useRunProfiles } from '../../api/runs'
import type { SuiteSchema } from '../../api/suites'
import { useCursorPages, type CursorPages } from '../../api/use-cursor-pages'
import { ButtonLink } from '../../components/button-link'
import { CommitLink } from '../../components/commit-link'
import { ControlsPanel } from '../../components/controls-panel'
import { DataTable, type Column } from '../../components/data-table'
import { Alert, ErrorMessage, Loaded, Loading } from '../../components/feedback'
import { InfoBox, InfoRow } from '../../components/info-box'
import { SearchInput } from '../../components/search-input'
import { Select } from '../../components/select'
import { useTextFilter } from '../../components/text-filter'
import { WithSchema } from '../../components/with-schema'
import { compareStrings, formatTimestamp, plural, uuidPrefix } from '../../format'
import { comparePath, machinePath, profilesPath } from '../../paths'
import {
  defaultMetric,
  formatMetricValue,
  isNumeric,
  labelOf,
  metricOptions,
  type Metric,
} from '../../schema'
import { stringParam, trimmedStringParam, useUrlState } from '../../url-state'
import { ActionRow } from './action-row'
import { CompareWithPrevious } from './compare-with-previous'
import styles from './details.module.css'

type Run = Schemas['RunDetail']
type Sample = Schemas['Sample']

const PARAMS = {
  /** The metric whose values the samples table shows; none in the URL means the default one. */
  metric: stringParam(),
  test_filter: trimmedStringParam(),
}

/** The Run Detail page (DT2). */
export default function RunDetail() {
  const { suite = '', uuid = '' } = useParams()
  return (
    <section>
      <h1>Run: {uuid}</h1>
      <WithSchema suite={suite}>
        {/* Keyed, so that nothing of a run's page, an open prompt say, stays on another's. */}
        {(schema) => <RunContent key={`${suite}/${uuid}`} schema={schema} uuid={uuid} />}
      </WithSchema>
    </section>
  )
}

/** Every sample of the run `uuid` (E6), fetched page after page. */
function useSamples(suite: string, uuid: string) {
  return useCursorPages({
    queryKey: [...runKey(suite, uuid), 'samples'],
    fetchPage: (cursor, signal) =>
      unwrap(
        api.GET('/api/suites/{testsuite}/runs/{uuid}/samples', {
          // I2's largest page: a run can have thousands of samples.
          params: { path: { testsuite: suite, uuid }, query: { cursor, limit: MAX_PAGE_SIZE } },
          signal,
        }),
      ),
    // A run's samples never change (E6).
    staleTime: Infinity,
  })
}

function RunContent({ schema, uuid }: { schema: SuiteSchema; uuid: string }) {
  const suite = schema.name
  const run = useRun(suite, uuid)
  // Fetched alongside the run rather than once it has loaded, since they take the longest. The
  // page shows them once the run has loaded, so that one that does not exist shows only that.
  const samples = useSamples(suite, uuid)
  const profiles = useRunProfiles(suite, uuid)
  const [settings, update] = useUrlState(PARAMS)

  const named = schema.metrics.find((entry) => entry.name === settings.metric)
  const fallback = defaultMetric(schema)
  const metric = named ?? fallback
  // A metric the suite does not have is dropped (AR2 "State"), and the default one is left out of
  // the URL like any setting at its default, as soon as they are read, since the schema lists them.
  const unusable = settings.metric !== '' && (named === undefined || named === fallback)
  useEffect(() => {
    if (unusable) update({ metric: '' })
  }, [unusable, update])

  return (
    <Loaded isPending={run.isPending} error={run.error} onRetry={() => void run.refetch()}>
      {run.data && (
        <>
          <RunInfo schema={schema} run={run.data} />
          <Actions schema={schema} run={run.data} metric={metric} />
          <Samples
            schema={schema}
            uuid={uuid}
            samples={samples}
            profiles={profiles.data}
            profilesError={profiles.error}
            metric={metric}
            onMetric={(name) => update({ metric: name === fallback?.name ? '' : name })}
            filterText={settings.test_filter}
            onFilter={(text) => update({ test_filter: text })}
          />
        </>
      )}
    </Loaded>
  )
}

/** The run, its machine, its commit, when it was submitted, and its parameters (DT2). */
function RunInfo({ schema, run }: { schema: SuiteSchema; run: Run }) {
  const suite = schema.name
  const parameters = Object.entries(run.run_parameters).sort(([a], [b]) => compareStrings(a, b))
  return (
    <InfoBox label="Run">
      <InfoRow label="UUID">{run.uuid}</InfoRow>
      <InfoRow label="Machine">
        <Link to={machinePath(suite, run.machine)}>{run.machine}</Link>
      </InfoRow>
      <InfoRow label="Commit">
        <CommitLink schema={schema} value={run.commit} />
      </InfoRow>
      <InfoRow label="Submitted">{formatTimestamp(run.submitted_at)}</InfoRow>
      {parameters.map(([key, value]) => (
        <InfoRow key={key} label={key}>
          {typeof value === 'string' ? value : JSON.stringify(value)}
        </InfoRow>
      ))}
    </InfoBox>
  )
}

interface ActionsProps {
  schema: SuiteSchema
  run: Run
  /** The metric selected on the page, which the comparisons compare. */
  metric: Metric | undefined
}

/** Compare with..., Compare with previous commit, and Delete run, with its confirmation (DT2). */
function Actions({ schema, run, metric }: ActionsProps) {
  const suite = schema.name
  const alone = { suite, machine: run.machine, commit: run.commit, runs: [run.uuid] }
  return (
    <ActionRow
      deletion={{
        suite,
        label: 'Delete run',
        scope: 'manage',
        expected: uuidPrefix(run.uuid),
        message: (
          <p>
            Delete this run of <strong>{run.machine}</strong>, with its samples and profiles? This
            cannot be undone.
          </p>
        ),
        onDelete: () =>
          unwrap(
            authedApi.DELETE('/api/suites/{testsuite}/runs/{uuid}', {
              params: { path: { testsuite: suite, uuid: run.uuid } },
            }),
          ),
        leaveTo: machinePath(suite, run.machine),
      }}
    >
      <ButtonLink to={comparePath(alone, undefined, metric?.name)}>Compare with...</ButtonLink>
      <CompareWithPrevious schema={schema} run={run} metric={metric?.name}>
        Compare with previous commit
      </CompareWithPrevious>
    </ActionRow>
  )
}

/** A row of the samples table: one sample, and a key telling it from the test's others. */
interface Row {
  key: string
  sample: Sample
}

const rowKey = (row: Row) => row.key
const testOf = (row: Row) => row.sample.test

interface SamplesProps {
  schema: SuiteSchema
  uuid: string
  samples: CursorPages<Sample>
  /** The tests of the run that have a profile, once known. */
  profiles: Schemas['RunProfile'][] | undefined
  profilesError: Error | null
  /** The metric shown, or none when the suite has no metrics. */
  metric: Metric | undefined
  onMetric(name: string): void
  /** The test filter's text, as the URL keeps it. */
  filterText: string
  onFilter(text: string): void
}

/**
 * The run's samples, sorted by test, one row per sample, so that a test's repetitions are rows of
 * their own, with the selected metric's value and a link to the test's profile, if it has one.
 * They are shown as they arrive, page after page, and filtered by test name locally (DT2).
 */
function Samples(props: SamplesProps) {
  const { schema, uuid, samples, profiles, profilesError, metric, onMetric } = props
  const suite = schema.name
  // Sorted, filtered and rendered once React has had the time, so that pages arriving, and a new
  // metric, do not hold up typing in the filter either.
  const items = useDeferredValue(samples.items)
  const rows = useMemo(() => sortedRows(items), [items])
  const filter = useTextFilter(rows, testOf, props.filterText, props.onFilter)
  const columns = useDeferredValue(
    useMemo(() => sampleColumns(suite, uuid, metric, profiles), [suite, uuid, metric, profiles]),
  )

  let content
  if (samples.error && !samples.hasPages) {
    content = <ErrorMessage error={samples.error} onRetry={samples.retry} />
  } else if (samples.isPending) {
    content = <Loading />
  } else {
    let summary
    if (!samples.isComplete && !samples.error) {
      summary = `Loading samples... ${rows.length} so far.`
    } else {
      summary = filter.active
        ? `${filter.rows.length} of ${plural(rows.length, 'sample')} matching`
        : plural(rows.length, 'sample')
      if (samples.error) summary += ' (incomplete: loading the rest failed)'
    }
    content = (
      <>
        {samples.error && <ErrorMessage error={samples.error} onRetry={samples.retry} />}
        <p className={styles.summary} role="status">
          {summary}
        </p>
        <DataTable
          label="Samples"
          columns={columns}
          rows={filter.rows}
          rowKey={rowKey}
          empty={filter.active ? 'No tests match the filter.' : 'This run has no samples.'}
        />
      </>
    )
  }

  return (
    <>
      <h2 className={styles.heading}>Samples</h2>
      <ControlsPanel>
        {metric !== undefined && (
          <Select
            label="Metric"
            options={metricOptions(schema)}
            value={metric.name}
            onChange={onMetric}
          />
        )}
        <SearchInput search={filter.input} label="Filter tests" placeholder="Filter tests..." />
      </ControlsPanel>
      {profilesError && (
        <Alert>The profiles could not be listed: {errorMessage(profilesError)}</Alert>
      )}
      {content}
    </>
  )
}

/** `samples`, sorted by test name, each keyed by its test and its rank among the test's samples. */
function sortedRows(samples: Sample[]): Row[] {
  const seen = new Map<string, number>()
  const rows = samples.map((sample) => {
    const rank = seen.get(sample.test) ?? 0
    seen.set(sample.test, rank + 1)
    return { key: `${rank}:${sample.test}`, sample }
  })
  // Stable, so that a test's samples stay in the order the API gave them.
  return rows.sort((a, b) => compareStrings(a.sample.test, b.sample.test))
}

function sampleColumns(
  suite: string,
  uuid: string,
  metric: Metric | undefined,
  profiles: Schemas['RunProfile'][] | undefined,
): Column<Row>[] {
  const columns: Column<Row>[] = [{ id: 'test', header: 'Test', cell: testOf }]
  if (metric !== undefined) {
    columns.push({
      id: 'value',
      header: labelOf(metric),
      looks: isNumeric(metric) ? ['numeric', 'nowrap'] : [],
      cell: (row) => formatMetricValue(row.sample.metrics[metric.name], metric),
    })
  }
  const profiled = new Set(profiles?.map((profile) => profile.test))
  if (profiled.size > 0) {
    columns.push({
      id: 'profile',
      header: <VisuallyHidden>Profile</VisuallyHidden>,
      looks: ['nowrap'],
      cell: (row) =>
        profiled.has(row.sample.test) && (
          <Link to={profilesPath({ suite, run: uuid, test: row.sample.test })}>Profile</Link>
        ),
    })
  }
  return columns
}
