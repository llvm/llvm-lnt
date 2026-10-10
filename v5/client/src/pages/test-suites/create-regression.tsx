import { useId, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { authedApi, unwrap } from '../../api/client'
import { queryKeys } from '../../api/keys'
import { regressionKey, TEXT_LENGTH } from '../../api/regressions'
import type { SuiteSchema } from '../../api/suites'
import { useScopeGate } from '../../auth/scope'
import { CommitPicker, UNPICKED_COMMIT } from '../../components/commit-picker'
import { ErrorMessage } from '../../components/feedback'
import { pendingGuard } from '../../components/pending-guard'
import { Select } from '../../components/select'
import { regressionPath } from '../../paths'
import { REGRESSION_STATES, stateLabel, type RegressionState } from '../../regression-states'
import styles from './test-suites.module.css'

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
    onSuccess: async (created) => {
      // Refetched when it is shown again, rather than now, on the way to another page.
      await queryClient.invalidateQueries({
        queryKey: queryKeys.regressions(suite),
        refetchType: 'none',
      })
      // What the page shown next would fetch, stored after, which leaves it fresh.
      queryClient.setQueryData(regressionKey(suite, created.uuid), created)
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
            maxLength={TEXT_LENGTH}
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
            maxLength={TEXT_LENGTH}
            placeholder="https://..."
            onChange={(event) => setBug(event.target.value)}
          />
        </label>
        <Select
          label="State"
          options={REGRESSION_STATES.map((option) => ({ value: option, label: stateLabel(option) }))}
          value={state}
          onChange={setState}
        />
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
            {UNPICKED_COMMIT}
          </span>
        )}
      </div>
    </form>
  )
}
