import { useMemo } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router'
import { VisuallyHidden } from 'react-aria-components'
import { authedApi, MAX_PAGE_SIZE, PAGE_SIZE, unwrap, type Schemas } from '../../api/client'
import {
  cancelCommit,
  commitChanged,
  commitKey,
  storeCommit,
  useCommit,
} from '../../api/commits'
import { queryKeys } from '../../api/keys'
import { fetchRegressions } from '../../api/regressions'
import { fetchRuns } from '../../api/runs'
import type { SuiteSchema } from '../../api/suites'
import { useCursorPager } from '../../api/use-cursor-pager'
import { useCursorPages, type CursorPages } from '../../api/use-cursor-pages'
import { useScopeGate } from '../../auth/scope'
import { ButtonLink } from '../../components/button-link'
import { ControlsPanel } from '../../components/controls-panel'
import { DataTable, type Column } from '../../components/data-table'
import { ErrorMessage, Loaded, Loading } from '../../components/feedback'
import { InfoBox, InfoRow } from '../../components/info-box'
import { InlineEdit } from '../../components/inline-edit'
import { CursorPager } from '../../components/pagination'
import { runColumns } from '../../components/run-columns'
import { SearchInput } from '../../components/search-input'
import { useTextFilter } from '../../components/use-text-filter'
import { WithSchema } from '../../components/with-schema'
import { compareStrings, plural } from '../../format'
import { commitPath } from '../../paths'
import {
  commitDisplayValue,
  defaultMetric,
  formatFieldValue,
  labelOf,
  type Commit,
} from '../../schema'
import { trimmedStringParam, useUrlState } from '../../url-state'
import { suiteTabPath } from '../test-suites/settings'
import { DetailActionRow } from './action-row'
import { CompareWithPrevious, NO_ORDINAL } from './compare-with-previous'
import { RegressionsTable } from './regressions-table'
import styles from './details.module.css'

type CommitDetail = Schemas['CommitDetail']
type Run = Schemas['Run']

/** D5's limit on a tag. */
const TAG_LENGTH = 256

const PARAMS = { machine_filter: trimmedStringParam() }

/** The Commit Detail page (DT3). */
export default function CommitDetailPage() {
  const { suite = '', value = '' } = useParams()
  return (
    <section>
      {/* The commit string itself rather than its display value (DT3). */}
      <h1>Commit: {value}</h1>
      <WithSchema suite={suite}>
        {/* Keyed, so that nothing of a commit's page, an open editor say, stays on another's. */}
        {(schema) => <CommitContent key={`${suite}/${value}`} schema={schema} value={value} />}
      </WithSchema>
    </section>
  )
}

/** Every run at the commit `value` (E4), fetched page after page. */
function useRuns(suite: string, value: string) {
  // I2's largest page: a commit can have runs on many machines.
  const query = { commit: value, sort: '-submitted_at', limit: MAX_PAGE_SIZE } as const
  return useCursorPages({
    // Apart from the lists of runs shown a page at a time, which hold their commits resolved.
    queryKey: [...queryKeys.runs(suite), 'at commit', query],
    fetchPage: (cursor, signal) => fetchRuns(suite, { ...query, cursor }, signal),
  })
}

function CommitContent({ schema, value }: { schema: SuiteSchema; value: string }) {
  const suite = schema.name
  const commit = useCommit(suite, value)
  // Fetched alongside the commit rather than once it has loaded, since they may take the longest.
  // The page shows them once the commit has loaded, so that one that does not exist shows only
  // that.
  const runs = useRuns(suite, value)
  return (
    <Loaded isPending={commit.isPending} error={commit.error} onRetry={() => void commit.refetch()}>
      {commit.data && (
        <>
          <CommitInfo schema={schema} commit={commit.data} />
          <Actions schema={schema} commit={commit.data} />
          <CommitRegressions suite={suite} value={value} />
          <CommitRuns schema={schema} runs={runs} />
        </>
      )}
    </Loaded>
  )
}

/**
 * Change the commit `value` with `PATCH /commits/{value}` (E3), and show what the API returned.
 * Changes are sent one after the other, so that the answer to an earlier one, arriving late, does
 * not replace a later one's.
 */
function useUpdateCommit(suite: string, value: string) {
  const queryClient = useQueryClient()
  const update = useMutation({
    scope: { id: JSON.stringify(commitKey(suite, value)) },
    // A fetch of the commit under way could land after the answer, and show it as it was.
    onMutate: () => cancelCommit(queryClient, suite, value),
    mutationFn: (body: Schemas['CommitUpdate']) =>
      unwrap(
        authedApi.PATCH('/api/suites/{testsuite}/commits/{value}', {
          params: { path: { testsuite: suite, value } },
          body,
        }),
      ),
    onSuccess: async (updated) => {
      // What shows the commit elsewhere fetches it again when next shown. The commit itself is
      // among it, so it is stored after, as the API returned it, which leaves it fresh. Its rows'
      // lookups of the commit before it on their machines follow its ordinal (see
      // `usePreviousCommit`).
      await commitChanged(queryClient, suite)
      storeCommit(queryClient, suite, updated)
    },
  })
  return update.mutateAsync
}

/** The range of an ordinal: D5's INTEGER column. */
const ORDINAL_MIN = -(2 ** 31)
const ORDINAL_MAX = 2 ** 31 - 1

/** Why `text` is not an ordinal, which is an integer its column can hold (DT3), if it is not. */
function invalidOrdinal(text: string): string | undefined {
  // Checked as digits first: `Number` reads more than an integer (`1e3`, `0x10`), and makes a
  // long enough one `Infinity`, which a request would send as null, clearing the ordinal.
  const ordinal = Number(text)
  return /^-?\d+$/.test(text) && ordinal >= ORDINAL_MIN && ordinal <= ORDINAL_MAX
    ? undefined
    : `An ordinal is an integer from ${ORDINAL_MIN} to ${ORDINAL_MAX}.`
}

/** The commit, its ordinal and tag, which a holder of `manage` scope can edit, and its fields. */
function CommitInfo({ schema, commit }: { schema: SuiteSchema; commit: CommitDetail }) {
  const update = useUpdateCommit(schema.name, commit.value)
  const manage = useScopeGate('manage')
  return (
    <InfoBox label="Commit">
      <InfoRow label="Commit" mono>
        {commit.value}
      </InfoRow>
      <InfoRow label="Ordinal">
        <InlineEdit
          label="Ordinal"
          value={commit.ordinal === null ? null : String(commit.ordinal)}
          gate={manage}
          invalid={invalidOrdinal}
          onSave={(text) => update({ ordinal: text === null ? null : Number(text) })}
        />
      </InfoRow>
      <InfoRow label="Tag">
        <InlineEdit
          label="Tag"
          value={commit.tag}
          gate={manage}
          maxLength={TAG_LENGTH}
          onSave={(tag) => update({ tag })}
        />
      </InfoRow>
      {schema.commit_fields.map((field) => (
        <InfoRow key={field.name} label={labelOf(field)}>
          {formatFieldValue(commit.fields[field.name], field.type)}
        </InfoRow>
      ))}
    </InfoBox>
  )
}

/** Previous commit, Next commit, and Delete commit, with its confirmation below them (DT3). */
function Actions({ schema, commit }: { schema: SuiteSchema; commit: CommitDetail }) {
  const suite = schema.name
  const { value } = commit
  const unordered = commit.ordinal === null
  // A link to `neighbour`, which it names on hover, or why there is none.
  const link = (neighbour: Commit | null, none: string, label: string) => (
    <ButtonLink
      to={neighbour && commitPath(suite, neighbour.value)}
      title={neighbour ? commitDisplayValue(neighbour, schema) : unordered ? NO_ORDINAL : none}
    >
      {label}
    </ButtonLink>
  )
  return (
    <DetailActionRow
      deletion={{
        suite,
        label: 'Delete commit',
        scope: 'manage',
        expected: value,
        message: (
          <p>
            Delete the commit <strong>{value}</strong> and all of its runs, with their samples and
            profiles? Regressions attributed to it are kept, without a commit. This cannot be
            undone.
          </p>
        ),
        busyMessage: 'Deleting a commit with many runs may take a while.',
        onDelete: () =>
          unwrap(
            authedApi.DELETE('/api/suites/{testsuite}/commits/{value}', {
              params: { path: { testsuite: suite, value } },
            }),
          ),
        leaveTo: suiteTabPath(suite, 'commits'),
      }}
    >
      {link(commit.previous, 'No commit comes before this one.', '← Previous commit')}
      {link(commit.next, 'No commit comes after this one.', 'Next commit →')}
    </DetailActionRow>
  )
}

/** The regressions attributed to the commit, newest first, a page at a time (DT3). */
function CommitRegressions({ suite, value }: { suite: string; value: string }) {
  const query = { commit: value, sort: '-created_at', limit: PAGE_SIZE } as const
  const pager = useCursorPager({
    // Apart from the Regressions tab's lists, which hold the same pages, with their commits
    // resolved.
    queryKey: [...queryKeys.regressions(suite), 'without commits', query],
    fetchPage: (cursor, signal) => fetchRegressions(suite, { ...query, cursor }, signal),
  })
  const page = pager.page
  return (
    <>
      <h2 className={styles.heading}>Regressions</h2>
      <Loaded isPending={pager.isPending} error={pager.error} onRetry={pager.retry}>
        {page && (
          <>
            <RegressionsTable
              suite={suite}
              label="Regressions"
              regressions={page.items}
              // A later page may only have run out.
              empty={pager.hasPrevious ? 'No more regressions.' : 'No regressions at this commit.'}
              busy={pager.isUpdating}
            />
            <CursorPager pager={pager} label="Regressions pagination" />
          </>
        )}
      </Loaded>
    </>
  )
}

const runKey = (run: Run) => run.uuid
const machineOf = (run: Run) => run.machine

/** How many machines `runs` were measured on. */
function machineCount(runs: Run[]): number {
  return new Set(runs.map(machineOf)).size
}

/**
 * Every run at the commit, by machine and newest first on each, filtered by machine name locally,
 * each with a link comparing it with the commit before on its machine (DT3). They are shown as
 * they arrive, page after page.
 */
function CommitRuns({ schema, runs }: { schema: SuiteSchema; runs: CursorPages<Run> }) {
  const [settings, update] = useUrlState(PARAMS)
  // Stable, so that each machine's runs stay newest first, as the API gave them.
  const rows = useMemo(
    () => runs.items.toSorted((a, b) => compareStrings(a.machine, b.machine)),
    [runs.items],
  )
  const filter = useTextFilter(rows, machineOf, settings.machine_filter, (text) =>
    update({ machine_filter: text }),
  )
  const columns = useMemo(() => runsColumns(schema), [schema])
  const machines = useMemo(() => machineCount(rows), [rows])
  const shownMachines = useMemo(() => machineCount(filter.rows), [filter.rows])

  let content
  if (runs.error && !runs.hasPages) {
    content = <ErrorMessage error={runs.error} onRetry={runs.retry} />
  } else if (runs.isPending) {
    content = <Loading />
  } else {
    let summary
    if (!runs.isComplete && !runs.error) {
      summary = `Loading runs... ${rows.length} so far.`
    } else {
      const all = { runs: plural(rows.length, 'run'), machines: plural(machines, 'machine') }
      summary = filter.active
        ? `${filter.rows.length} of ${all.runs} across ${shownMachines} of ${all.machines}`
        : `${all.runs} across ${all.machines}`
      if (runs.error) summary += ' (incomplete: loading the rest failed)'
    }
    content = (
      <>
        {runs.error && <ErrorMessage error={runs.error} onRetry={runs.retry} />}
        <p className={styles.summary} role="status">
          {summary}
        </p>
        <DataTable
          label="Runs"
          columns={columns}
          rows={filter.rows}
          rowKey={runKey}
          empty={filter.active ? 'No machines match the filter.' : 'No runs at this commit.'}
        />
      </>
    )
  }

  return (
    <>
      <h2 className={styles.heading}>Runs</h2>
      <ControlsPanel>
        <SearchInput
          search={filter.input}
          label="Filter machines"
          placeholder="Filter machines..."
        />
      </ControlsPanel>
      {content}
    </>
  )
}

/** Every run has the same commit, which the table does not show, so none is resolved. */
const NO_COMMITS = new Map<string, Commit>()

function runsColumns(schema: SuiteSchema): Column<Run>[] {
  const { machine, run, submitted } = runColumns(schema, NO_COMMITS)
  // This page has no metric selector, so the link compares Run Detail's default metric (DT3).
  const metric = defaultMetric(schema)?.name
  return [
    machine,
    run,
    submitted,
    {
      id: 'compare',
      header: <VisuallyHidden>Compare</VisuallyHidden>,
      looks: ['nowrap'],
      cell: (row) => (
        <CompareWithPrevious schema={schema} run={row} metric={metric}>
          Compare with previous
        </CompareWithPrevious>
      ),
    },
  ]
}
