import { useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router'
import { VisuallyHidden } from 'react-aria-components'
import { authedApi, PAGE_SIZE, unwrap, type Schemas } from '../../api/client'
import { forgetSuite, queryKeys } from '../../api/keys'
import { machineKey, useMachine } from '../../api/machines'
import { fetchRegressions } from '../../api/regressions'
import { fetchRunPage } from '../../api/runs'
import type { SuiteSchema } from '../../api/suites'
import { useCursorPager } from '../../api/use-cursor-pager'
import { useScopeGate } from '../../auth/scope'
import { ButtonLink } from '../../components/button-link'
import { ConfirmDelete } from '../../components/confirm-delete'
import { DangerButton } from '../../components/danger-button'
import { DataTable } from '../../components/data-table'
import { ErrorMessage, Loaded } from '../../components/feedback'
import { InfoBox, InfoRow } from '../../components/info-box'
import { CursorPager } from '../../components/pagination'
import { runColumns } from '../../components/run-columns'
import { WithSchema } from '../../components/with-schema'
import { UNTRACKED_HELP } from '../../machines'
import { comparePath, graphPath } from '../../paths'
import type { RegressionState } from '../../regression-states'
import { formatFieldValue, labelOf, type Commit } from '../../schema'
import { suiteTabPath } from '../test-suites/settings'
import { RegressionsTable } from './regressions-table'
import styles from './details.module.css'

type Machine = Schemas['Machine']

/** What the Tracked toggle means, and that it is not a lifetime policy (DT1). */
const TRACKED_HELP =
  `${UNTRACKED_HELP} Untracking a machine deletes nothing: untracked machines are kept ` +
  'indefinitely.'

/** The states of the regressions still being worked on. */
const ACTIVE_STATES: RegressionState[] = ['detected', 'active']

/** The Machine Detail page (DT1). */
export default function MachineDetail() {
  const { suite = '', name = '' } = useParams()
  return (
    <section>
      <h1>Machine: {name}</h1>
      <WithSchema suite={suite}>
        {/* Keyed, so that nothing of a machine's page, an open prompt say, stays on another's. */}
        {(schema) => <MachineContent key={`${suite}/${name}`} schema={schema} name={name} />}
      </WithSchema>
    </section>
  )
}

function MachineContent({ schema, name }: { schema: SuiteSchema; name: string }) {
  const suite = schema.name
  const machine = useMachine(suite, name)
  // The sections are shown once the machine is, so that one that does not exist shows only that.
  return (
    <Loaded
      isPending={machine.isPending}
      error={machine.error}
      onRetry={() => void machine.refetch()}
    >
      {machine.data && <MachineSections schema={schema} machine={machine.data} />}
    </Loaded>
  )
}

function MachineSections({ schema, machine }: { schema: SuiteSchema; machine: Machine }) {
  const suite = schema.name
  const { name } = machine
  return (
    <>
      <InfoBox label="Machine">
        <TrackedRow suite={suite} machine={machine} />
        {schema.machine_fields.map((field) => (
          <InfoRow key={field.name} label={labelOf(field)}>
            {formatFieldValue(machine.fields[field.name], field.type)}
          </InfoRow>
        ))}
      </InfoBox>
      <Actions suite={suite} name={name} />
      <ActiveRegressions suite={suite} name={name} />
      <RunHistory schema={schema} name={name} />
    </>
  )
}

/** The machine's `tracked` flag, which a holder of `manage` scope can flip (DT1). */
function TrackedRow({ suite, machine }: { suite: string; machine: Machine }) {
  const id = useId()
  const helpId = useId()
  const queryClient = useQueryClient()
  const manage = useScopeGate('manage')
  const update = useMutation({
    mutationFn: (tracked: boolean) =>
      unwrap(
        authedApi.PATCH('/api/suites/{testsuite}/machines/{machine_name}', {
          params: { path: { testsuite: suite, machine_name: machine.name } },
          body: { tracked },
        }),
      ),
    onSuccess: async (updated) => {
      // Lists of machines fetch it again when next shown. The machine's own key is among theirs,
      // so it is stored after, as the API returned it, which leaves it fresh.
      await queryClient.invalidateQueries({
        queryKey: queryKeys.machines(suite),
        refetchType: 'none',
      })
      queryClient.setQueryData(machineKey(suite, machine.name), updated)
    },
  })
  return (
    <InfoRow
      label={
        <label htmlFor={id} className={styles.help} title={TRACKED_HELP}>
          Tracked
        </label>
      }
    >
      {/* Not optimistic: the box shows the flag the API holds. While a change is under way, the
          box ignores clicks but keeps the focus, which disabling it would lose. */}
      <input
        id={id}
        type="checkbox"
        checked={machine.tracked}
        {...manage}
        aria-disabled={update.isPending || undefined}
        aria-describedby={helpId}
        onChange={(event) => {
          if (!update.isPending) update.mutate(event.target.checked)
        }}
      />
      <VisuallyHidden id={helpId}>{TRACKED_HELP}</VisuallyHidden>
      {update.isError && <ErrorMessage error={update.error} />}
    </InfoRow>
  )
}

/** View Graph, Compare, and Delete Machine, with its confirmation below them (DT1). */
function Actions({ suite, name }: { suite: string; name: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const manage = useScopeGate('manage')
  const [confirming, setConfirming] = useState(false)
  const deleteButton = useRef<HTMLButtonElement>(null)

  const remove = async () => {
    await unwrap(
      authedApi.DELETE('/api/suites/{testsuite}/machines/{machine_name}', {
        params: { path: { testsuite: suite, machine_name: name } },
      }),
    )
    // Its runs, their commits' and tests' lists, and the regressions it had indicators on, change.
    await forgetSuite(queryClient, suite)
    navigate(suiteTabPath(suite, 'machines'), { replace: true })
  }

  return (
    <>
      <div className={styles.actions}>
        <ButtonLink to={graphPath({ suite, machine: name })}>View Graph</ButtonLink>
        <ButtonLink to={comparePath({ suite, machine: name })}>Compare</ButtonLink>
        <DangerButton
          type="button"
          ref={deleteButton}
          {...manage}
          aria-expanded={confirming}
          onClick={() => setConfirming(true)}
        >
          Delete Machine
        </DangerButton>
      </div>
      {confirming && (
        <ConfirmDelete
          expected={name}
          busyMessage="Deleting a machine with many runs may take a while."
          onConfirm={remove}
          onCancel={() => {
            setConfirming(false)
            deleteButton.current?.focus()
          }}
        >
          <p>
            Delete the machine <strong>{name}</strong>, all of its runs with their samples and
            profiles, and every regression indicator naming it? Regressions left with no indicators
            are kept. This cannot be undone.
          </p>
        </ConfirmDelete>
      )}
    </>
  )
}

/**
 * The regressions still being worked on (detected and active) with an indicator on the machine,
 * newest first: the first page only, with a link to all of the machine's regressions (DT1).
 */
function ActiveRegressions({ suite, name }: { suite: string; name: string }) {
  const query = {
    machine: name,
    state: ACTIVE_STATES,
    sort: '-created_at',
    limit: PAGE_SIZE,
  } as const
  const regressions = useQuery({
    // Apart from the Regressions tab's lists, which hold the same page with its commits resolved.
    queryKey: [...queryKeys.regressions(suite), 'without commits', query],
    queryFn: ({ signal }) => fetchRegressions(suite, query, signal),
  })
  return (
    <>
      <h2 className={styles.heading}>Active Regressions</h2>
      <Loaded
        isPending={regressions.isPending}
        error={regressions.error}
        onRetry={() => void regressions.refetch()}
      >
        {regressions.data && (
          <RegressionsTable
            suite={suite}
            label="Active regressions"
            regressions={regressions.data.items}
            empty="No active regressions on this machine."
          />
        )}
      </Loaded>
      <div className={styles.belowTable}>
        <ButtonLink to={suiteTabPath(suite, 'regressions', { machine: name })}>
          Show all regressions
        </ButtonLink>
      </div>
    </>
  )
}

/** The runs of the machine, newest first, a page at a time (DT1). */
function RunHistory({ schema, name }: { schema: SuiteSchema; name: string }) {
  const suite = schema.name
  const query = { machine: name, sort: '-submitted_at', limit: PAGE_SIZE } as const
  const pager = useCursorPager({
    queryKey: [...queryKeys.runs(suite), query],
    fetchPage: (cursor, signal) => fetchRunPage(suite, { ...query, cursor }, signal),
  })
  const page = pager.page
  return (
    <>
      <h2 className={styles.heading}>Run History</h2>
      <Loaded isPending={pager.isPending} error={pager.error} onRetry={pager.retry}>
        {page && (
          <>
            <DataTable
              label="Run history"
              columns={columns(schema, page.commits)}
              rows={page.items}
              rowKey={(run) => run.uuid}
              // A later page may only have run out.
              empty={pager.hasPrevious ? 'No more runs.' : 'No runs on this machine yet.'}
              busy={pager.isUpdating}
            />
            <CursorPager pager={pager} label="Run history pagination" />
          </>
        )}
      </Loaded>
    </>
  )
}

function columns(schema: SuiteSchema, commits: Map<string, Commit>) {
  const { run, commit, submitted } = runColumns(schema, commits)
  return [run, commit, submitted]
}
