import { useCallback, useId, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react'
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query'
import { VisuallyHidden } from 'react-aria-components'
import clsx from 'clsx'
import { CHANGE_KEY, updateCachedKey, useApiKeys, type ApiKey } from '../../api/api-keys'
import { authedApi, unwrap, type Schemas } from '../../api/client'
import { queryKeys } from '../../api/keys'
import { useKnownProjects, type Project } from '../../api/suites'
import {
  grants,
  refusal,
  RESTRICTED_TO_NOTHING,
  scopeRank,
  useScopeGate,
  type ScopeGate,
} from '../../auth/scope'
import { acceptedKey, useAuth } from '../../auth/use-auth'
import { Confirmation } from '../../components/confirmation'
import { ActionButton } from '../../components/action-button'
import { DangerButton } from '../../components/danger-button'
import { DataTable, type Column } from '../../components/data-table'
import { Alert, ErrorMessage, Loaded, Loading } from '../../components/feedback'
import type { TableSort } from '../../components/table-sort'
import { useFocusOnceChecked } from '../../components/use-focus-once-checked'
import { useRowConfirm } from '../../components/use-row-confirm'
import { formatTimestamp, yesNo } from '../../format'
import { compareEntryLists, entriesNamed, type NamedEntry } from '../../labels'
import { CopyButton } from '../../components/copy-button'
import { EditKey } from './edit-key'
import { coversText, restrictionOf, useCoversTree, type KeyDraft } from './key-draft'
import { KeyFields, OwnKeyWarning } from './key-fields'
import type { KEY_SORT_COLUMNS } from './settings'
import tableStyles from '../../components/data-table.module.css'
import styles from './admin.module.css'

interface Sorting {
  /** How the keys table is sorted, as the URL keeps it. */
  sort: TableSort
  onSort(sort: TableSort): void
}

/**
 * The API Keys tab (AD1). Even listing keys needs `admin`, so without it the tab says only that it
 * needs it, as a control gated on it would (AR17), and asks the API nothing. While the token is
 * being checked, the tab says
 * so, unless it is already showing the keys, which it keeps until the check settles, so that what
 * it shows -- a token shown only once -- is not lost. Its actions are disabled meanwhile, as AR17
 * gates them, since until the check succeeds no token would be sent.
 */
export function ApiKeysTab(sorting: Sorting) {
  const { status } = useAuth()
  const known = useKnownProjects()
  const key = acceptedKey(status)
  // What the latest settled check said, while another is under way.
  const [settled, setSettled] = useState(key)
  if (key !== undefined && key !== settled) setSettled(key)
  const isAdmin = (checked: ApiKey | null | undefined) => grants(checked ?? null, 'admin', null)

  if (isAdmin(key === undefined ? settled : key)) {
    return <ApiKeys accepted={isAdmin(key)} ownPrefix={settled?.prefix} {...sorting} />
  }
  if (key === undefined) return <Loading label="Checking the API token..." />
  return <Alert>Permission denied. {refusal('admin', null, status, known)}</Alert>
}

interface KeysProps extends Sorting {
  /** Whether a check has accepted the token, rather than one being under way. */
  accepted: boolean
  /** The prefix of the token's key, as the latest settled check says. */
  ownPrefix: string | undefined
}

function ApiKeys({ accepted, ownPrefix, ...sorting }: KeysProps) {
  const keys = useApiKeys(accepted)
  const tableRef = useRef<HTMLTableElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  // The key being changed, if any.
  const [editing, setEditing] = useState<ApiKey | null>(null)
  // The Edit button that opened the form, which the focus goes back to once it closes, or the table
  // once it has gone: once the token has been checked again, if the change was to its key (see
  // `EditKey`), since the check disables Edit meanwhile.
  const returnTo = useRef<HTMLButtonElement | null>(null)
  const [refocus, setRefocus] = useState(false)
  useFocusOnceChecked(
    refocus,
    useCallback(() => setRefocus(false), []),
    returnTo,
    tableRef,
  )

  const edit = (key: ApiKey, opener: HTMLButtonElement) => {
    // The form already changing the key keeps what it holds.
    if (editing?.prefix === key.prefix) return nameRef.current?.focus()
    returnTo.current = opener
    setEditing(key)
  }
  const closeEdit = () => {
    setEditing(null)
    setRefocus(true)
  }
  const current = editing && keys.data?.find((key) => key.prefix === editing.prefix)

  return (
    <>
      {editing && (
        <EditKey
          key={editing.prefix}
          apiKey={editing}
          revoked={current?.is_active === false}
          ownPrefix={ownPrefix}
          nameRef={nameRef}
          onClose={closeEdit}
        />
      )}
      <CreateKey hidden={editing !== null} />
      <Loaded
        data={keys.data}
        error={keys.error}
        // A retry while the token is checked would be sent without it.
        onRetry={() => {
          if (accepted) void keys.refetch()
        }}
      >
        {(data) => (
          <KeysTable
            keys={data}
            ownPrefix={ownPrefix}
            tableRef={tableRef}
            editing={editing?.prefix}
            onEdit={edit}
            {...sorting}
          />
        )}
      </Loaded>
    </>
  )
}

interface CreateProps {
  /** Whether the form gives way to the one changing a key, keeping what it holds meanwhile. */
  hidden: boolean
}

/**
 * The form creating a key, and the token of the key it created last, shown once (AD1), which
 * stays shown while the form gives way to the one changing a key.
 */
function CreateKey({ hidden }: CreateProps) {
  const queryClient = useQueryClient()
  const gate = useScopeGate('admin', null)
  const titleId = useId()
  const warningId = useId()
  const [draft, setDraft] = useState<KeyDraft>({
    name: '',
    scope: 'submit',
    restrict: false,
    checked: [],
  })
  const tree = useCoversTree()
  const create = useMutation({
    mutationFn: (body: Schemas['ApiKeyCreate']) =>
      unwrap(authedApi.POST('/api/admin/api-keys', { body })),
    // The token is shown from the mutation's data, which goes as soon as nothing shows it: when
    // the user leaves the tab, or asks for another key, even if that fails.
    gcTime: 0,
    onSuccess: async (_, sent) => {
      // A name typed meanwhile is kept.
      setDraft((current) => (current.name.trim() === sent.name ? { ...current, name: '' } : current))
      // The list is asked for again, without the token waiting for it. One on its way may not hold
      // the new key, and a refetch alone would join it, if it is the first, rather than start
      // another: it is cancelled first.
      await queryClient.cancelQueries({ queryKey: queryKeys.apiKeys })
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys })
    },
  })

  const trimmed = draft.name.trim()
  const restrictedTo = restrictionOf(draft, tree)
  const reason =
    gate.title ??
    (trimmed === '' ? 'Give the key a name first.' : undefined) ??
    (restrictedTo?.length === 0 ? 'Pick at least one project or suite.' : undefined)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (reason === undefined && !create.isPending) {
      create.mutate({ name: trimmed, scope: draft.scope, restricted_to: restrictedTo })
    }
  }

  const created = create.data
  return (
    <>
      {!hidden && (
        <>
          <form className={styles.form} aria-labelledby={titleId} onSubmit={submit}>
            <strong id={titleId} className={styles.formTitle}>
              Create API Key
            </strong>
            <div className={styles.fields}>
              <KeyFields
                draft={draft}
                onChange={(update) => setDraft((current) => ({ ...current, ...update }))}
                covers={tree}
              />
              <ActionButton type="submit" reason={reason} busy={create.isPending}>
                {create.isPending ? 'Creating...' : 'Create key'}
              </ActionButton>
            </div>
          </form>
          {create.isError && <ErrorMessage error={create.error} />}
        </>
      )}
      {created !== undefined && (
        <section className={styles.created} aria-label="Created key">
          <p id={warningId} className={styles.createdText}>
            Key <strong>{created.name}</strong> created. Copy the token now — it will not be shown
            again:
          </p>
          <div className={styles.tokenBox}>
            <code className={styles.token}>{created.token}</code>
            {/* The focus goes from the button that created the key to the one copying its token,
                which says why, unless the user has gone on to edit a key meanwhile. */}
            <CopyButton text={created.token} describedBy={warningId} autoFocus={!hidden}>
              Copy to clipboard
            </CopyButton>
          </div>
        </section>
      )}
    </>
  )
}

type SortColumn = (typeof KEY_SORT_COLUMNS)[number]

/** What the hover of a key restricted to nothing says (AD1). */
const NOTHING_HOVER = `${RESTRICTED_TO_NOTHING}.`

/**
 * The columns the keys can be sorted by, which come first. `Covers` names what a key covers by
 * labels as `known` has them, in AR22's order, and sorts `All` first, then by the entries shown,
 * compared in turn, and `Nothing` last (AD1).
 */
function columns(known: Project[] | undefined): (Column<ApiKey> & { id: SortColumn })[] {
  // Once per key, rather than at each comparison of a sort.
  const covered = new WeakMap<ApiKey, NamedEntry[] | null>()
  const coveredBy = (key: ApiKey) => {
    if (!covered.has(key)) {
      covered.set(key, key.restricted_to && entriesNamed(known, key.restricted_to))
    }
    return covered.get(key) as NamedEntry[] | null
  }
  return [
    {
      id: 'prefix',
      header: 'Prefix',
      looks: ['mono', 'nowrap'],
      cell: (key) => key.prefix,
      sortKey: (key) => key.prefix,
    },
    { id: 'name', header: 'Name', cell: (key) => key.name, sortKey: (key) => key.name },
    {
      id: 'scope',
      header: 'Scope',
      looks: ['nowrap'],
      cell: (key) => key.scope,
      // By the hierarchy, from the lowest scope to the highest (AD1).
      sortKey: (key) => scopeRank(key.scope),
    },
    {
      id: 'restricted_to',
      header: 'Covers',
      cell: (key) => {
        const entries = coveredBy(key)
        if (entries === null || entries.length > 0) return coversText(entries)
        // What it listed was all deleted, which leaves it restricted to nothing (AD1, I5).
        return (
          <span className={styles.nothing} title={NOTHING_HOVER}>
            {coversText(entries)}
          </span>
        )
      },
      compare: (a, b) => {
        const [first, second] = [coveredBy(a), coveredBy(b)]
        if (first === null || second === null) {
          return Number(second === null) - Number(first === null)
        }
        if (first.length === 0 || second.length === 0) return second.length - first.length
        return compareEntryLists(first, second)
      },
    },
    {
      id: 'created_at',
      header: 'Created',
      looks: ['nowrap'],
      cell: (key) => formatTimestamp(key.created_at),
      sortKey: (key) => Date.parse(key.created_at),
    },
    {
      id: 'last_used_at',
      header: 'Last Used',
      looks: ['nowrap'],
      cell: (key) => (key.last_used_at === null ? 'Never' : formatTimestamp(key.last_used_at)),
      // A key never used sorts after every key that has been, in both directions (AD1).
      sortKey: (key) => (key.last_used_at === null ? null : Date.parse(key.last_used_at)),
    },
  ]
}

/** Whether the key is active: no column to sort by, as revoked keys come last whatever the sort. */
const ACTIVE: Column<ApiKey> = {
  id: 'is_active',
  header: 'Active',
  cell: (key) => yesNo(key.is_active),
}

/** Revoked keys, listed after the others, whatever the sort (AD1). */
const revoked = (key: ApiKey) => !key.is_active

interface ActionsProps {
  gate: ScopeGate
  /** Whether a change to a key is being saved, during which no other key can be edited. */
  saving: boolean
  onEdit(key: ApiKey, button: HTMLButtonElement): void
  /** Whether a revocation is under way, during which no other key can be revoked. */
  revoking: boolean
  onRevoke(key: ApiKey, button: HTMLElement): void
}

/** The Edit and Revoke buttons of each active key: revoked keys are frozen (AD1). */
function actionsColumn({ gate, saving, onEdit, revoking, onRevoke }: ActionsProps): Column<ApiKey> {
  return {
    id: 'actions',
    header: <VisuallyHidden>Actions</VisuallyHidden>,
    cell: (key) =>
      key.is_active && (
        <span className={styles.actions}>
          <ActionButton
            reason={gate.title}
            busy={saving}
            aria-label={`Edit key ${key.prefix}`}
            onClick={(event) => onEdit(key, event.currentTarget)}
          >
            Edit
          </ActionButton>
          <DangerButton
            type="button"
            disabled={gate.disabled || revoking}
            title={gate.title}
            aria-label={`Revoke key ${key.prefix}`}
            onClick={(event) => onRevoke(key, event.currentTarget)}
          >
            Revoke
          </DangerButton>
        </span>
      ),
  }
}

interface TableProps extends Sorting {
  keys: ApiKey[]
  ownPrefix: string | undefined
  tableRef: RefObject<HTMLTableElement | null>
  /** The prefix of the key being changed, if any, whose row is highlighted. */
  editing: string | undefined
  onEdit(key: ApiKey, button: HTMLButtonElement): void
}

/**
 * The keys, active ones first, sortable by any column but the last two: Active, and the Edit and
 * Revoke buttons each active key has.
 */
function KeysTable({ keys, ownPrefix, tableRef, editing, onEdit, sort, onSort }: TableProps) {
  const queryClient = useQueryClient()
  const { recheck } = useAuth()
  const gate = useScopeGate('admin', null)
  const known = useKnownProjects()
  // Built again only when the projects change, so that the table sorts its rows again only then.
  const shown = useMemo(() => columns(known), [known])
  const rowProps = useCallback(
    (key: ApiKey) => ({
      className: clsx(!key.is_active && styles.revoked, key.prefix === editing && styles.editing),
    }),
    [editing],
  )
  const rowConfirm = useRowConfirm<ApiKey>(tableRef)
  const revoking = rowConfirm.item
  const saving = useIsMutating({ mutationKey: CHANGE_KEY }) > 0

  const revoke = useMutation({
    mutationFn: (key: ApiKey) =>
      unwrap(
        authedApi.DELETE('/api/admin/api-keys/{prefix}', {
          params: { path: { prefix: key.prefix } },
        }),
      ),
    onSuccess: async (_, key) => {
      // Revoked keys stay listed, as inactive (E11): the row goes among them.
      await updateCachedKey(queryClient, key.prefix, (item) => ({ ...item, is_active: false }))
      rowConfirm.done()
      if (key.prefix === ownPrefix) {
        // The token in Settings no longer authenticates: checked again, Settings and every control
        // gated on it say so at once (AD1), rather than on the next request it is refused for.
        recheck()
      } else {
        // The list is asked for again all the same, in place of one cancelled above, which a key
        // created just before may not be in yet.
        void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys })
      }
    },
  })

  return (
    <>
      {revoking && (
        <Confirmation
          key={revoking.prefix}
          confirmLabel="Revoke"
          gate={gate}
          onConfirm={() => revoke.mutateAsync(revoking)}
          onCancel={rowConfirm.cancel}
        >
          <p>
            Revoke the key <strong>{revoking.name}</strong> (
            <code className={tableStyles.mono}>{revoking.prefix}</code>)? Its token stops working at
            once, and the key cannot be restored.
          </p>
          {revoking.prefix === ownPrefix && <OwnKeyWarning token="above" />}
        </Confirmation>
      )}
      <DataTable
        label="API keys"
        ref={tableRef}
        columns={[
          ...shown,
          ACTIVE,
          actionsColumn({
            gate,
            saving,
            onEdit,
            // One revocation at a time.
            revoking: revoke.isPending,
            onRevoke: rowConfirm.open,
          }),
        ]}
        rows={keys}
        rowKey={(key) => key.prefix}
        rowProps={rowProps}
        trailing={revoked}
        confirming={(key) => key.prefix === revoking?.prefix}
        empty="No API keys yet."
        sort={sort}
        onSort={onSort}
      />
    </>
  )
}
