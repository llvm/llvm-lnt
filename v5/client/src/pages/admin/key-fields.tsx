import { useId, type Ref } from 'react'
import { VisuallyHidden } from 'react-aria-components'
import { NAME_LENGTH } from '../../api/api-keys'
import { KEY_SCOPES, RESTRICTABLE_SCOPES, type KeyScope } from '../../auth/scope'
import { ErrorMessage } from '../../components/feedback'
import { TreeSelect, Select } from '../../components/select'
import type { CoversTree, KeyDraft } from './key-draft'
import styles from './admin.module.css'

/** Why a key of `scope` cannot be restricted for now, given `projects`, if it cannot. */
function whyUnrestrictable(scope: KeyScope, projects: CoversTree['projects']) {
  if (!RESTRICTABLE_SCOPES.includes(scope)) {
    return "Only 'submit', 'triage' and 'manage' keys can be restricted."
  }
  if (projects.data === undefined) {
    return projects.isError ? 'The projects could not be loaded.' : 'Loading projects...'
  }
  if (projects.data.length === 0) return 'There are no projects yet.'
}

interface FieldsProps {
  draft: KeyDraft
  onChange(change: Partial<KeyDraft>): void
  covers: CoversTree
  /** Whether the fields cannot be changed for now, while a change is confirmed or saved. */
  locked?: boolean
  nameRef?: Ref<HTMLInputElement>
}

/** The fields of the key form (AD1): its name, its scope and what it covers. */
export function KeyFields({ draft, onChange, covers, locked = false, nameRef }: FieldsProps) {
  return (
    <>
      <label className={styles.control}>
        Name
        <input
          ref={nameRef}
          type="text"
          className={styles.nameInput}
          value={draft.name}
          maxLength={NAME_LENGTH}
          autoComplete="off"
          readOnly={locked}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </label>
      <Select
        label="Scope"
        options={KEY_SCOPES.map((option) => ({ value: option, label: option }))}
        value={draft.scope}
        isDisabled={locked}
        onChange={(scope) =>
          // The choice goes back to "Everything" (AD1), keeping what is checked.
          onChange(RESTRICTABLE_SCOPES.includes(scope) ? { scope } : { scope, restrict: false })
        }
      />
      <CoversChoice draft={draft} onChange={onChange} covers={covers} locked={locked} />
    </>
  )
}

/**
 * What a key covers (AD1): everything, or only what is checked in a dropdown holding a tree of
 * every project of the instance and its suites. While "Only these:" cannot be picked for want of
 * projects, a choice of it already made stays: only a scope that cannot be restricted takes it
 * back to "Everything" (see `KeyFields`).
 */
function CoversChoice({
  draft: { scope, restrict, checked },
  onChange,
  covers: { projects, tree },
  locked,
}: Required<Omit<FieldsProps, 'nameRef'>>) {
  const unrestrictable = whyUnrestrictable(scope, projects)
  const group = useId()
  const whyId = useId()

  return (
    <fieldset className={styles.covers}>
      <legend>Covers</legend>
      <label>
        <input
          type="radio"
          name={group}
          checked={!restrict}
          disabled={locked}
          onChange={() => onChange({ restrict: false })}
        />
        Everything (instance-wide)
      </label>
      <div className={styles.only}>
        <label title={unrestrictable}>
          <input
            type="radio"
            name={group}
            checked={restrict}
            disabled={locked || unrestrictable !== undefined}
            aria-describedby={unrestrictable === undefined ? undefined : whyId}
            onChange={() => onChange({ restrict: true })}
          />
          Only these:
        </label>
        {unrestrictable !== undefined && (
          <VisuallyHidden id={whyId}>{unrestrictable}</VisuallyHidden>
        )}
        <TreeSelect
          label="Projects and suites to restrict to"
          hideLabel
          placeholder="Select projects or suites"
          options={tree}
          value={checked}
          onChange={(value) => onChange({ checked: value })}
          isDisabled={locked || !restrict}
        />
      </div>
      {projects.isError && projects.data === undefined && (
        <ErrorMessage
          context="The projects could not be loaded"
          error={projects.error}
          onRetry={() => void projects.refetch()}
        />
      )}
    </fieldset>
  )
}

/**
 * What the prompt confirming that the key of the token in Settings is revoked, or loses `admin`,
 * adds (AD1), saying where the token of a key created last is shown.
 */
export function OwnKeyWarning({ token }: { token: 'above' | 'below' }) {
  return (
    <p>
      It is the key of the token in Settings: this tab will no longer be available, and a token
      shown {token}, not copied yet, will be lost.
    </p>
  )
}
