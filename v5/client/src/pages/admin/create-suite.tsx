import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ApiError, authedApi, unwrap, type Schemas } from '../../api/client'
import { addSuite, refetchSuites, useSuites, type SuiteSchema } from '../../api/suites'
import { useScopeGate } from '../../auth/scope'
import { ActionButton } from '../../components/action-button'
import { ErrorMessage } from '../../components/feedback'
import { Select } from '../../components/select'
import {
  copyOf,
  EMPTY_DRAFT,
  draftProblem,
  schemaOf,
  suiteNameProblem,
} from '../test-suites/schema/schema-editor-model'
import { NameInput, SchemaEditorTables } from '../test-suites/schema/schema-editor-tables'
import { EditorFooter } from '../test-suites/schema/editor-footer'
import styles from './admin.module.css'

interface Props {
  onCancel(): void
  /** The suite `name` has been created, and is in the list of suites. */
  onCreated(name: string): void
}

/**
 * The schema editor creating a suite (TS7): the suite's name and its entries, which can start as a
 * copy of another suite's. Or, through "Import JSON", a schema document sent as it is.
 */
export function CreateSuite({ onCancel, onCreated }: Props) {
  const gate = useScopeGate('manage', null)
  // The suites of the instance: to start from, and whose names are taken. A list fetched again
  // that fails leaves the one the editor has.
  const suites = useSuites()
  const list = suites.data
  const titleId = useId()
  const nameId = useId()
  const formId = useId()
  const [name, setName] = useState('')
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  // Whether the document to import shows in place of the editor, which keeps what it holds.
  const [importing, setImporting] = useState(false)
  const [text, setText] = useState('')
  // The suite name takes the focus when the editor opens, and only then: not when it comes back
  // from Import JSON, whose toggle keeps it.
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => nameRef.current?.focus(), [])
  const create = useCreateSuite()
  const send = useCreateSuite()
  const busy = create.isPending || send.isPending
  // Only once the suite is created, and only if the editor is still shown: a user who has left the
  // tab meanwhile is not taken to the new suite (TanStack Query skips `mutate`'s callbacks then).
  const created = { onSuccess: (schema: SuiteSchema) => onCreated(schema.name) }

  const nameProblem = suiteNameProblem(name, list?.map((suite) => suite.name) ?? [])
  // Until the suites have loaded, the name cannot be checked against theirs.
  const listProblem =
    list !== undefined
      ? undefined
      : suites.isError
        ? 'The test suites could not be loaded.'
        : 'Loading the test suites...'
  const reason =
    gate.title ??
    (name === '' ? 'Give the suite a name first.' : undefined) ??
    listProblem ??
    nameProblem ??
    draftProblem(draft)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (reason === undefined && !busy) create.mutate(JSON.stringify(schemaOf(name, draft)), created)
  }

  // An action rather than a setting: it shows no suite, so that any suite can be picked, again.
  const startFrom = (value: string) => {
    const source = list?.find((suite) => suite.name === value)
    if (source && !busy) setDraft(copyOf(source))
  }

  return (
    <section aria-labelledby={titleId}>
      {/* A form, so that Enter in the suite name creates the suite. Its submit button is Create,
          below the tables. */}
      <form id={formId} className={styles.createForm} aria-labelledby={titleId} onSubmit={submit}>
        <strong id={titleId} className={styles.formTitle}>
          New suite
        </strong>
        <div className={styles.fields}>
          {!importing && (
            <>
              <div className={styles.control}>
                <label htmlFor={nameId}>Suite name</label>
                <NameInput
                  id={nameId}
                  className={styles.nameInput}
                  value={name}
                  problem={nameProblem}
                  ref={nameRef}
                  readOnly={busy}
                  onValue={setName}
                />
              </div>
              <Select
                label="Start from"
                options={[
                  { value: '', label: 'Select a suite' },
                  ...(list ?? []).map((suite) => ({ value: suite.name, label: suite.name })),
                ]}
                value=""
                onChange={startFrom}
                listPicksOnly
                isDisabled={!list?.length}
                isPending={busy}
              />
            </>
          )}
          <ActionButton
            className={styles.toggle}
            aria-pressed={importing}
            busy={busy}
            onClick={() => setImporting(!importing)}
          >
            Import JSON
          </ActionButton>
        </div>
      </form>
      {/* Only the editor needs the suites: importing a document does not. */}
      {!importing && list === undefined && suites.isError && (
        <ErrorMessage
          error={suites.error}
          context="The test suites could not be loaded"
          onRetry={() => void suites.refetch()}
        />
      )}
      {importing ? (
        <ImportJson
          text={text}
          onText={setText}
          reason={gate.title}
          busy={send.isPending}
          error={send.error}
          onSend={() => send.mutate(text, created)}
        />
      ) : (
        <SchemaEditorTables draft={draft} onChange={setDraft} busy={busy} />
      )}
      <EditorFooter>
        <ActionButton busy={busy} onClick={onCancel}>
          Cancel
        </ActionButton>
        {!importing && (
          <ActionButton type="submit" form={formId} reason={reason} busy={busy}>
            {create.isPending ? 'Creating...' : 'Create'}
          </ActionButton>
        )}
      </EditorFooter>
      {!importing && create.isError && <ErrorMessage error={create.error} />}
    </section>
  )
}

/**
 * Create a suite from the schema document `text`, and add it to the list of suites, whether or not
 * the editor is still shown. A name taken meanwhile, by a suite created elsewhere, has the list
 * fetched again, so that the name check says so.
 */
function useCreateSuite() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (text: string) =>
      unwrap(
        authedApi.POST('/api/suites', {
          // Sent as it is, so that an imported document is validated by the server exactly as the
          // user gave it.
          body: text as unknown as Schemas['SuiteSchemaInput'],
          bodySerializer: () => text,
        }),
      ),
    onSuccess: (schema) => addSuite(queryClient, schema),
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'duplicate') refetchSuites(queryClient)
    },
  })
}

interface ImportProps {
  text: string
  onText(text: string): void
  /** Why the document cannot be sent, whatever it is, if it cannot: the scope it needs. */
  reason: string | undefined
  /** The document is being sent. */
  busy: boolean
  /** Why sending it last failed, if it did. */
  error: unknown
  onSend(): void
}

/**
 * "Import JSON" (TS7): a schema document, pasted or loaded from a file, sent to `POST /api/suites`
 * exactly as it is, for the server to validate. It is kept when that fails.
 */
function ImportJson({ text, onText, reason, busy, error, onSend }: ImportProps) {
  const textId = useId()
  const [fileError, setFileError] = useState<unknown>(null)

  const load = async (file: File) => {
    setFileError(null)
    try {
      onText(await file.text())
    } catch (failure) {
      setFileError(failure)
    }
  }

  return (
    <section className={styles.importJson} aria-label="Import JSON">
      <label htmlFor={textId}>Schema document (JSON), pasted or loaded from a file:</label>
      <textarea
        id={textId}
        className={styles.document}
        rows={16}
        spellCheck={false}
        value={text}
        readOnly={busy}
        onChange={(event) => onText(event.target.value)}
      />
      <div className={styles.importActions}>
        <input
          type="file"
          className={styles.fileInput}
          accept=".json,application/json"
          aria-label="Load from file"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void load(file)
            // So that choosing the same file again, once changed, reads it again.
            event.target.value = ''
          }}
        />
        <ActionButton
          reason={
            reason ?? (text.trim() === '' ? 'Paste or load a schema document first.' : undefined)
          }
          busy={busy}
          onClick={onSend}
        >
          {busy ? 'Creating...' : 'Create from JSON'}
        </ActionButton>
      </div>
      {fileError !== null && <ErrorMessage error={fileError} />}
      {error !== null && <ErrorMessage error={error} />}
    </section>
  )
}
