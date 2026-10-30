import { useId, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, authedApi, unwrap, type Schemas } from '../../../api/client'
import {
  refetchProjects,
    removeSuite,
  updateSuite,
  useSuiteLabel,
  type SuiteRef,
  type SuiteSchema,
} from '../../../api/suites'
import { useScopeGate } from '../../../auth/scope'
import { ActionButton } from '../../../components/action-button'
import { Confirmation } from '../../../components/confirmation'
import { ErrorMessage, Loaded } from '../../../components/feedback'
import { useUnsavedChanges } from '../../../components/use-unsaved-changes'
import { EditorFooter } from './editor-footer'
import {
  displayNameChange,
  draftOf,
  draftProblem,
  patchOf,
  removedEntries,
} from './schema-editor-model'
import { LIST_INFO } from './schema-lists'
import { DisplayNameInput, SchemaEditorTables } from './schema-editor-tables'
import styles from './schema.module.css'

/** How many times an editor has been opened, so that each opening has a query of its own. */
let openings = 0

interface Props {
  /** The suite whose schema to edit. */
  suite: SuiteRef
  onClose(): void
}

/**
 * The schema editor changing a suite's schema (TS7). It starts from the schema as it is when the
 * editor opens, fetched afresh rather than taken from the list of suites, which may be older.
 */
export function EditSchema({ suite, onClose }: Props) {
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
        if (error instanceof ApiError && error.code === 'not_found') {
          await removeSuite(queryClient, suite)
        }
        throw error
      }
    },
    gcTime: 0,
    staleTime: Infinity,
  })

  if (fresh.data) {
    return <EditForm suite={suite} schema={fresh.data} onClose={onClose} />
  }
  return (
    <Frame suite={suite} buttons={<ActionButton onClick={onClose}>Cancel</ActionButton>}>
      <Loaded
        isPending={fresh.isPending}
        error={fresh.error}
        onRetry={() => void fresh.refetch()}
        label="Loading the schema..."
      >
        {null}
      </Loaded>
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

interface FormProps {
  suite: SuiteRef
  schema: SuiteSchema
  onClose(): void
}

function EditForm({ suite, schema, onClose }: FormProps) {
  const gate = useScopeGate('manage', suite)
  const label = useSuiteLabel(suite)
  const saveRef = useRef<HTMLButtonElement>(null)
  const [draft, setDraft] = useState(() => draftOf(schema))
  // The suite's own, and so not part of what the tables edit.
  const [displayName, setDisplayName] = useState(schema.display_name ?? '')
  // Removing destroys data, which the user confirms first (AR16). Meanwhile, the draft cannot
  // change, so that what is confirmed is what is sent.
  const [confirming, setConfirming] = useState(false)
  const save = useSaveSchema(suite)
  const busy = save.isPending

  const removed = removedEntries(draft)
  const reason = gate.title ?? draftProblem(draft)
  const patch = { ...displayNameChange(displayName, schema.display_name), ...patchOf(draft) }
  // The changes Save would send, until it closes the editor (TS7).
  const changed = Object.keys(patch).length > 0
  useUnsavedChanges(changed)

  const onSave = () => {
    // Nothing changed: nothing to send.
    if (!changed) onClose()
    else if (removed.length > 0) {
      // A failure of an earlier save is no longer what the editor is about.
      save.reset()
      setConfirming(true)
    }
    // Closed only if the editor is still shown (TanStack Query skips `mutate`'s callbacks then).
    else save.mutate({ patch, confirm: false }, { onSuccess: onClose })
  }
  const removesMetric = removed.some((entry) => entry.list === 'metrics')

  return (
    <Frame
      suite={suite}
      buttons={
        <>
          <ActionButton busy={busy} onClick={onClose}>
            Cancel
          </ActionButton>
          <ActionButton
            ref={saveRef}
            reason={reason}
            busy={busy}
            aria-expanded={removed.length > 0 ? confirming : undefined}
            onClick={onSave}
          >
            {busy ? 'Saving...' : 'Save'}
          </ActionButton>
        </>
      }
      below={
        <>
          {confirming && (
            <Confirmation
              expected={suite.suite}
              confirmLabel="Save"
              gate={gate}
              busyMessage="Removing entries from a suite with much data may take a while."
              onConfirm={() => save.mutateAsync({ patch, confirm: true }, { onSuccess: onClose })}
              onCancel={() => {
                setConfirming(false)
                saveRef.current?.focus()
              }}
            >
              <p>Saving removes these entries from the suite {label}:</p>
              <ul>
                {removed.map((entry) => (
                  <li key={`${entry.list}-${entry.name}`}>
                    {LIST_INFO[entry.list].noun} <strong>{entry.name}</strong>
                  </li>
                ))}
              </ul>
              <p>
                Every value stored for them is permanently destroyed
                {removesMetric && ', along with the regression indicators of each removed metric'}.
                This cannot be undone.
              </p>
            </Confirmation>
          )}
          {/* A confirmed save shows its failure in the prompt. */}
          {save.isError && save.variables.confirm === false && <ErrorMessage error={save.error} />}
        </>
      }
    >
      <div className={styles.displayName}>
        <DisplayNameInput
          className={styles.displayNameInput}
          value={displayName}
          readOnly={busy || confirming}
          onValue={setDisplayName}
        />
      </div>
      <SchemaEditorTables draft={draft} onChange={setDraft} busy={busy || confirming} />
    </Frame>
  )
}

/**
 * Apply a change to the schema of `suite`, then put the schema the API returned in the
 * list of suites, and forget what was read from inside the suite, whether or not the editor is
 * still shown. A 404 or a 409 `duplicate` says that the schema changed elsewhere since the editor
 * opened -- the suite was deleted, or an entry added or removed -- and has the list fetched again:
 * if the suite is gone, the page says so in place of the editor, and otherwise the viewer shows it
 * as it is once the editor closes. (A 404 does not say which: an entry can be gone rather than the
 * suite.)
 */
function useSaveSchema(suite: SuiteRef) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ patch, confirm }: { patch: Schemas['SchemaPatch']; confirm: boolean }) =>
      unwrap(
        authedApi.PATCH('/api/projects/{project}/suites/{suite}/schema', {
          params: { path: suite, query: confirm ? { confirm: true } : {} },
          body: patch,
        }),
      ),
    onSuccess: (schema) => updateSuite(queryClient, suite.project, schema),
    onError: (error) => {
      if (error instanceof ApiError && (error.code === 'not_found' || error.code === 'duplicate')) {
        refetchProjects(queryClient)
      }
    },
  })
}
