import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router'
import { authedApi, unwrap, type Schemas } from '../../api/client'
import {
  deleteRegression,
  regressionChanged,
  regressionKey,
  regressionScope,
  TEXT_LENGTH,
  useRegression,
} from '../../api/regressions'
import type { SuiteSchema } from '../../api/suites'
import { useScopeGate } from '../../auth/scope'
import { BugLink } from '../../components/bug-link'
import { CommitLink } from '../../components/commit-link'
import { CommitPicker, UNPICKED_COMMIT } from '../../components/commit-picker'
import { ErrorMessage, Loaded } from '../../components/feedback'
import { InfoBox, InfoRow } from '../../components/info-box'
import { InlineEdit } from '../../components/inline-edit'
import { StateBadge } from '../../components/regression-state'
import { Select } from '../../components/select'
import { WithSchema } from '../../components/with-schema'
import { formatTimestamp, plural, regressionTitle, shortUuid, uuidPrefix } from '../../format'
import { REGRESSION_STATES, stateLabel } from '../../regression-states'
import { suiteTabPath } from '../test-suites/settings'
import { ActionRow } from './action-row'
import styles from './details.module.css'

type Regression = Schemas['RegressionDetail']

const STATE_OPTIONS = REGRESSION_STATES.map((state) => ({ value: state, label: stateLabel(state) }))

/** The Regression Detail page (DT4). */
export default function RegressionDetailPage() {
  const { suite = '', uuid = '' } = useParams()
  // The regression the content fetches, once it has the suite's schema, so that the header follows
  // the title once an edit is saved.
  const title = useRegression(suite, uuid, { fetch: false }).data?.title
  return (
    <section>
      <h1>Regression: {title ?? shortUuid(uuid)}</h1>
      <WithSchema suite={suite}>
        {/* Keyed, so that nothing of a regression's page, an open editor say, stays on another's. */}
        {(schema) => <RegressionContent key={`${suite}/${uuid}`} schema={schema} uuid={uuid} />}
      </WithSchema>
    </section>
  )
}

function RegressionContent({ schema, uuid }: { schema: SuiteSchema; uuid: string }) {
  const regression = useRegression(schema.name, uuid)
  return (
    <Loaded
      isPending={regression.isPending}
      error={regression.error}
      onRetry={() => void regression.refetch()}
    >
      {regression.data && (
        <>
          <RegressionInfo schema={schema} regression={regression.data} />
          <Actions suite={schema.name} regression={regression.data} />
        </>
      )}
    </Loaded>
  )
}

/**
 * Change the regression `uuid` with `PATCH /regressions/{uuid}` (E8), and show what the API
 * returned. Every change to the regression runs in its scope, one after the other.
 */
function useUpdateRegression(suite: string, uuid: string) {
  const queryClient = useQueryClient()
  return useMutation({
    scope: regressionScope(suite, uuid),
    // A fetch of the regression under way could land after the answer, and show it as it was.
    onMutate: () => queryClient.cancelQueries({ queryKey: regressionKey(suite, uuid) }),
    mutationFn: (body: Schemas['RegressionUpdate']) =>
      unwrap(
        authedApi.PATCH('/api/suites/{testsuite}/regressions/{uuid}', {
          params: { path: { testsuite: suite, uuid } },
          body,
        }),
      ),
    onSuccess: (updated) => regressionChanged(queryClient, suite, uuid, () => updated),
  })
}

/**
 * The regression's title, state, bug, commit and notes, each of which a holder of `triage` scope
 * can edit, and when it was created (DT4).
 */
function RegressionInfo({ schema, regression }: { schema: SuiteSchema; regression: Regression }) {
  const triage = useScopeGate('triage')
  const update = useUpdateRegression(schema.name, regression.uuid).mutateAsync
  return (
    <InfoBox label="Regression">
      <InfoRow label="Title">
        <InlineEdit
          label="Title"
          value={regression.title}
          gate={triage}
          maxLength={TEXT_LENGTH}
          onSave={(title) => update({ title })}
        />
      </InfoRow>
      <InfoRow label="State">
        <StateRow suite={schema.name} regression={regression} />
      </InfoRow>
      <InfoRow label="Bug">
        <InlineEdit
          label="Bug"
          value={regression.bug}
          display={(bug) => <BugLink bug={bug} />}
          gate={triage}
          maxLength={TEXT_LENGTH}
          onSave={(bug) => update({ bug })}
        />
      </InfoRow>
      <InfoRow label="Commit">
        <InlineEdit
          label="Commit"
          value={regression.commit}
          display={(commit) => <CommitLink schema={schema} value={commit} />}
          gate={triage}
          // Any commit of the suite (AR2 "Commit pickers"). The row says what it is, so the
          // picker's label is for assistive technology only.
          editor={({ label, text, setText, setPending, saving }) => (
            <CommitPicker
              label={label}
              hideLabel
              schema={schema}
              value={text === '' ? null : text}
              onChange={(value) => setText(value ?? '')}
              onPendingChange={setPending}
              isReadOnly={saving}
              placeholder="None"
            />
          )}
          pendingReason={UNPICKED_COMMIT}
          onSave={(commit) => update({ commit })}
        />
      </InfoRow>
      <InfoRow label="Created">{formatTimestamp(regression.created_at)}</InfoRow>
      <InfoRow label="Notes">
        <InlineEdit
          label="Notes"
          value={regression.notes}
          gate={triage}
          multiline
          onSave={(notes) => update({ notes })}
        />
      </InfoRow>
    </InfoBox>
  )
}

/**
 * The regression's state, with its badge, which a holder of `triage` scope changes by picking
 * another, saved at once (AR2 "Controls saving on change").
 */
function StateRow({ suite, regression }: { suite: string; regression: Regression }) {
  const triage = useScopeGate('triage')
  const update = useUpdateRegression(suite, regression.uuid)
  return (
    <>
      <span className={styles.inline}>
        {/* The dropdown says the same, to assistive technology too. */}
        <span aria-hidden="true">
          <StateBadge state={regression.state} />
        </span>
        <Select
          label="State"
          hideLabel
          options={STATE_OPTIONS}
          value={regression.state}
          // Not optimistic: the dropdown shows the state the API holds. While a change is under
          // way, it cannot be opened, but is not disabled either, which would lose the focus.
          onChange={(state) => {
            if (!update.isPending) update.mutate({ state })
          }}
          listPicksOnly
          isPending={update.isPending}
          isDisabled={triage.disabled}
          title={triage.title}
        />
      </span>
      {update.isError && <ErrorMessage error={update.error} />}
    </>
  )
}

/** Delete regression, with its confirmation below it (DT4). */
function Actions({ suite, regression }: { suite: string; regression: Regression }) {
  const { uuid } = regression
  return (
    <ActionRow
      deletion={{
        suite,
        label: 'Delete regression',
        scope: 'triage',
        expected: uuidPrefix(uuid),
        message: (
          <p>
            Delete the regression <strong>{regressionTitle(regression)}</strong> and its{' '}
            {plural(regression.indicators.length, 'indicator')}? This cannot be undone.
          </p>
        ),
        onDelete: () => deleteRegression(suite, uuid),
        leaveTo: suiteTabPath(suite, 'regressions'),
      }}
    />
  )
}
