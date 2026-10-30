import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError, authedApi, unwrap } from '../../../api/client'
import {
  fullName,
  refetchProjects,
  refOf,
  suiteRef,
  useProjects,
  type Suite,
  type SuiteRef,
  type SuiteSchema,
} from '../../../api/suites'
import { refusal, useScopeGate } from '../../../auth/scope'
import { useAuth } from '../../../auth/use-auth'
import { Confirmation } from '../../../components/confirmation'
import { ErrorMessage } from '../../../components/feedback'
import { Select } from '../../../components/select'
import { projectLabel, projectNamed } from '../../../labels'
import { suiteNameProblem } from './schema-editor-model'
import { NameInput } from './schema-editor-tables'
import styles from './schema.module.css'

interface Props {
  schema: Suite
  /** Close the panel, sending nothing more. */
  onClose(): void
  /**
   * The suite is now `to`, with the `schema` the API returned: forget its old names, and leave its
   * page for the new one if the user is still on it. Called even if the panel is no longer shown.
   */
  onMoved(schema: SuiteSchema, to: SuiteRef): Promise<void> | void
}

/**
 * The "Rename or move" panel of the Schema tab (TS6): the project the suite goes to and its new
 * name, sent once a plain confirmation says what changing them breaks (AR16). The projects that the
 * token does not cover in full, other than the suite's own, cannot be picked (AR17).
 */
export function MoveSuite({ schema, onClose, onMoved }: Props) {
  const queryClient = useQueryClient()
  const suite = refOf(schema)
  const { status } = useAuth()
  const gate = useScopeGate('manage', suite)
  // The page shows the suite from this list, so it has loaded.
  const projects = useProjects().data ?? []
  const [project, setProject] = useState(suite.project)
  const [name, setName] = useState(suite.suite)
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const nameId = useId()
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => nameRef.current?.focus(), [])
  // Nothing changes while the change is confirmed or sent, but nothing is disabled either, which
  // would lose the focus.
  const busy = confirming || saving

  const picked = projects.find((candidate) => candidate.name === project)
  const moving = project !== suite.project
  // Moving it also needs the project it goes to covered in full (I5), which its own needs not.
  const refused = (name: string) =>
    name === suite.project ? undefined : refusal('manage', { project: name }, status, projects)
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
    nameProblem

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (busy || reason !== undefined) return
    if (!moving && name === suite.suite) onClose()
    else setConfirming(true)
  }
  // Back to the name, which the prompt's buttons had the focus from.
  const closePrompt = () => {
    setConfirming(false)
    nameRef.current?.focus()
  }
  const commit = async () => {
    setSaving(true)
    setError(null)
    try {
      const moved = await unwrap(
        authedApi.PATCH('/api/projects/{project}/suites/{suite}', {
          params: { path: suite },
          body: { ...(name !== suite.suite && { name }), ...(moving && { project }) },
        }),
      )
      await onMoved(moved, suiteRef(project, moved.name))
    } catch (failure) {
      setError(failure)
      // A name taken, or a project deleted, meanwhile: the list says so once fetched again.
      if (failure instanceof ApiError && (failure.status === 404 || failure.status === 409)) {
        refetchProjects(queryClient)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={styles.movePanel}>
      <form
        className={styles.moveForm}
        aria-label="Rename or move"
        onSubmit={save}
        onKeyDownCapture={(event) => {
          if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
          if ((event.target as Element).getAttribute('aria-expanded') === 'true') return
          if (!busy) onClose()
        }}
      >
        <Select
          label="Project"
          options={projects.map((option) => ({
            value: option.name,
            label: projectLabel(option),
            reason: refused(option.name),
          }))}
          value={picked?.name ?? null}
          placeholder="Select a project"
          onChange={setProject}
          isPending={busy}
        />
        <div className={styles.moveControl}>
          <label htmlFor={nameId}>Name</label>
          <NameInput
            id={nameId}
            className={styles.moveName}
            value={name}
            problem={nameProblem}
            ref={nameRef}
            readOnly={busy}
            onValue={setName}
          />
        </div>
        <button
          type="submit"
          disabled={reason !== undefined}
          aria-disabled={busy || undefined}
          title={reason}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          aria-disabled={busy || undefined}
          onClick={() => {
            if (!busy) onClose()
          }}
        >
          Cancel
        </button>
      </form>
      {confirming && (
        // The focus starts on its Cancel, and goes back to the name once it closes.
        <Confirmation
          confirmLabel="OK"
          gate={allowed}
          onConfirm={async () => {
            closePrompt()
            await commit()
          }}
          onCancel={closePrompt}
        >
          <Consequences
            from={suite}
            to={suiteRef(project, name)}
            fromLabel={projectLabel(schema.project)}
            toLabel={projectLabel(projectNamed(projects, project))}
          />
        </Confirmation>
      )}
      {error !== null && <ErrorMessage error={error} />}
    </div>
  )
}

/**
 * What renaming or moving the suite `from` to `to` breaks, and what it means for API keys (TS6): the
 * suite named by its full names (D7), and the projects by their labels, `fromLabel` and `toLabel`
 * (AR22).
 */
function Consequences({
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
