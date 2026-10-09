import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router'
import { VisuallyHidden } from 'react-aria-components'
import clsx from 'clsx'
import { authedApi, unwrap, type Schemas } from '../../api/client'
import { queryKeys } from '../../api/keys'
import { useMachineNames } from '../../api/machines'
import { fetchRegressionPage, type RegressionPage } from '../../api/regressions'
import type { SuiteSchema } from '../../api/suites'
import { useCursorPager } from '../../api/use-cursor-pager'
import { useScopeGate } from '../../auth/scope'
import { Combobox } from '../../components/combobox'
import { ConfirmDelete } from '../../components/confirm-delete'
import { DataTable, type Column } from '../../components/data-table'
import { ErrorMessage } from '../../components/feedback'
import { CursorPager, PAGE_SIZE } from '../../components/pagination'
import { StateBadge, StateChips } from '../../components/regression-state'
import { Select } from '../../components/select'
import { useLocalSuggestions } from '../../components/suggestions'
import { useServerSearch } from '../../components/use-server-search'
import { uuidColumn } from '../../components/uuid-column'
import { formatTimestamp, MISSING, uuidPrefix } from '../../format'
import { commitPath, regressionPath } from '../../paths'
import { displayValueOf, labelOf } from '../../schema'
import { useDropUnusable } from '../../url-state'
import { CreateRegression } from './create-regression'
import { isFiltered, type RegressionFilters } from './settings'
import { TabContent } from './tab-content'
import styles from './test-suites.module.css'

type Regression = Schemas['Regression']

interface Props {
  schema: SuiteSchema
  search: string
  onSearch(text: string): void
  filters: RegressionFilters
  onFilters(changes: Partial<RegressionFilters>): void
}

/** The regressions of the suite, newest first, with the triage filters and actions of TS5. */
export function RegressionsTab({ schema, search, onSearch, filters, onFilters: update }: Props) {
  const suite = schema.name
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const input = useServerSearch(search, onSearch)
  const [creating, setCreating] = useState(false)
  // The regression whose deletion is being confirmed, with the button that asked for it, which
  // focus returns to on Cancel.
  const [deleting, setDeleting] = useState<{ regression: Regression; opener: HTMLElement } | null>(
    null,
  )
  const tableRef = useRef<HTMLTableElement>(null)
  const triage = useScopeGate('triage')

  // A machine or a metric the suite does not have is dropped (AR2 "State"): a metric as soon as it
  // is read, since the schema lists them, and a machine once the machine list shows it is unknown.
  const machines = useMachineNames(suite)
  const machineSuggestions = useLocalSuggestions(
    useMemo(() => machines.data?.map((name) => ({ key: name, text: name })), [machines.data]),
    machines.error,
  )
  useDropUnusable(
    machines,
    (names) => filters.machine === '' || names.includes(filters.machine),
    () => update({ machine: '' }),
  )
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
  })
  const page = pager.page

  const confirmDelete = (regression: Regression, opener: HTMLElement) =>
    setDeleting({ regression, opener })
  const cancelDelete = () => {
    deleting?.opener.focus()
    setDeleting(null)
  }
  const remove = useMutation({
    mutationFn: (regression: Regression) =>
      unwrap(
        authedApi.DELETE('/api/suites/{testsuite}/regressions/{uuid}', {
          params: { path: { testsuite: suite, uuid: regression.uuid } },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.regressions(suite) })
      setDeleting(null)
      // Its row, and so the button that asked for it, is gone.
      tableRef.current?.focus()
    },
  })

  // A click anywhere on a row opens the regression, except on what the row holds that does
  // something of its own (its links and its Delete button), a modified click, which AR2 leaves to
  // the browser, and a click that ends selecting the row's text.
  const openRow = (regression: Regression) => (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return
    if ((event.target as Element).closest('a, button')) return
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
        options={[
          { value: '', label: 'Any metric' },
          ...schema.metrics.map((entry) => ({ value: entry.name, label: labelOf(entry) })),
        ]}
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
      {machines.isError && <ErrorMessage error={machines.error} />}
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
        <ConfirmDelete
          key={deleting.regression.uuid}
          expected={uuidPrefix(deleting.regression.uuid)}
          onConfirm={() => remove.mutateAsync(deleting.regression)}
          onCancel={cancelDelete}
        >
          <p>
            Delete the regression <strong>{titleOf(deleting.regression)}</strong>, and its
            indicators? This cannot be undone.
          </p>
        </ConfirmDelete>
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
    >
      {page && (
        <>
          <DataTable
            label="Regressions"
            ref={tableRef}
            columns={columns(schema, page, deleteGate, confirmDelete)}
            rows={page.items}
            rowKey={(regression) => regression.uuid}
            rowProps={(regression) => ({
              className: clsx(
                styles.clickable,
                regression.uuid === deleting?.regression.uuid && styles.deleting,
              ),
              onClick: openRow(regression),
            })}
            empty={filtered ? 'No regressions match these filters.' : 'No regressions yet.'}
            busy={input.pending || pager.isUpdating}
          />
          <CursorPager pager={pager} label="Regressions pagination" />
        </>
      )}
    </TabContent>
  )
}

/** A regression's title, or `(untitled)` (AR2 "Display conventions"). */
function titleOf(regression: Regression): string {
  return regression.title ?? '(untitled)'
}

function columns(
  schema: SuiteSchema,
  page: RegressionPage,
  deleteGate: ReturnType<typeof useScopeGate>,
  onDelete: (regression: Regression, button: HTMLElement) => void,
): Column<Regression>[] {
  const suite = schema.name
  return [
    uuidColumn('uuid', 'UUID', (uuid) => regressionPath(suite, uuid)),
    {
      id: 'title',
      header: 'Title',
      className: styles.title,
      cell: (regression) => (
        <Link to={regressionPath(suite, regression.uuid)}>{titleOf(regression)}</Link>
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
          <Link to={commitPath(suite, commit)}>{displayValueOf(commit, page.commits, schema)}</Link>
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
    { id: 'bug', header: 'Bug', cell: (regression) => <BugLink bug={regression.bug} /> },
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

/**
 * A regression's bug: a link opening in a new tab when it is a web URL, and plain text otherwise,
 * since the API stores whatever string it is given, and a link must not run a `javascript:` one.
 */
function BugLink({ bug }: { bug: string | null }) {
  if (bug === null) return MISSING
  if (!/^https?:\/\//i.test(bug)) return <span className={styles.bug}>{bug}</span>
  return (
    <a className={styles.bug} href={bug} target="_blank" rel="noopener noreferrer" title={bug}>
      {bug}
    </a>
  )
}
