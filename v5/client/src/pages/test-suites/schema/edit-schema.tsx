import { useId, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, authedApi, unwrap, type Schemas } from '../../../api/client'
import { isMissing } from '../../../api/shown-data'
import {
  fullName,
  refetchProjects,
  refetchProjectsIfOutdated,
  removeSuite,
  suiteRef,
  updateSuite,
  useProjects,
  useSuiteLabel,
  type SuiteRef,
  type SuiteSchema,
} from '../../../api/suites'
import { refusal, useScopeGate } from '../../../auth/scope'
import { useAuth } from '../../../auth/use-auth'
import { ActionButton } from '../../../components/action-button'
import { Confirmation } from '../../../components/confirmation'
import { ErrorMessage, Loading } from '../../../components/feedback'
import { Select } from '../../../components/select'
import { useMounted } from '../../../components/use-mounted'
import { useUnsavedChanges } from '../../../components/use-unsaved-changes'
import { projectLabel, projectNamed } from '../../../labels'
import { EditorFooter } from './editor-footer'
import {
  displayNameChange,
  draftOf,
  draftProblem,
  patchOf,
  removedEntries,
  suiteNameProblem,
} from './schema-editor-model'
import { LIST_INFO } from './schema-lists'
import { SchemaEditorTables, SuiteFields } from './schema-editor-tables'

/** How many times an editor has been opened, so that each opening has a query of its own. */
let openings = 0

interface Props {
  /** The suite whose schema to edit. */
  suite: SuiteRef
  onClose(): void
  /**
   * The suite is now `to`, with the `schema` the API returned: forget its old names, and leave its
   * page for the new one if the user is still on it. Called even if the editor is no longer shown.
   */
  onMoved(schema: SuiteSchema, to: SuiteRef): Promise<void>
}

/**
 * The schema editor changing a suite's schema, and renaming or moving the suite (TS7). It starts
 * from the schema as it is when the editor opens, fetched afresh rather than taken from the list of
 * suites, which may be older.
 */
export function EditSchema({ suite, onClose, onMoved }: Props) {
  const queryClient = useQueryClient()
  // Each opening of the editor fetches the schema afresh, and keeps it while open.
  const [opening] = useState(() => ++openings)
  const fresh = useQuery({
    // Not under the suite's own key, which a save invalidates while the editor still shows.
    queryKey: ['schema-editor', suite.project, suite.suite, opening],
    queryFn: async ({ signal }) => {
      try {
        return await unwrap(
          api.GET('/api/projects/{project}/suites/{suite}', { params: { path: suite }, signal }),
        )
      } catch (error) {
        // The suite was deleted elsewhere: it goes from the list of suites, and the page says that
        // it was not found, in place of its tabs and the editor (TS1).
        if (isMissing(error)) {
          await removeSuite(queryClient, suite)
        }
        throw error
      }
    },
    gcTime: 0,
    staleTime: Infinity,
  })

  if (fresh.data) {
    return <EditForm suite={suite} schema={fresh.data} onClose={onClose} onMoved={onMoved} />
  }
  return (
    <Frame suite={suite} buttons={<ActionButton onClick={onClose}>Cancel</ActionButton>}>
      {fresh.isError ? (
        <ErrorMessage error={fresh.error} onRetry={() => void fresh.refetch()} />
      ) : (
        <Loading label="Loading the schema..." />
      )}
    </Frame>
  )
}

/**
 * The editor: what it edits, then below it, as below a suite's schema in the viewer, its heading and
 * buttons, and what they lead to.
 */
function Frame({
  suite,
  buttons,
  children,
  below,
}: {
  suite: SuiteRef
  buttons: ReactNode
  children: ReactNode
  /** What the buttons lead to: a confirmation, or why a save failed. */
  below?: ReactNode
}) {
  const titleId = useId()
  const label = useSuiteLabel(suite)
  return (
    <section aria-labelledby={titleId}>
      {children}
      <EditorFooter title={<strong id={titleId}>Editing {label}</strong>}>{buttons}</EditorFooter>
      {below}
    </section>
  )
}

interface FormProps extends Props {
  schema: SuiteSchema
}

/** What a save sends: a change to the schema, and the names the suite goes to, if new. */
interface Save {
  patch: Schemas['SchemaPatch']
  /** The entries the change removes, which the user confirms by typing the suite's name (AR16). */
  removed: ReturnType<typeof removedEntries>
  to: SuiteRef | null
}

function EditForm({ suite, schema, onClose, onMoved }: FormProps) {
  const queryClient = useQueryClient()
  const { status } = useAuth()
  const gate = useScopeGate('manage', suite)
  // The page shows the suite from this list, so it has loaded.
  const projects = useProjects().data ?? []
  const mounted = useMounted()
  const saveRef = useRef<HTMLButtonElement>(null)
  // What the editor starts from: the schema as fetched, then as stored by a save whose rename or
  // move failed, which leaves only that to save (TS7). The suite's display name is its own, and so
  // not part of what the tables edit.
  const [draft, setDraft] = useState(() => draftOf(schema))
  const [storedDisplayName, setStoredDisplayName] = useState(schema.display_name)
  const [displayName, setDisplayName] = useState(schema.display_name ?? '')
  const [project, setProject] = useState(suite.project)
  const [name, setName] = useState(suite.suite)
  // The save being confirmed (AR16), as it was when Save was clicked: the editor cannot change
  // meanwhile, so that what is confirmed is what is sent.
  const [confirming, setConfirming] = useState<Save | null>(null)
  const [saving, setSaving] = useState(false)
  // Why the last save failed, unless the prompt shows it.
  const [failure, setFailure] = useState<unknown>(null)
  // Nothing in the editor changes while a save is confirmed or sent.
  const locked = saving || confirming !== null

  const picked = projects.find((candidate) => candidate.name === project)
  const moving = project !== suite.project
  const to = moving || name !== suite.suite ? suiteRef(project, name) : null
  // Moving the suite also needs the project it goes to covered in full (I5), which its own needs not.
  const refused = (option: string) =>
    option === suite.project ? undefined : refusal('manage', { project: option }, status, projects)
  const destination = refused(project)
  const allowed = {
    disabled: gate.disabled || destination !== undefined,
    title: gate.title ?? destination,
  }
  const others = (picked?.suites ?? [])
    .map((other) => other.name)
    .filter((other) => moving || other !== suite.suite)
  const nameProblem = suiteNameProblem(name, others)
  const reason =
    allowed.title ??
    (picked === undefined ? 'Pick a project.' : undefined) ??
    (name === '' ? 'Give the suite a name.' : undefined) ??
    nameProblem ??
    draftProblem(draft)

  const removed = removedEntries(draft)
  const patch = { ...displayNameChange(displayName, storedDisplayName), ...patchOf(draft) }
  const changesSchema = Object.keys(patch).length > 0
  // The changes Save would send, until it closes the editor or leaves for the new names (TS7).
  const allowLeaving = useUnsavedChanges(changesSchema || to !== null)
  // Removing entries destroys data, and renaming or moving breaks the old names (AR16).
  const confirms = removed.length > 0 || to !== null
  const confirmsRemoval = confirming !== null && confirming.removed.length > 0

  const patchSchema = (save: Save) =>
    unwrap(
      authedApi.PATCH('/api/projects/{project}/suites/{suite}/schema', {
        params: { path: suite, query: save.removed.length > 0 ? { confirm: true } : {} },
        body: save.patch,
      }),
    )
  const moveSuite = (to: SuiteRef) =>
    unwrap(
      authedApi.PATCH('/api/projects/{project}/suites/{suite}', {
        params: { path: suite },
        body: {
          ...(to.suite !== suite.suite && { name: to.suite }),
          ...(to.project !== suite.project && { project: to.project }),
        },
      }),
    )

  // The schema change first, under the suite's current names, then the rename or the move, each
  // only if there is one, carried through even if the user leaves the tab meanwhile (AR19). A
  // failure of the schema change rejects when the prompt shows it. A failure of the rename or the
  // move closes the prompt, if open, to say why, the focus going back to Save, and the editor then
  // starts from the schema stored, so that only the rename or the move is left to save. The list of
  // suites takes the stored schema only then, or once there is nothing to rename: a rename or a move
  // puts the suite there under its new names, with the schema it returns, and forgets the old ones.
  const send = async (save: Save, prompted: boolean) => {
    setSaving(true)
    setFailure(null)
    try {
      let stored: SuiteSchema | undefined
      if (Object.keys(save.patch).length > 0) {
        try {
          stored = await patchSchema(save)
        } catch (error) {
          // A refusal may say that the schema changed elsewhere since the editor opened -- the
          // suite was deleted, or an entry added or removed that the change names, or that a new
          // order leaves out -- whatever its status: a stale order is a 400 like any invalid
          // schema. So the list is fetched again: if the suite is gone, the page says so in place
          // of the editor, and otherwise the viewer shows it as it is once the editor closes.
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
            refetchProjects(queryClient)
          }
          if (prompted) throw error
          setFailure(error)
          return
        }
      }
      if (save.to === null) {
        if (stored) await updateSuite(queryClient, suite.project, stored)
        if (mounted.current) onClose()
        return
      }
      let moved
      try {
        moved = await moveSuite(save.to)
      } catch (error) {
        if (stored) {
          await updateSuite(queryClient, suite.project, stored)
          setDraft(draftOf(stored))
          setStoredDisplayName(stored.display_name)
          setDisplayName(stored.display_name ?? '')
        }
        // A name taken, or a project deleted, meanwhile: the list says so once fetched again.
        refetchProjectsIfOutdated(queryClient, error)
        setConfirming(null)
        setFailure(error)
        saveRef.current?.focus()
        return
      }
      // The editor's own navigation, which the unsaved changes would otherwise hold up.
      allowLeaving()
      await onMoved(moved, suiteRef(save.to.project, moved.name))
    } finally {
      setSaving(false)
    }
  }

  const onSave = () => {
    // Nothing changed: nothing to send.
    if (!changesSchema && to === null) return onClose()
    const save = { patch, removed, to }
    if (confirms) {
      setFailure(null)
      setConfirming(save)
    } else void send(save, false)
  }

  return (
    <Frame
      suite={suite}
      buttons={
        <>
          <ActionButton busy={saving} onClick={onClose}>
            Cancel
          </ActionButton>
          <ActionButton
            ref={saveRef}
            reason={reason}
            busy={saving}
            aria-expanded={confirms ? confirming !== null : undefined}
            onClick={onSave}
          >
            {saving ? 'Saving...' : 'Save'}
          </ActionButton>
        </>
      }
      below={
        <>
          {confirming !== null && (
            <Confirmation
              expected={confirmsRemoval ? suite.suite : undefined}
              confirmLabel="Save"
              gate={allowed}
              busyMessage={
                confirmsRemoval
                  ? 'Removing entries from a suite with much data may take a while.'
                  : undefined
              }
              onConfirm={() => send(confirming, true)}
              onCancel={() => {
                setConfirming(null)
                saveRef.current?.focus()
              }}
            >
              {confirming.to !== null && (
                <MoveConsequences
                  from={suite}
                  to={confirming.to}
                  fromLabel={projectLabel(projectNamed(projects, suite.project))}
                  toLabel={projectLabel(projectNamed(projects, confirming.to.project))}
                />
              )}
              {confirmsRemoval && (
                <RemovalConsequences
                  suite={suite}
                  removed={confirming.removed}
                  alsoMoves={confirming.to !== null}
                />
              )}
            </Confirmation>
          )}
          {failure !== null && <ErrorMessage error={failure} />}
        </>
      }
    >
      <SuiteFields
        project={
          <Select
            label="Project"
            hideLabel
            options={projects.map((option) => ({
              value: option.name,
              label: projectLabel(option),
              reason: refused(option.name),
            }))}
            value={picked?.name ?? null}
            placeholder="Select a project"
            onChange={setProject}
            isPending={locked}
          />
        }
        name={name}
        nameProblem={nameProblem}
        onName={setName}
        displayName={displayName}
        onDisplayName={setDisplayName}
        readOnly={locked}
      />
      <SchemaEditorTables draft={draft} onChange={setDraft} busy={locked} />
    </Frame>
  )
}

/**
 * What renaming or moving the suite `from` to `to` breaks, and what it means for API keys (TS7): the
 * suite named by its full names (D7), and the projects by their labels, `fromLabel` and `toLabel`
 * (AR22).
 */
function MoveConsequences({
  from,
  to,
  fromLabel,
  toLabel,
}: {
  from: SuiteRef
  to: SuiteRef
  fromLabel: string
  toLabel: string
}) {
  const moving = to.project !== from.project
  return (
    <>
      <p>
        {moving ? 'Move' : 'Rename'} the test suite <strong>{fullName(from)}</strong> to{' '}
        <strong>{fullName(to)}</strong>? Every URL, bookmark and bot that uses the name{' '}
        <strong>{fullName(from)}</strong> will get a 404 until it is updated.
      </p>
      <p>
        {moving
          ? `API keys listing the project '${fromLabel}' as a whole will no longer cover the ` +
            `suite, those listing the project '${toLabel}' as a whole will, and those listing the ` +
            'suite itself still will.'
          : 'API keys are unaffected.'}
      </p>
    </>
  )
}

/**
 * The entries a save removes from `suite`, and what removing them destroys (TS7, D2). The suite is
 * named by its label, unless the prompt has already named it, by its names, as renamed or moved
 * (`alsoMoves`), which would read as two suites.
 */
function RemovalConsequences({
  suite,
  removed,
  alsoMoves,
}: {
  suite: SuiteRef
  removed: Save['removed']
  alsoMoves: boolean
}) {
  const label = useSuiteLabel(suite)
  const removesMetric = removed.some((entry) => entry.list === 'metrics')
  return (
    <>
      <p>
        {alsoMoves
          ? 'Saving also removes these entries:'
          : `Saving removes these entries from the suite ${label}:`}
      </p>
      <ul>
        {removed.map((entry) => (
          <li key={`${entry.list}-${entry.name}`}>
            {LIST_INFO[entry.list].noun} <strong>{entry.name}</strong>
          </li>
        ))}
      </ul>
      <p>
        Every value stored for them is permanently destroyed
        {removesMetric && ', along with the regression indicators of each removed metric'}. This
        cannot be undone.
      </p>
    </>
  )
}
