import { useId, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, authedApi, unwrap, type Schemas } from '../../../api/client'
import { refetchSuites, removeSuite, updateSuite, type SuiteSchema } from '../../../api/suites'
import { useScopeGate } from '../../../auth/scope'
import { ActionButton } from '../../../components/action-button'
import { Confirmation } from '../../../components/confirmation'
import { ErrorMessage, Loaded } from '../../../components/feedback'
import { EditorFooter } from './editor-footer'
import { draftOf, draftProblem, patchOf, removedEntries } from './schema-editor-model'
import { LIST_INFO } from './schema-lists'
import { SchemaEditorTables } from './schema-editor-tables'

/** How many times an editor has been opened, so that each opening has a query of its own. */
let openings = 0

interface Props {
  /** The suite whose schema to edit. */
  name: string
  onClose(): void
}

/**
 * The schema editor changing a suite's schema (TS7). It starts from the schema as it is when the
 * editor opens, fetched afresh rather than taken from the list of suites, which may be older.
 */
export function EditSchema({ name, onClose }: Props) {
  const queryClient = useQueryClient()
  // Each opening of the editor fetches the schema afresh, and keeps it while open.
  const [opening] = useState(() => ++openings)
  const fresh = useQuery({
    // Not under the suite's own key, which a save invalidates while the editor still shows.
    queryKey: ['schema-editor', name, opening],
    queryFn: async ({ signal }) => {
      try {
        return await unwrap(api.GET('/api/suites/{name}', { params: { path: { name } }, signal }))
      } catch (error) {
        // The suite was deleted elsewhere: it goes from the list of suites, and the page says that
        // it was not found, in place of its tabs and the editor (TS1).
        if (error instanceof ApiError && error.code === 'not_found') {
          await removeSuite(queryClient, name)
        }
        throw error
      }
    },
    gcTime: 0,
    staleTime: Infinity,
  })

  if (fresh.data) return <EditForm schema={fresh.data} onClose={onClose} />
  return (
    <Frame name={name} buttons={<ActionButton onClick={onClose}>Cancel</ActionButton>}>
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
  name,
  buttons,
  children,
  below,
}: {
  name: string
  buttons: ReactNode
  children: ReactNode
  /** What the buttons lead to: a confirmation, or why a save failed. */
  below?: ReactNode
}) {
  const titleId = useId()
  return (
    <section aria-labelledby={titleId}>
      {children}
      <EditorFooter
        title={
          <strong id={titleId}>Editing {name}</strong>
        }
      >
        {buttons}
      </EditorFooter>
      {below}
    </section>
  )
}

interface FormProps {
  schema: SuiteSchema
  onClose(): void
}

function EditForm({ schema, onClose }: FormProps) {
  const { name } = schema
  const gate = useScopeGate('manage', name)
  const saveRef = useRef<HTMLButtonElement>(null)
  const [draft, setDraft] = useState(() => draftOf(schema))
  // Removing destroys data, which the user confirms first (AR16). Meanwhile, the draft cannot
  // change, so that what is confirmed is what is sent.
  const [confirming, setConfirming] = useState(false)
  const save = useSaveSchema(name)
  const busy = save.isPending

  const removed = removedEntries(draft)
  const reason = gate.title ?? draftProblem(draft)

  const onSave = () => {
    const patch = patchOf(draft)
    // Nothing changed: nothing to send.
    if (Object.keys(patch).length === 0) onClose()
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
      name={name}
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
              expected={name}
              confirmLabel="Save"
              gate={gate}
              busyMessage="Removing entries from a suite with much data may take a while."
              onConfirm={() =>
                save.mutateAsync({ patch: patchOf(draft), confirm: true }, { onSuccess: onClose })
              }
              onCancel={() => {
                setConfirming(false)
                saveRef.current?.focus()
              }}
            >
              <p>Saving removes these entries from the suite {name}:</p>
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
      <SchemaEditorTables draft={draft} onChange={setDraft} busy={busy || confirming} />
    </Frame>
  )
}

/**
 * Apply a change to the schema of the suite `name`, then put the schema the API returned in the
 * list of suites, and forget what was read from inside the suite, whether or not the editor is
 * still shown. A 404 or a 409 `duplicate` says that the schema changed elsewhere since the editor
 * opened -- the suite was deleted, or an entry added or removed -- and has the list fetched again:
 * if the suite is gone, the page says so in place of the editor, and otherwise the viewer shows it
 * as it is once the editor closes. (A 404 does not say which: an entry can be gone rather than the
 * suite.)
 */
function useSaveSchema(name: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ patch, confirm }: { patch: Schemas['SchemaPatch']; confirm: boolean }) =>
      unwrap(
        authedApi.PATCH('/api/suites/{name}/schema', {
          params: { path: { name }, query: confirm ? { confirm: true } : {} },
          body: patch,
        }),
      ),
    onSuccess: (schema) => updateSuite(queryClient, schema),
    onError: (error) => {
      if (error instanceof ApiError && (error.code === 'not_found' || error.code === 'duplicate')) {
        refetchSuites(queryClient)
      }
    },
  })
}
