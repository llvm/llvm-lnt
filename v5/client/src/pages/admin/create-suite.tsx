import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { authedApi, unwrap, type Schemas } from '../../api/client'
import {
  addSuite,
  findSuite,
  refetchProjectsIfOutdated,
  suiteOfFullName,
  suiteRef,
  useProjects,
  type SuiteRef,
  type SuiteSchema,
} from '../../api/suites'
import { projectLabel, suiteOption } from '../../labels'
import { refusal } from '../../auth/scope'
import { useAuth } from '../../auth/use-auth'
import { ActionButton } from '../../components/action-button'
import { ErrorMessage } from '../../components/feedback'
import { Select } from '../../components/select'
import { useUnsavedChanges } from '../../components/use-unsaved-changes'
import {
  copyOf,
  EMPTY_DRAFT,
  draftProblem,
  hasContent,
  isSet,
  schemaOf,
  suiteNameProblem,
} from '../test-suites/schema/schema-editor-model'
import {
  DisplayNameInput,
  NameInput,
  SchemaEditorTables,
} from '../test-suites/schema/schema-editor-tables'
import { EditorFooter } from '../test-suites/schema/editor-footer'
import styles from './admin.module.css'

interface Props {
  onCancel(): void
  /** The suite `suite` has been created, and is in the list of projects. */
  onCreated(suite: SuiteRef): void
}

/**
 * The schema editor creating a suite (TS7) in the project picked: the suite's name, its entries and
 * its repository, which can start as a copy of another suite's. Or, through "Import JSON", a schema
 * document sent as it is.
 */
export function CreateSuite({ onCancel, onCreated }: Props) {
  const { status } = useAuth()
  // The projects of the instance, to pick from, and their suites: to start from, and whose names
  // are taken. A list fetched again that fails leaves the one the editor has.
  const projects = useProjects()
  const list = projects.data
  const suites = list?.flatMap((project) => project.suites)
  // The project picked, if it is still listed: one deleted elsewhere is no longer picked.
  const [project, setProject] = useState<string | null>(null)
  const picked = list?.find((candidate) => candidate.name === project)
  const titleId = useId()
  const nameId = useId()
  const formId = useId()
  // The suite's own, like its name, and so neither part of the draft nor copied by Start from.
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
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
  // Anything entered, until the suite is created (TS7).
  const allowLeaving = useUnsavedChanges(
    project !== null ||
      name !== '' || isSet(displayName) || hasContent(draft) || text.trim() !== '',
  )
  // Only once the suite is created, and only if the editor is still shown: a user who has left the
  // tab meanwhile is not taken to the new suite (TanStack Query skips `mutate`'s callbacks then).
  const created = {
    onSuccess: (schema: SuiteSchema, sent: Creation) => {
      allowLeaving()
      onCreated(suiteRef(sent.project, schema.name))
    },
  }

  const nameProblem = suiteNameProblem(name, picked?.suites.map((suite) => suite.name) ?? [])
  // Until the projects have loaded, none can be picked, and the name cannot be checked.
  const listProblem =
    list !== undefined
      ? undefined
      : projects.isError
        ? 'The projects could not be loaded.'
        : 'Loading the projects...'
  // What the project picked, if any, keeps from creating a suite in it, as the editor and "Import
  // JSON" both need one.
  const projectProblem =
    listProblem ??
    (picked === undefined
      ? 'Pick a project first.'
      : refusal('manage', { project: picked.name }, status, list))
  const reason =
    projectProblem ??
    (name === '' ? 'Give the suite a name first.' : undefined) ??
    nameProblem ??
    draftProblem(draft)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (picked !== undefined && reason === undefined && !busy) {
      const text = JSON.stringify(schemaOf(name, displayName, draft))
      create.mutate({ project: picked.name, text }, created)
    }
  }

  // An action rather than a setting: it shows no suite, so that any suite can be picked, again.
  const startFrom = (value: string) => {
    const source = findSuite(suites, suiteOfFullName(value))
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
          <Select
            label="Project"
            placeholder="Select a project"
            options={(list ?? []).map((option) => ({
              value: option.name,
              label: projectLabel(option),
              reason: refusal('manage', { project: option.name }, status, list),
            }))}
            value={picked?.name ?? null}
            onChange={setProject}
            isDisabled={list === undefined}
            isPending={busy}
          />
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
              <div className={styles.control}>
                <DisplayNameInput
                  className={styles.nameInput}
                  value={displayName}
                  readOnly={busy}
                  onValue={setDisplayName}
                />
              </div>
              <Select
                label="Start from"
                options={(suites ?? []).map(suiteOption)}
                value={null}
                placeholder="Select a suite"
                onChange={startFrom}
                listPicksOnly
                isDisabled={!suites?.length}
                isPending={busy}
              />
            </>
          )}
          <ActionButton
            className={styles.toggle}
            aria-pressed={importing}
            // A document is sent to the project picked, which comes first. Going back to the
            // editor is always possible.
            reason={importing || picked !== undefined ? undefined : 'Pick a project first.'}
            busy={busy}
            onClick={() => setImporting(!importing)}
          >
            Import JSON
          </ActionButton>
        </div>
      </form>
      {list === undefined && projects.isError && (
        <ErrorMessage
          error={projects.error}
          context="The projects could not be loaded"
          onRetry={() => void projects.refetch()}
        />
      )}
      {importing ? (
        <ImportJson
          text={text}
          onText={setText}
          reason={projectProblem}
          busy={send.isPending}
          error={send.error}
          onSend={() => {
            if (picked !== undefined) send.mutate({ project: picked.name, text }, created)
          }}
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

/** A suite to create: the project to create it in, and its schema document. */
interface Creation {
  project: string
  text: string
}

/**
 * Create a suite from the schema document `text` in the project `project`, and add it to the list
 * of projects, whether or not the editor is still shown. A name taken meanwhile, by a suite created
 * elsewhere, or a project deleted meanwhile, has the list fetched again, so that the name check
 * says so, or the project is no longer picked.
 */
function useCreateSuite() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ project, text }: Creation) =>
      unwrap(
        authedApi.POST('/api/projects/{project}/suites', {
          params: { path: { project } },
          // Sent as it is, so that an imported document is validated by the server exactly as the
          // user gave it.
          body: text as unknown as Schemas['SuiteSchemaInput'],
          bodySerializer: () => text,
        }),
      ),
    onSuccess: (schema, { project }) => addSuite(queryClient, project, schema),
    onError: (error) => refetchProjectsIfOutdated(queryClient, error),
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
 * "Import JSON" (TS7): a schema document, pasted or loaded from a file, sent to
 * `POST /api/projects/{project}/suites` exactly as it is, for the server to validate. It is kept when that fails.
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
