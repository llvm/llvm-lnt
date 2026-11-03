import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router'
import { VisuallyHidden } from 'react-aria-components'
import { PAGE_SIZE, type Schemas } from '../../api/client'
import { queryKeys } from '../../api/keys'
import { deleteRegression, fetchRegressionPage, type RegressionPage } from '../../api/regressions'
import { refOf, type Suite } from '../../api/suites'
import { useCursorPager } from '../../api/use-cursor-pager'
import { useScopeGate } from '../../auth/scope'
import { Combobox } from '../../components/combobox'
import { ListedCommitLink } from '../../components/commit-link'
import { Confirmation } from '../../components/confirmation'
import { DataTable, type Column } from '../../components/data-table'
import { ErrorMessage } from '../../components/feedback'
import { hasMachine } from '../../api/machines'
import { LinkableText } from '../../components/linkable-text'
import { useMachineSuggestions } from '../../components/machine-suggestions'
import { CursorPager } from '../../components/pagination'
import { StateBadge, StateChips } from '../../components/regression-state'
import { Select } from '../../components/select'
import { useRowConfirm } from '../../components/use-row-confirm'
import { useServerSearch } from '../../components/use-server-search'
import { uuidColumn } from '../../components/uuid-column'
import { formatTimestamp, MISSING, regressionTitle, uuidPrefix } from '../../format'
import { regressionPath } from '../../paths'
import { metricOptions } from '../../schema'
import { useDropUnusable } from '../../url-state'
import { CreateRegression } from './create-regression'
import { isFiltered, type RegressionFilters } from './settings'
import { TabContent } from './tab-content'
import styles from './test-suites.module.css'

type Regression = Schemas['Regression']

/** How long a bug may be in its cell before it is cut short (TS5). */
const BUG_LENGTH = 30

interface Props {
  schema: Suite
  search: string
  onSearch(text: string): void
  filters: RegressionFilters
  onFilters(changes: Partial<RegressionFilters>): void
}

/** The regressions of the suite, newest first, with the triage filters and actions of TS5. */
export function RegressionsTab({ schema, search, onSearch, filters, onFilters: update }: Props) {
  const suite = refOf(schema)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const input = useServerSearch(search, onSearch)
  const [creating, setCreating] = useState(false)
  const tableRef = useRef<HTMLTableElement>(null)
  // The regression whose deletion is being confirmed.
  const rowConfirm = useRowConfirm<Regression>(tableRef)
  const deleting = rowConfirm.item
  const triage = useScopeGate('triage', suite)

  // A machine or a metric the suite does not have is dropped (AR2 "State"): a metric as soon as it
  // is read, since the schema lists them, and a machine once the machine list shows it is unknown.
  const { machines, suggestions: machineSuggestions } = useMachineSuggestions(suite)
  useDropUnusable(
    machines,
    (list) => filters.machine === '' || hasMachine(list, filters.machine),
    () => update({ machine: '' }),
  )
  // The API answers an unknown machine with a 404, so the regressions are not asked for until the
  // machine list has confirmed the machine. If the list fails, they are asked for anyway.
  const machineReady =
    filters.machine === '' ||
    machines.isError ||
    (machines.data !== undefined && hasMachine(machines.data, filters.machine))
  const knownMetric =
    filters.metric === '' || schema.metrics.some((entry) => entry.name === filters.metric)
  useEffect(() => {
    if (!knownMetric) update({ metric: '' })
  }, [knownMetric, update])
  // Not asked for while it is being dropped, which the API would refuse.
  const metric = knownMetric ? filters.metric : ''

  const query = {
    search: search || undefined,
    state: filters.state.length > 0 ? filters.state : undefined,
    machine: filters.machine || undefined,
    metric: metric || undefined,
    has_commit: filters.has_commit ? undefined : false,
    sort: '-created_at',
    limit: PAGE_SIZE,
  } as const
  const pager = useCursorPager({
    queryKey: [...queryKeys.regressions(suite), query],
    fetchPage: (cursor, signal) => fetchRegressionPage(suite, { ...query, cursor }, signal),
    enabled: machineReady,
  })
  const page = pager.page

  const remove = useMutation({
    mutationFn: (regression: Regression) => deleteRegression(suite, regression.uuid),
    onSuccess: async () => {
      // Drop what no page shows, such as the regression's detail, so that it is not shown again
      // (AR16).
      queryClient.removeQueries({ queryKey: queryKeys.regressions(suite), type: 'inactive' })
      await queryClient.invalidateQueries({ queryKey: queryKeys.regressions(suite) })
      rowConfirm.done()
    },
  })

  // A click anywhere on a row opens the regression, except on what the row holds that does
  // something of its own (its links and its Delete button), a modified click, which AR2 "Routing"
  // leaves to the browser, and a click that ends selecting the row's text.
  const openRow = (regression: Regression) => (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return
    if ((event.target as Element).closest('a, button')) return
    // Not a click in a commit's card, which React passes up from its portal.
    if (!event.currentTarget.contains(event.target as Node)) return
    if (window.getSelection()?.toString()) return
    navigate(regressionPath(suite, regression.uuid))
  }

  const controls = (
    <>
      <StateChips selected={filters.state} onChange={(state) => update({ state })} />
      <Combobox
        label="Machine"
        value={filters.machine ? { key: filters.machine, text: filters.machine } : null}
        onChange={(machine) => update({ machine: machine?.key ?? '' })}
        suggestions={machineSuggestions}
        placeholder={machines.isPending ? 'Loading machines...' : 'Any machine'}
      />
      <Select
        label="Metric"
        options={[{ value: '', label: 'Any metric' }, ...metricOptions(schema)]}
        value={metric}
        onChange={(value) => update({ metric: value })}
      />
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={!filters.has_commit}
          onChange={(event) => update({ has_commit: !event.target.checked })}
        />
        No commit set
      </label>
    </>
  )

  const toolbar = (
    <>
      {machines.isError && (
        <ErrorMessage error={machines.error} onRetry={() => void machines.refetch()} />
      )}
      <div className={styles.toolbar}>
        <button
          type="button"
          {...triage}
          aria-expanded={creating}
          onClick={() => setCreating(!creating)}
        >
          New Regression
        </button>
      </div>
      {creating && <CreateRegression schema={schema} onCancel={() => setCreating(false)} />}
      {deleting && (
        <Confirmation
          key={deleting.uuid}
          expected={uuidPrefix(deleting.uuid)}
          gate={triage}
          onConfirm={() => remove.mutateAsync(deleting)}
          onCancel={rowConfirm.cancel}
        >
          <p>
            Delete the regression <strong>{regressionTitle(deleting)}</strong>, and its indicators?
            This cannot be undone.
          </p>
        </Confirmation>
      )}
    </>
  )

  // One deletion at a time.
  const deleteGate = { ...triage, disabled: triage.disabled || remove.isPending }
  const filtered = search !== '' || isFiltered(filters)
  return (
    <TabContent
      search={input}
      searchLabel="Search regressions by title or UUID prefix"
      placeholder="Search by title or UUID..."
      controls={controls}
      toolbar={toolbar}
      isPending={pager.isPending}
      error={pager.error}
      onRetry={pager.retry}
    >
      {page && (
        <>
          <DataTable
            label="Regressions"
            ref={tableRef}
            columns={columns(schema, page, deleteGate, rowConfirm.open)}
            rows={page.items}
            rowKey={(regression) => regression.uuid}
            rowProps={(regression) => ({
              className: styles.clickable,
              onClick: openRow(regression),
            })}
            confirming={(regression) => regression.uuid === deleting?.uuid}
            empty={
              // A later page may only have run out.
              pager.hasPrevious
                ? 'No more regressions.'
                : filtered
                  ? 'No regressions match these filters.'
                  : 'No regressions yet.'
            }
            busy={input.pending || pager.isUpdating}
          />
          <CursorPager pager={pager} label="Regressions pagination" />
        </>
      )}
    </TabContent>
  )
}

function columns(
  schema: Suite,
  page: RegressionPage,
  deleteGate: ReturnType<typeof useScopeGate>,
  onDelete: (regression: Regression, button: HTMLElement) => void,
): Column<Regression>[] {
  const suite = refOf(schema)
  return [
    uuidColumn('uuid', 'UUID', (uuid) => regressionPath(suite, uuid)),
    {
      id: 'title',
      header: 'Title',
      className: styles.title,
      cell: (regression) => (
        <Link to={regressionPath(suite, regression.uuid)}>{regressionTitle(regression)}</Link>
      ),
    },
    { id: 'state', header: 'State', cell: (regression) => <StateBadge state={regression.state} /> },
    {
      id: 'commit',
      header: 'Commit',
      looks: ['nowrap'],
      cell: ({ commit }) =>
        commit === null ? (
          MISSING
        ) : (
          <ListedCommitLink schema={schema} value={commit} commit={page.commits.get(commit)} />
        ),
    },
    {
      id: 'machines',
      header: 'Machines',
      looks: ['numeric'],
      cell: (regression) => regression.machine_count,
    },
    {
      id: 'tests',
      header: 'Tests',
      looks: ['numeric'],
      cell: (regression) => regression.test_count,
    },
    {
      id: 'created',
      header: 'Created',
      looks: ['nowrap'],
      cell: (regression) => formatTimestamp(regression.created_at),
    },
    {
      id: 'bug',
      header: 'Bug',
      looks: ['nowrap'],
      cell: ({ bug }) => (bug === null ? MISSING : <LinkableText text={bug} max={BUG_LENGTH} />),
    },
    {
      id: 'delete',
      header: <VisuallyHidden>Actions</VisuallyHidden>,
      cell: (regression) => (
        <button
          type="button"
          {...deleteGate}
          aria-label={`Delete regression ${uuidPrefix(regression.uuid)}`}
          onClick={(event) => onDelete(regression, event.currentTarget)}
        >
          Delete
        </button>
      ),
    },
  ]
}
