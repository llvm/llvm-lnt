import { useId, useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CHANGE_KEY, updateCachedKey, type ApiKey } from '../../api/api-keys'
import { ApiError, authedApi, unwrap, type Schemas } from '../../api/client'
import { queryKeys } from '../../api/keys'
import { fullName } from '../../api/suite-ref'
import { refetchProjectsIfOutdated, useKnownProjects } from '../../api/suites'
import { RESTRICTABLE_SCOPES, useScopeGate } from '../../auth/scope'
import { useAuth } from '../../auth/use-auth'
import { ActionButton } from '../../components/action-button'
import { Confirmation } from '../../components/confirmation'
import { ErrorMessage } from '../../components/feedback'
import { entriesNamed, type EntryRef } from '../../labels'
import {
  coversText,
  restrictionOf,
  useCoversTree,
  type CoversTree,
  type KeyDraft,
} from './key-draft'
import { KeyFields, OwnKeyWarning } from './key-fields'
import tableStyles from '../../components/data-table.module.css'
import styles from './admin.module.css'

/** What a change sends (E11), with its entries as a key lists them. */
type Changes = Omit<Schemas['ApiKeyUpdate'], 'restricted_to'> & { restricted_to?: EntryRef[] | null }

/**
 * The form `key` opens with. A suite the key lists along with its whole project shows as covered
 * by the project, as the form cannot check both.
 */
function draftOf(key: ApiKey): KeyDraft {
  const entries = key.restricted_to ?? []
  const whole = new Set(entries.filter((entry) => entry.suite === null).map((entry) => entry.project))
  return {
    name: key.name,
    scope: key.scope,
    restrict: key.restricted_to !== null,
    checked: entries.flatMap(({ project, suite }) => {
      if (suite === null) return [project]
      return whole.has(project) ? [] : [fullName({ project, suite })]
    }),
  }
}

/** Whether two restrictions list the same entries, in any order. */
function sameEntries(a: readonly EntryRef[] | null, b: readonly EntryRef[] | null): boolean {
  if (a === null || b === null) return a === b
  const named = (entries: readonly EntryRef[]) =>
    new Set(entries.map(({ project, suite }) => JSON.stringify([project, suite])))
  const [first, second] = [named(a), named(b)]
  return first.size === second.size && [...first].every((entry) => second.has(entry))
}

/**
 * What saving `draft` changes in `key`: only what the user changed, so that a change made elsewhere
 * to another field is kept. What the key covers is unchanged until the user changes what the form
 * says it covers (`touched`), whatever the form's tree knows of, such as a project created since it
 * was listed.
 */
function changesOf(key: ApiKey, draft: KeyDraft, touched: boolean, tree: CoversTree): Changes {
  const changes: Changes = {}
  const name = draft.name.trim()
  // Neither the name the form opened with nor the key's, once trimmed, as AR12 has it.
  if (draft.name !== key.name && name !== key.name) changes.name = name
  if (draft.scope !== key.scope) changes.scope = draft.scope
  const restrictedTo = touched ? restrictionOf(draft, tree) : key.restricted_to
  if (!sameEntries(restrictedTo, key.restricted_to)) changes.restricted_to = restrictedTo
  // A scope that cannot be restricted makes the key instance-wide, even if it has been restricted
  // elsewhere since the form opened.
  if (changes.scope !== undefined && !RESTRICTABLE_SCOPES.includes(changes.scope)) {
    changes.restricted_to = null
  }
  return changes
}

interface Props {
  /** The key, as the form opened with it. */
  apiKey: ApiKey
  /** Whether the key has been revoked since, here or elsewhere: it can no longer be changed. */
  revoked: boolean
  /** The prefix of the token's key, as the latest settled check says. */
  ownPrefix: string | undefined
  nameRef: RefObject<HTMLInputElement | null>
  /** Close the form, whether or not the key was changed. */
  onClose(): void
}

/**
 * The key form changing `apiKey` (AD1): its name, its scope and what it covers, which a plain
 * confirmation (AR16) shows before anything but the name changes, since every bot using its token is
 * affected at once.
 */
export function EditKey({ apiKey: key, revoked, ownPrefix, nameRef, onClose }: Props) {
  const queryClient = useQueryClient()
  const gate = useScopeGate('admin', null)
  const { recheck } = useAuth()
  const known = useKnownProjects()
  const titleId = useId()
  const tree = useCoversTree()
  const [draft, setDraft] = useState(() => draftOf(key))
  // Whether the user has changed what the form says the key covers, or a scope has done it.
  const [touched, setTouched] = useState(false)
  const [confirming, setConfirming] = useState<Changes | null>(null)
  const saveRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const own = key.prefix === ownPrefix
  const named = (entries: EntryRef[] | null) => entries && entriesNamed(known, entries)

  const change = useMutation({
    mutationKey: CHANGE_KEY,
    mutationFn: (body: Changes) =>
      unwrap(
        authedApi.PATCH('/api/admin/api-keys/{prefix}', {
          params: { path: { prefix: key.prefix } },
          body,
        }),
      ),
    onSuccess: async (changed) => {
      await updateCachedKey(queryClient, changed.prefix, () => changed)
      if (own) {
        // So that Settings, this tab and every control gated on the token show what it grants now
        // (AD1). The list is not asked for again meanwhile: it would go without the token.
        recheck()
      } else {
        // In place of one cancelled above, which a key created just before may not be in yet.
        void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys })
      }
      onClose()
    },
    onError: (error) => {
      // The key was revoked elsewhere (409), or it, or a project or a suite it would list, is gone.
      if (!(error instanceof ApiError) || (error.status !== 409 && error.status !== 404)) return
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys })
      refetchProjectsIfOutdated(queryClient, error)
    },
  })

  // The focus goes to the form as it opens, on another key's Edit included.
  useLayoutEffect(() => nameRef.current?.focus(), [nameRef])

  const busy = confirming !== null || change.isPending
  // A Save that the key's revocation disables gives the focus to Cancel, rather than lose it.
  useLayoutEffect(() => {
    if (revoked && document.activeElement === saveRef.current) cancelRef.current?.focus()
  }, [revoked])

  const changes = changesOf(key, draft, touched, tree)
  const reason =
    gate.title ??
    (revoked ? 'This key has been revoked: it can no longer be changed.' : undefined) ??
    (draft.name.trim() === '' ? 'Give the key a name first.' : undefined) ??
    (changes.restricted_to?.length === 0 ? 'Pick at least one project or suite.' : undefined)

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (busy || reason !== undefined) return
    // Nothing to change: nothing is sent (AD1, as AR12 has it).
    if (Object.keys(changes).length === 0) return onClose()
    // A new name alone changes nothing the key can do.
    if (changes.scope !== undefined || changes.restricted_to !== undefined) setConfirming(changes)
    else change.mutate(changes)
  }
  const closePrompt = () => {
    setConfirming(null)
    saveRef.current?.focus()
  }

  return (
    <>
      <form className={styles.form} aria-labelledby={titleId} onSubmit={save}>
        <strong id={titleId} className={styles.formTitle}>
          Edit key <code className={tableStyles.mono}>{key.prefix}</code> · {key.name}
        </strong>
        <div className={styles.fields}>
          <KeyFields
            draft={draft}
            onChange={(update) => {
              if ('restrict' in update || 'checked' in update) setTouched(true)
              setDraft((current) => ({ ...current, ...update }))
            }}
            covers={tree}
            locked={busy}
            nameRef={nameRef}
          />
          <ActionButton ref={saveRef} type="submit" reason={reason} busy={busy}>
            {change.isPending ? 'Saving...' : 'Save'}
          </ActionButton>
          <ActionButton ref={cancelRef} busy={busy} onClick={onClose}>
            Cancel
          </ActionButton>
        </div>
      </form>
      {confirming !== null && (
        <Confirmation
          confirmLabel="Save"
          gate={gate}
          onConfirm={async () => {
            // A failure shows below the form, whose Save is where the user is left.
            closePrompt()
            change.mutate(confirming)
          }}
          onCancel={closePrompt}
        >
          <p>
            Change the key <strong>{key.name}</strong> (
            <code className={tableStyles.mono}>{key.prefix}</code>)?
          </p>
          <ul className={styles.changes}>
            {confirming.name !== undefined && (
              <li>
                Name: {key.name} → {confirming.name}
              </li>
            )}
            {confirming.scope !== undefined && (
              <li>
                Scope: {key.scope} → {confirming.scope}
              </li>
            )}
            {/* Not for an instance-wide key made instance-wide again by its scope. */}
            {confirming.restricted_to !== undefined &&
              !sameEntries(key.restricted_to, confirming.restricted_to) && (
                <li>
                  Covers: {coversText(named(key.restricted_to))} →{' '}
                  {coversText(named(confirming.restricted_to))}
                </li>
              )}
          </ul>
          <p>Every bot using its token is affected at once. The token itself stays the same.</p>
          {own && confirming.scope !== undefined && confirming.scope !== 'admin' && (
            <OwnKeyWarning token="below" />
          )}
        </Confirmation>
      )}
      {change.isError && <ErrorMessage error={change.error} />}
    </>
  )
}
