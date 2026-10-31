import { useEffect, useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate, useParams } from 'react-router'
import { VisuallyHidden } from 'react-aria-components'
import { authedApi, PAGE_SIZE, unwrap, type Schemas } from '../../api/client'
import { forgetSuite, forgetUnobserved, queryKeys } from '../../api/keys'
import { MACHINE_NAME_LENGTH, machineKey, useMachine } from '../../api/machines'
import { fetchRegressions } from '../../api/regressions'
import { fetchRunPage } from '../../api/runs'
import { refOf, type Suite, type SuiteRef } from '../../api/suites'
import { useCursorPager } from '../../api/use-cursor-pager'
import { useScopeGate } from '../../auth/scope'
import { ButtonLink } from '../../components/button-link'
import { DataTable } from '../../components/data-table'
import { ErrorMessage, Loaded } from '../../components/feedback'
import { FieldRow } from '../../components/field-row'
import { HelpLabel } from '../../components/help-label'
import { InfoBox, InfoRow } from '../../components/info-box'
import { InactivityRow } from '../../components/inactivity-row'
import { InlineEdit } from '../../components/inline-edit'
import { CursorPager } from '../../components/pagination'
import { runColumns } from '../../components/run-columns'
import { useMounted } from '../../components/use-mounted'
import { WithSchema } from '../../components/with-schema'
import { invalidMachineName, UNTRACKED_HELP } from '../../machines'
import { comparePath, graphPath, machinePath } from '../../paths'
import { ACTIVE_STATES } from '../../regression-states'
import type { Commit } from '../../schema'
import { suiteTabPath } from '../test-suites/settings'
import { DetailActionRow } from './action-row'
import { RegressionsTable } from './regressions-table'
import { SuiteTrail } from './suite-trail'
import styles from './details.module.css'
import { useSuiteParams } from '../../suite-params'

type Machine = Schemas['Machine']

/** The history state of the page that a rename leads to, in place of the old name's. */
interface Renamed {
  renamedFrom: string
}

/** The Machine Detail page (DT1). */
export default function MachineDetail() {
  const suite = useSuiteParams()
  const { name = '' } = useParams()
  const renamedFrom = (useLocation().state as Renamed | null)?.renamedFrom
  const queryClient = useQueryClient()
  // The content's key changes with the machine shown, so that nothing of a machine's page, an open
  // prompt say, stays on another's. A rename keeps it, since the page still shows the same machine,
  // whose name's Edit button keeps the focus (DT1). `renamedFrom` is compared with the name shown,
  // since the history state outlives the rename (a reload, Back or Forward).
  const [shown, setShown] = useState({ suite, name, key: 0, renamed: false })
  if (shown.suite !== suite || shown.name !== name) {
    // React renders the page again at once, before any of its content, with the key decided here.
    const renamed = shown.suite === suite && renamedFrom === shown.name
    setShown({ suite, name, key: renamed ? shown.key : shown.key + 1, renamed })
  }
  useEffect(() => {
    // What the page read under the old name, which its parts have stopped observing in their own
    // effects, run before this one: dropped rather than shown if the history leads back to it.
    if (shown.renamed) forgetUnobserved(queryClient, shown.suite)
  }, [queryClient, shown])
  return (
    <section>
      <SuiteTrail suite={suite} tab="machines" />
      <h1>Machine: {name}</h1>
      <WithSchema suite={suite}>
        {(schema) => <MachineContent key={shown.key} schema={schema} name={name} />}
      </WithSchema>
    </section>
  )
}

function MachineContent({ schema, name }: { schema: Suite; name: string }) {
  const suite = refOf(schema)
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

function MachineSections({ schema, machine }: { schema: Suite; machine: Machine }) {
  const suite = refOf(schema)
  const { name } = machine
  const manage = useScopeGate('manage', suite)
  const update = useUpdateMachine(suite, name)
  return (
    <>
      <InfoBox label="Machine">
        <NameRow suite={suite} machine={machine} />
        <TrackedRow suite={suite} machine={machine} />
        <InactivityDays suite={suite} machine={machine} />
        {schema.machine_fields.map((field) => (
          <FieldRow
            key={field.name}
            field={field}
            value={machine.fields[field.name]}
            gate={manage}
            onSave={(value) => update.mutateAsync({ fields: { [field.name]: value } })}
          />
        ))}
      </InfoBox>
      <Actions suite={suite} name={name} />
      <ActiveRegressions suite={suite} name={name} />
      <RunHistory schema={schema} name={name} />
    </>
  )
}

/**
 * Change the machine `name` with `PATCH /machines/{name}` (E2), and show what the API returned.
 * Changes are sent one after the other, so that the answer to an earlier one, arriving late, does
 * not replace a later one's. Once renamed, the page moves to the new name, in place of the old one
 * in the history, unless the user has left it already (AR16).
 */
function useUpdateMachine(suite: SuiteRef, name: string) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  // Whether the page still shows the machine once the change is done.
  const mounted = useMounted()
  return useMutation({
    scope: { id: JSON.stringify(machineKey(suite, name)) },
    // A fetch of the machine under way could land after the answer, and show it as it was.
    onMutate: () => queryClient.cancelQueries({ queryKey: machineKey(suite, name) }),
    mutationFn: (body: Schemas['MachineUpdate']) =>
      unwrap(
        authedApi.PATCH('/api/projects/{project}/suites/{suite}/machines/{machine_name}', {
          params: { path: { ...suite, machine_name: name } },
          body,
        }),
      ),
    onSuccess: async (updated) => {
      const renamed = updated.name !== name
      const leaving = renamed && mounted.current
      if (renamed) {
        // Its runs, its regressions' indicators, and everything listed or keyed by machine name
        // now name it differently, so the whole suite is forgotten, as after a deletion.
        await forgetSuite(queryClient, suite, { leaving })
      } else {
        // Lists of machines fetch it again when next shown.
        await queryClient.invalidateQueries({
          queryKey: queryKeys.machines(suite),
          refetchType: 'none',
        })
      }
      // Stored after, as the API returned it, which leaves it fresh: the page shows it at once.
      queryClient.setQueryData(machineKey(suite, updated.name), updated)
      if (leaving) {
        const state = { renamedFrom: name } satisfies Renamed
        navigate(machinePath(suite, updated.name), { replace: true, state })
      }
    },
  })
}

/**
 * The machine's name, which a holder of `manage` scope can change, once they have confirmed what it
 * means for whatever submits its runs (DT1).
 */
function NameRow({ suite, machine }: { suite: SuiteRef; machine: Machine }) {
  const manage = useScopeGate('manage', suite)
  const update = useUpdateMachine(suite, machine.name)
  return (
    <InfoRow label="Name">
      <InlineEdit
        label="Name"
        value={machine.name}
        gate={manage}
        invalid={invalidMachineName}
        required="A machine needs a name."
        maxLength={MACHINE_NAME_LENGTH}
        confirm={(name) => (
          <p>
            Rename <strong>{machine.name}</strong> to <strong>{name}</strong>? Run submissions that
            still use the name <strong>{machine.name}</strong> will create a new machine, so whatever
            submits runs for this machine must be updated too.
          </p>
        )}
        // `required` keeps the text from being null.
        onSave={(text) => update.mutateAsync({ name: text ?? '' })}
      />
    </InfoRow>
  )
}

/** The machine's `tracked` flag, which a holder of `manage` scope can flip (DT1). */
function TrackedRow({ suite, machine }: { suite: SuiteRef; machine: Machine }) {
  const labelId = useId()
  const helpId = useId()
  const manage = useScopeGate('manage', suite)
  const update = useUpdateMachine(suite, machine.name)
  return (
    <InfoRow
      label={
        <HelpLabel id={labelId} help={UNTRACKED_HELP}>
          Tracked
        </HelpLabel>
      }
    >
      {/* Not optimistic: the box shows the flag the API holds. While a change is under way, the
          box ignores clicks but keeps the focus, which disabling it would lose. */}
      <input
        type="checkbox"
        checked={machine.tracked}
        {...manage}
        aria-disabled={update.isPending || undefined}
        aria-labelledby={labelId}
        aria-describedby={helpId}
        onChange={(event) => {
          if (!update.isPending) update.mutate({ tracked: event.target.checked })
        }}
      />
      <VisuallyHidden id={helpId}>{UNTRACKED_HELP}</VisuallyHidden>
      {update.isError && <ErrorMessage error={update.error} />}
    </InfoRow>
  )
}

/** The days of inactivity after which the machine is deleted, which `manage` can edit (DT1). */
function InactivityDays({ suite, machine }: { suite: SuiteRef; machine: Machine }) {
  const update = useUpdateMachine(suite, machine.name)
  const manage = useScopeGate('manage', suite)
  return (
    <InactivityRow
      value={machine.delete_after_inactive_days}
      gate={manage}
      onSave={(days) => update.mutateAsync({ delete_after_inactive_days: days })}
    />
  )
}

/** View Graph, Compare, and Delete Machine, with its confirmation below them (DT1). */
function Actions({ suite, name }: { suite: SuiteRef; name: string }) {
  return (
    <DetailActionRow
      deletion={{
        suite,
        label: 'Delete Machine',
        scope: 'manage',
        expected: name,
        message: (
          <p>
            Delete the machine <strong>{name}</strong>, all of its runs with their samples and
            profiles, and every regression indicator naming it? Regressions left with no indicators
            are kept. This cannot be undone.
          </p>
        ),
        busyMessage: 'Deleting a machine with many runs may take a while.',
        // Its runs, their commits' and tests' lists, and the regressions it had indicators on all
        // change, which is why the whole suite is forgotten (see DetailActionRow).
        onDelete: () =>
          unwrap(
            authedApi.DELETE('/api/projects/{project}/suites/{suite}/machines/{machine_name}', {
              params: { path: { ...suite, machine_name: name } },
            }),
          ),
        leaveTo: suiteTabPath(suite, 'machines'),
      }}
    >
      <ButtonLink to={graphPath({ suite, machines: [name] })}>View Graph</ButtonLink>
      <ButtonLink to={comparePath({ suite, machine: name })}>Compare</ButtonLink>
    </DetailActionRow>
  )
}

/**
 * The regressions still being worked on (detected and active) with an indicator on the machine,
 * newest first: the first page only, with a link to all of the machine's regressions (DT1).
 */
function ActiveRegressions({ suite, name }: { suite: SuiteRef; name: string }) {
  const query = {
    machine: name,
    state: [...ACTIVE_STATES],
    sort: '-created_at' as const,
    limit: PAGE_SIZE,
  }
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

/** The runs of the machine, most recently measured first, a page at a time (DT1). */
function RunHistory({ schema, name }: { schema: Suite; name: string }) {
  const suite = refOf(schema)
  const query = { machine: name, sort: '-measured_at', limit: PAGE_SIZE } as const
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

function columns(schema: Suite, commits: Map<string, Commit>) {
  const { run, commit, measured } = runColumns(schema, commits)
  return [run, commit, measured]
}
