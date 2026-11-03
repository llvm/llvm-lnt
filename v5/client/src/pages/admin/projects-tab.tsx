import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from 'react'
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { VisuallyHidden } from 'react-aria-components'
import { ApiError, authedApi, unwrap, type Schemas } from '../../api/client'
import {
  addProject,
  refetchProjects,
  refetchProjectsIfOutdated,
  removeProject,
  renameProject,
  updateProject,
  useProjects,
  type Project,
} from '../../api/suites'
import { useScopeGate, type ScopeGate } from '../../auth/scope'
import { useAuth } from '../../auth/use-auth'
import { ActionButton } from '../../components/action-button'
import { Confirmation } from '../../components/confirmation'
import { DangerButton } from '../../components/danger-button'
import { DataTable, type Column } from '../../components/data-table'
import { ErrorMessage, Loaded } from '../../components/feedback'
import { InlineEdit } from '../../components/inline-edit'
import { useFocusOnceChecked } from '../../components/use-focus-once-checked'
import { useRowConfirm } from '../../components/use-row-confirm'
import { plural } from '../../format'
import { projectLabel } from '../../labels'
import { projectPath } from '../../paths'
import { projectNameProblem } from '../test-suites/schema/schema-editor-model'
import { DisplayNameInput, NameInput } from '../test-suites/schema/schema-editor-tables'
import styles from './admin.module.css'

/**
 * The Projects tab (AD3): a form creating a project, and a table of the projects, in AR22's order,
 * whose names and display names are edited in place, and which are deleted once they have no
 * suites. Anyone can view it. Creating, renaming and deleting a project need an instance-wide
 * `manage` token, and changing its display name one covering the project in full.
 */
export function ProjectsTab() {
  const projects = useProjects()
  return (
    <>
      <CreateProject />
      <Loaded
        isPending={projects.isPending}
        // A list fetched again that fails, after a name found taken, say, leaves the table shown,
        // and any field being edited in it.
        error={projects.data ? null : projects.error}
        onRetry={() => void projects.refetch()}
        label="Loading projects..."
      >
        {projects.data && <ProjectsTable projects={projects.data} />}
      </Loaded>
    </>
  )
}

/**
 * Change the project `project` as `body` says. A project deleted elsewhere, or a name taken there,
 * has the list fetched again, which shows the row gone, or has the name check say so.
 */
async function patchProject(
  queryClient: QueryClient,
  project: string,
  body: Schemas['ProjectUpdate'],
) {
  try {
    const params = { path: { project } }
    return await unwrap(authedApi.PATCH('/api/projects/{project}', { params, body }))
  } catch (failure) {
    refetchProjectsIfOutdated(queryClient, failure)
    throw failure
  }
}

/** The key of a project's row: its name. */
const rowKey = (project: Project) => project.name

/**
 * Create a project, and add it to the list of projects, whether or not the form is still shown. A
 * name taken meanwhile, by a project created elsewhere, has the list fetched again, so that the
 * name check says so.
 */
function useCreateProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: Schemas['ProjectCreate']) =>
      unwrap(authedApi.POST('/api/projects', { body })),
    onSuccess: (project) => addProject(queryClient, project),
    onError: (error) => refetchProjectsIfOutdated(queryClient, error),
  })
}

/**
 * "New project" (AD3): its name, checked as it is typed against D7's rules and the names of the
 * projects, and its display name, sent as the schema editor sends a suite's (TS7).
 */
function CreateProject() {
  const projects = useProjects()
  const list = projects.data
  const gate = useScopeGate('manage', null)
  const create = useCreateProject()
  const titleId = useId()
  const nameId = useId()
  const nameRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')

  const nameProblem = projectNameProblem(name, list?.map((project) => project.name) ?? [])
  // Until the projects have loaded, the name cannot be checked.
  const listProblem =
    list !== undefined
      ? undefined
      : projects.isError
        ? 'The projects could not be loaded.'
        : 'Loading the projects...'
  const reason =
    gate.title ??
    listProblem ??
    (name === '' ? 'Give the project a name first.' : undefined) ??
    nameProblem

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (reason !== undefined || create.isPending) return
    const body = { name, display_name: displayName.trim() || null }
    // Only while the form is shown. "Create project" is disabled once the form is empty, so the
    // focus goes to the name, for another project.
    create.mutate(body, {
      onSuccess: () => {
        setName('')
        setDisplayName('')
        nameRef.current?.focus()
      },
    })
  }

  return (
    <>
      <form className={styles.createForm} aria-labelledby={titleId} onSubmit={submit}>
        <strong id={titleId} className={styles.formTitle}>
          New project
        </strong>
        <div className={styles.fields}>
          <div className={styles.control}>
            <label htmlFor={nameId}>Name</label>
            <NameInput
              id={nameId}
              className={styles.nameInput}
              value={name}
              problem={nameProblem}
              ref={nameRef}
              readOnly={create.isPending}
              onValue={setName}
            />
          </div>
          <div className={styles.control}>
            <DisplayNameInput
              className={styles.nameInput}
              value={displayName}
              readOnly={create.isPending}
              onValue={setDisplayName}
            />
          </div>
          <ActionButton type="submit" reason={reason} busy={create.isPending}>
            {create.isPending ? 'Creating...' : 'Create project'}
          </ActionButton>
        </div>
      </form>
      {create.isError && <ErrorMessage error={create.error} />}
    </>
  )
}

/**
 * The projects, each with its name and display name edited in place, its number of suites, linking
 * to them, and its Delete button (AD3).
 */
function ProjectsTable({ projects }: { projects: Project[] }) {
  const queryClient = useQueryClient()
  const { recheck } = useAuth()
  const tableRef = useRef<HTMLTableElement>(null)
  const rowConfirm = useRowConfirm<Project>(tableRef)
  // The project whose deletion is being confirmed, as listed now: once gone, deleted elsewhere,
  // there is nothing left to confirm.
  const deleting = projects.find((project) => project.name === rowConfirm.item?.name)
  const { open, done, close } = rowConfirm
  // The project just renamed, whose row is a new one, and whose name's Edit button takes the focus
  // once the token has been checked again. A list without it, renamed again or deleted elsewhere
  // first, means that it is gone, so that a project of that name created later takes nothing.
  const [renamed, setRenamed] = useState<string | null>(null)
  // The prompt of a project renamed is gone with its old name, and the focus with the project's
  // name, rather than to the table.
  const gone = rowConfirm.item !== null && deleting === undefined
  const renaming = renamed !== null
  useEffect(() => {
    if (gone) close(!renaming)
  }, [gone, renaming, close])
  const onFocused = useCallback(() => setRenamed(null), [])
  const [listed, setListed] = useState(projects)
  if (projects !== listed) {
    setListed(projects)
    if (renamed !== null && !projects.some((project) => project.name === renamed)) {
      setRenamed(null)
    }
  }

  const names = useMemo(() => projects.map((project) => project.name), [projects])
  const columns = useMemo(
    (): Column<Project>[] => [
      {
        id: 'name',
        header: 'Name',
        cell: (project) => (
          <NameCell
            project={project}
            names={names}
            focus={project.name === renamed}
            onRenamed={setRenamed}
            onFocused={onFocused}
            tableRef={tableRef}
          />
        ),
      },
      {
        id: 'display_name',
        header: 'Display name',
        cell: (project) => <DisplayNameCell project={project} />,
      },
      {
        id: 'suites',
        header: 'Suites',
        looks: ['numeric'],
        cell: (project) => (
          <Link
            to={projectPath(project.name)}
            aria-label={`${plural(project.suites.length, 'suite')} of ${projectLabel(project)}`}
          >
            {project.suites.length}
          </Link>
        ),
      },
      {
        id: 'delete',
        header: <VisuallyHidden>Actions</VisuallyHidden>,
        cell: (project) => <DeleteButton project={project} onDelete={open} />,
      },
    ],
    [names, renamed, onFocused, open],
  )

  // A project deleted elsewhere meanwhile is gone all the same: what the user asked for.
  const remove = async (project: Project) => {
    try {
      await unwrap(
        authedApi.DELETE('/api/projects/{project}', {
          params: { path: { project: project.name } },
        }),
      )
    } catch (failure) {
      const code = failure instanceof ApiError ? failure.code : null
      // Suites created in it meanwhile: the list, fetched again, shows them, and disables Delete.
      if (code === 'conflict') refetchProjects(queryClient)
      if (code !== 'not_found') throw failure
    }
    await removeProject(queryClient, project.name)
    // Its key may have listed the project, which it no longer does (I5), so that a project created
    // later under the name does not seem to be covered (AR17).
    recheck()
    done()
  }

  return (
    <>
      {deleting && (
        <DeletePrompt
          key={deleting.name}
          project={deleting}
          onConfirm={() => remove(deleting)}
          onCancel={rowConfirm.cancel}
        />
      )}
      <DataTable
        label="Projects"
        ref={tableRef}
        columns={columns}
        rows={projects}
        rowKey={rowKey}
        confirming={(project) => project.name === deleting?.name}
        empty="No projects yet."
      />
    </>
  )
}

/** `project` as a prompt names it: by its label, and its name beside it when they differ. */
function Named({ project }: { project: Project }) {
  const label = projectLabel(project)
  return (
    <>
      <strong>{label}</strong>
      {label !== project.name && ` (${project.name})`}
    </>
  )
}

interface NameCellProps {
  project: Project
  /** The names of every project, of which the new name must be none but its own. */
  names: string[]
  /** Whether the Edit button takes the focus once the token has been checked again. */
  focus: boolean
  /** The project is now named `name`. */
  onRenamed(name: string): void
  onFocused(): void
  tableRef: RefObject<HTMLTableElement | null>
}

/**
 * The project's name, edited in place, which renames it once a plain confirmation says what that
 * breaks (AD3, AR16). Renaming needs an instance-wide `manage` token.
 */
function NameCell({ project, names, focus, onRenamed, onFocused, tableRef }: NameCellProps) {
  const queryClient = useQueryClient()
  const gate = useScopeGate('manage', null)
  const { recheck } = useAuth()
  const editRef = useRef<HTMLButtonElement>(null)
  // The row of a project just renamed is a new one, which the focus did not go to: its Edit button
  // takes it once the token has been checked again, or the table does if it stays disabled.
  useFocusOnceChecked(focus, onFocused, editRef, tableRef)

  const rename = async (name: string) => {
    const renamed = await patchProject(queryClient, project.name, { name })
    await renameProject(queryClient, project.name, renamed)
    // So that what the token covers is named as it now is (AR17).
    recheck()
    onRenamed(renamed.name)
  }

  return (
    <InlineEdit
      label={`Name of ${project.name}`}
      value={project.name}
      gate={gate}
      invalid={(text) => projectNameProblem(text, names.filter((name) => name !== project.name))}
      required="A project needs a name."
      editRef={editRef}
      confirm={(name) => (
        <>
          <p>
            Rename the project <Named project={project} /> to <strong>{name}</strong>? Every URL,
            bookmark and bot that uses the name <strong>{project.name}</strong> for any of the
            project's suites will get a 404 until it is updated.
          </p>
          <p>API keys are unaffected.</p>
        </>
      )}
      // `required` keeps the text from being null.
      onSave={(text) => rename(text ?? '')}
    />
  )
}

/**
 * The project's display name, edited in place, which needs `manage` covering the project in full
 * (AD3). Emptying it clears it.
 */
function DisplayNameCell({ project }: { project: Project }) {
  const queryClient = useQueryClient()
  const gate = useScopeGate('manage', { project: project.name })
  const save = async (displayName: string | null) => {
    const body = { display_name: displayName }
    await updateProject(queryClient, await patchProject(queryClient, project.name, body))
  }
  return (
    <InlineEdit
      label={`Display name of ${project.name}`}
      value={project.display_name}
      gate={gate}
      onSave={save}
    />
  )
}

/**
 * Why `project` cannot be deleted, if it cannot: the scope it needs, an instance-wide `manage`, or
 * the suites it still has, since deleting a project never deletes data (D7).
 */
function useDeleteGate(project: Project): ScopeGate {
  const gate = useScopeGate('manage', null)
  if (gate.disabled || project.suites.length === 0) return gate
  const label = projectLabel(project)
  return {
    disabled: true,
    title: `The project '${label}' still has test suites: delete or move them first.`,
  }
}

function DeleteButton({
  project,
  onDelete,
}: {
  project: Project
  onDelete(project: Project, button: HTMLElement): void
}) {
  const gate = useDeleteGate(project)
  return (
    <DangerButton
      type="button"
      {...gate}
      aria-label={`Delete project ${project.name}`}
      onClick={(event) => onDelete(project, event.currentTarget)}
    >
      Delete
    </DangerButton>
  )
}

/**
 * The plain confirmation of deleting `project` (AD3, AR16), which destroys no data, but takes the
 * project from the API keys that list it. Its button is disabled once the project has suites, as
 * the list fetched again after a refusal shows.
 */
function DeletePrompt({
  project,
  onConfirm,
  onCancel,
}: {
  project: Project
  onConfirm(): Promise<unknown>
  onCancel(): void
}) {
  const gate = useDeleteGate(project)
  return (
    <Confirmation confirmLabel="Delete" gate={gate} onConfirm={onConfirm} onCancel={onCancel}>
      <p>
        Delete the project <Named project={project} />? API keys listing the project will lose it,
        and a key left with nothing listed will grant only 'read'.
      </p>
    </Confirmation>
  )
}
