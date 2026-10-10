import { useId, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { VisuallyHidden } from 'react-aria-components'
import { NAME_LENGTH, useApiKeys, type ApiKey, type ApiKeyList } from '../../api/api-keys'
import { authedApi, PERMISSION_DENIED, unwrap } from '../../api/client'
import { queryKeys } from '../../api/keys'
import { grants, scopeRank, SCOPES, useScopeGate, type Scope, type ScopeGate } from '../../auth/scope'
import { acceptedKey, useAuth } from '../../auth/use-auth'
import { ConfirmDelete } from '../../components/confirm-delete'
import { DangerButton } from '../../components/danger-button'
import { DataTable, type Column } from '../../components/data-table'
import { Alert, ErrorMessage, Loaded, Loading } from '../../components/feedback'
import { Select } from '../../components/select'
import type { TableSort } from '../../components/table-sort'
import { useRowConfirm } from '../../components/use-row-confirm'
import { formatTimestamp } from '../../format'
import { CopyButton } from './copy-button'
import type { KEY_SORT_COLUMNS } from './settings'
import tableStyles from '../../components/data-table.module.css'
import styles from './admin.module.css'

interface Sorting {
  /** How the keys table is sorted, as the URL keeps it. */
  sort: TableSort
  onSort(sort: TableSort): void
}

/**
 * The API Keys tab (AD1). Even listing keys needs `admin`, so without it the tab says only that
 * permission is denied, and asks the API nothing. While the token is being checked, the tab says
 * so, unless it is already showing the keys, which it keeps until the check settles, so that what
 * it shows -- a token shown only once -- is not lost. Its actions are disabled meanwhile, as AR2
 * gates them, since until the check succeeds no token would be sent.
 */
export function ApiKeysTab(sorting: Sorting) {
  const key = acceptedKey(useAuth().status)
  // What the latest settled check said, while another is under way.
  const [settled, setSettled] = useState(key)
  if (key !== undefined && key !== settled) setSettled(key)
  const isAdmin = (checked: ApiKey | null | undefined) => !!checked && grants(checked.scope, 'admin')

  if (isAdmin(key === undefined ? settled : key)) {
    return <ApiKeys accepted={isAdmin(key)} ownPrefix={settled?.prefix} {...sorting} />
  }
  if (key === undefined) return <Loading label="Checking the API token..." />
  return <Alert>{PERMISSION_DENIED}</Alert>
}

interface KeysProps extends Sorting {
  /** Whether a check has accepted the token, rather than one being under way. */
  accepted: boolean
  /** The prefix of the token's key, as the latest settled check says. */
  ownPrefix: string | undefined
}

function ApiKeys({ accepted, ownPrefix, ...sorting }: KeysProps) {
  const keys = useApiKeys(accepted)
  return (
    <>
      <CreateKey />
      <Loaded
        isPending={keys.isPending}
        error={keys.error}
        // A retry while the token is checked would be sent without it.
        onRetry={() => {
          if (accepted) void keys.refetch()
        }}
      >
        {keys.data && <KeysTable keys={keys.data} ownPrefix={ownPrefix} {...sorting} />}
      </Loaded>
    </>
  )
}

/** The form creating a key, and the token of the key it created last, shown once (AD1). */
function CreateKey() {
  const queryClient = useQueryClient()
  const gate = useScopeGate('admin')
  const titleId = useId()
  const reasonId = useId()
  const warningId = useId()
  const [name, setName] = useState('')
  const [scope, setScope] = useState<Scope>('read')
  const create = useMutation({
    mutationFn: (body: { name: string; scope: Scope }) =>
      unwrap(authedApi.POST('/api/admin/api-keys', { body })),
    // The token is shown from the mutation's data, which goes as soon as nothing shows it: when
    // the user leaves the tab, or asks for another key, even if that fails.
    gcTime: 0,
    onSuccess: async (_, sent) => {
      // A name typed meanwhile is kept.
      setName((current) => (current.trim() === sent.name ? '' : current))
      // The list is asked for again, without the token waiting for it. One on its way may not hold
      // the new key, and a refetch alone would join it, if it is the first, rather than start
      // another: it is cancelled first.
      await queryClient.cancelQueries({ queryKey: queryKeys.apiKeys })
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys })
    },
  })

  const trimmed = name.trim()
  const reason = gate.title ?? (trimmed === '' ? 'Give the key a name first.' : undefined)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (reason === undefined && !create.isPending) create.mutate({ name: trimmed, scope })
  }

  const token = create.data?.token
  return (
    <>
      <form className={styles.createForm} aria-labelledby={titleId} onSubmit={submit}>
        <strong id={titleId} className={styles.formTitle}>
          Create API Key
        </strong>
        <div className={styles.fields}>
          <label className={styles.control}>
            Name
            <input
              type="text"
              className={styles.nameInput}
              value={name}
              maxLength={NAME_LENGTH}
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <Select
            label="Scope"
            options={SCOPES.map((option) => ({ value: option, label: option }))}
            value={scope}
            onChange={setScope}
          />
          <button
            type="submit"
            disabled={reason !== undefined || create.isPending}
            title={reason}
            aria-describedby={reason === undefined ? undefined : reasonId}
          >
            {create.isPending ? 'Creating...' : 'Create key'}
          </button>
          {reason !== undefined && <VisuallyHidden id={reasonId}>{reason}</VisuallyHidden>}
        </div>
      </form>
      {create.isError && <ErrorMessage error={create.error} />}
      {token !== undefined && (
        <section className={styles.created} aria-label="Created key">
          <p id={warningId} className={styles.createdText}>
            Key created. Copy the token now — it will not be shown again:
          </p>
          <div className={styles.tokenBox}>
            <code className={styles.token}>{token}</code>
            {/* The focus goes from the button that created the key to the one copying its token,
                which says why. */}
            <CopyButton text={token} describedBy={warningId} autoFocus>
              Copy to clipboard
            </CopyButton>
          </div>
        </section>
      )}
    </>
  )
}

type SortColumn = (typeof KEY_SORT_COLUMNS)[number]

/** Every column but the last, which holds each active key's Revoke button. */
const COLUMNS: (Column<ApiKey> & { id: SortColumn })[] = [
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
    cell: (key) => key.scope,
    // By the hierarchy, from the lowest scope to the highest (AD1).
    sortKey: (key) => scopeRank(key.scope),
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
  {
    id: 'is_active',
    header: 'Active',
    cell: (key) => (key.is_active ? 'Yes' : 'No'),
    sortKey: (key) => Number(key.is_active),
  },
]

function revokeColumn(
  gate: ScopeGate,
  onRevoke: (key: ApiKey, button: HTMLElement) => void,
): Column<ApiKey> {
  return {
    id: 'revoke',
    header: <VisuallyHidden>Actions</VisuallyHidden>,
    cell: (key) =>
      key.is_active && (
        <DangerButton
          type="button"
          {...gate}
          aria-label={`Revoke key ${key.prefix}`}
          onClick={(event) => onRevoke(key, event.currentTarget)}
        >
          Revoke
        </DangerButton>
      ),
  }
}

/** The keys, sortable by any column but the last, each active one with its Revoke button. */
function KeysTable({
  keys,
  ownPrefix,
  sort,
  onSort,
}: { keys: ApiKey[] } & Omit<KeysProps, 'accepted'>) {
  const queryClient = useQueryClient()
  const { recheck } = useAuth()
  const gate = useScopeGate('admin')
  const tableRef = useRef<HTMLTableElement>(null)
  const rowConfirm = useRowConfirm<ApiKey>(tableRef)
  const revoking = rowConfirm.item

  const revoke = useMutation({
    mutationFn: (key: ApiKey) =>
      unwrap(
        authedApi.DELETE('/api/admin/api-keys/{prefix}', {
          params: { path: { prefix: key.prefix } },
        }),
      ),
    onSuccess: async (_, key) => {
      // A list on its way could land after the answer, and show the key as active again.
      await queryClient.cancelQueries({ queryKey: queryKeys.apiKeys })
      // Revoked keys stay listed, as inactive (E11): the row changes in place.
      queryClient.setQueryData<ApiKeyList>(
        queryKeys.apiKeys,
        (list) =>
          list && {
            items: list.items.map((item) =>
              item.prefix === key.prefix ? { ...item, is_active: false } : item,
            ),
          },
      )
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

  // One revocation at a time.
  const revokeGate = revoke.isPending ? { ...gate, disabled: true } : gate

  return (
    <>
      {revoking && (
        <ConfirmDelete
          key={revoking.prefix}
          confirmLabel="Revoke"
          scope="admin"
          onConfirm={() => revoke.mutateAsync(revoking)}
          onCancel={rowConfirm.cancel}
        >
          <p>
            Revoke the key <strong>{revoking.name}</strong> (
            <code className={tableStyles.mono}>{revoking.prefix}</code>)? Its token stops working at
            once, and the key cannot be restored.
          </p>
          {revoking.prefix === ownPrefix && (
            <p>
              It is the key of the token in Settings: this tab will no longer be available, and a
              token shown above, not copied yet, will be lost.
            </p>
          )}
        </ConfirmDelete>
      )}
      <DataTable
        label="API keys"
        ref={tableRef}
        columns={[...COLUMNS, revokeColumn(revokeGate, rowConfirm.open)]}
        rows={keys}
        rowKey={(key) => key.prefix}
        confirming={(key) => key.prefix === revoking?.prefix}
        empty="No API keys yet."
        sort={sort}
        onSort={onSort}
      />
    </>
  )
}
