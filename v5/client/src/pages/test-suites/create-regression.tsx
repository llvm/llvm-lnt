import { useId, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { authedApi, unwrap } from '../../api/client'
import { queryKeys } from '../../api/keys'
import type { SuiteSchema } from '../../api/suites'
import { useScopeGate } from '../../auth/scope'
import { CommitPicker } from '../../components/commit-picker'
import { ErrorMessage } from '../../components/feedback'
import { pendingGuard } from '../../components/pending-guard'
import { regressionPath } from '../../paths'
import { REGRESSION_STATES, stateLabel, type RegressionState } from '../../regression-states'
import styles from './test-suites.module.css'

/** E8's limit on a title or a bug (D5's column). */
const MAX_LENGTH = 256

interface Props {
  schema: SuiteSchema
  onCancel(): void
}

/**
 * The inline form creating a regression (TS5): a title, a bug, a state and a commit, picked among
 * every commit of the suite. Once created, the regression's detail page is shown.
 */
export function CreateRegression({ schema, onCancel }: Props) {
  const suite = schema.name
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const triage = useScopeGate('triage')
  const [title, setTitle] = useState('')
  const [bug, setBug] = useState('')
  const [state, setState] = useState<RegressionState>('detected')
  const [commit, setCommit] = useState<string | null>(null)
  // The commit picker holds text that is not the commit picked (AR2 "Commit pickers").
  const [commitPending, setCommitPending] = useState(false)
  const reasonId = useId()

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        authedApi.POST('/api/suites/{testsuite}/regressions', {
          params: { path: { testsuite: suite } },
          // An empty title or bug is none at all: the API refuses empty strings.
          body: {
            title: title.trim() || null,
            bug: bug.trim() || null,
            state,
            commit,
          },
        }),
      ),
    onSuccess: (created) => {
      // Refetched when it is shown again, rather than now, on the way to another page.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.regressions(suite),
        refetchType: 'none',
      })
      navigate(regressionPath(suite, created.uuid))
    },
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!blocked) create.mutate()
  }
  const blocked = triage.disabled || commitPending || create.isPending

  return (
    <form className={styles.createForm} aria-label="New regression" onSubmit={submit}>
      <div className={styles.fields}>
        <label className={styles.control}>
          Title
          <input
            type="text"
            className={styles.wide}
            value={title}
            maxLength={MAX_LENGTH}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
        </label>
        <label className={styles.control}>
          Bug
          <input
            type="text"
            className={styles.wide}
            value={bug}
            maxLength={MAX_LENGTH}
            placeholder="https://..."
            onChange={(event) => setBug(event.target.value)}
          />
        </label>
        <label className={styles.control}>
          State
          <select
            value={state}
            onChange={(event) => setState(event.target.value as RegressionState)}
          >
            {REGRESSION_STATES.map((option) => (
              <option key={option} value={option}>
                {stateLabel(option)}
              </option>
            ))}
          </select>
        </label>
        <CommitPicker
          label="Commit"
          schema={schema}
          value={commit}
          onChange={setCommit}
          onPendingChange={setCommitPending}
          placeholder="None"
        />
      </div>
      {create.isError && <ErrorMessage error={create.error} />}
      <div className={styles.formActions}>
        <button
          type="submit"
          disabled={triage.disabled || create.isPending}
          title={triage.title}
          aria-describedby={commitPending ? reasonId : undefined}
          {...pendingGuard(commitPending)}
        >
          {create.isPending ? 'Creating...' : 'Create'}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        {commitPending && (
          <span id={reasonId} className={styles.reason}>
            Pick a commit from the list, or clear the field.
          </span>
        )}
      </div>
    </form>
  )
}
