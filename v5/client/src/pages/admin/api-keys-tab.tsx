import { useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { VisuallyHidden } from 'react-aria-components'
import { NAME_LENGTH, useApiKeys, type ApiKey, type ApiKeyList } from '../../api/api-keys'
import { authedApi, PERMISSION_DENIED, unwrap, type Schemas } from '../../api/client'
import { queryKeys } from '../../api/keys'
import { useKnownSuites, useSuites, type SuiteSchema } from '../../api/suites'
import {
  grants,
  RESTRICTABLE_SCOPES,
  RESTRICTED_TO_NOTHING,
  scopeRank,
  SCOPES,
  useScopeGate,
  type Scope,
  type ScopeGate,
} from '../../auth/scope'
import { acceptedKey, useAuth } from '../../auth/use-auth'
import { Confirmation } from '../../components/confirmation'
import { ActionButton } from '../../components/action-button'
import { DangerButton } from '../../components/danger-button'
import { DataTable, type Column } from '../../components/data-table'
import { Alert, ErrorMessage, Loaded, Loading } from '../../components/feedback'
import { MultiSelect, Select } from '../../components/select'
import type { TableSort } from '../../components/table-sort'
import { useRowConfirm } from '../../components/use-row-confirm'
import { formatTimestamp, yesNo } from '../../format'
import { compareSuiteLists, suiteLabel, suiteOption, suitesNamed } from '../../labels'
import { CopyButton } from '../../components/copy-button'
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
 * it shows -- a token shown only once -- is not lost. Its actions are disabled meanwhile, as AR17
 * gates them, since until the check succeeds no token would be sent.
 */
export function ApiKeysTab(sorting: Sorting) {
  const key = acceptedKey(useAuth().status)
  // What the latest settled check said, while another is under way.
  const [settled, setSettled] = useState(key)
  if (key !== undefined && key !== settled) setSettled(key)
  const isAdmin = (checked: ApiKey | null | undefined) => grants(checked ?? null, 'admin', null)

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
  const gate = useScopeGate('admin', null)
  const titleId = useId()
  const warningId = useId()
  const [name, setName] = useState('')
  const [scope, setScope] = useState<Scope>('read')
  // Whether "Only these suites:" is chosen over "All suites", and the suites checked under it.
  const [restrict, setRestrict] = useState(false)
  const [checked, setChecked] = useState<string[]>([])
  const suites = useSuites()
  const create = useMutation({
    mutationFn: (body: Schemas['ApiKeyCreate']) =>
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
  const unrestrictable = whyUnrestrictable(scope, suites)
  // "Only these suites:" gives way to "All suites" while it cannot be chosen: for good once the
  // scope cannot be restricted (see the Scope dropdown), and until the suites are listed otherwise.
  const restricting = restrict && unrestrictable === undefined
  // Only the suites still listed, should one checked have gone since.
  const listed = new Set(suites.data?.map((suite) => suite.name))
  const restrictedTo = restricting ? checked.filter((suite) => listed.has(suite)) : null
  const reason =
    gate.title ??
    (trimmed === '' ? 'Give the key a name first.' : undefined) ??
    (restrictedTo?.length === 0 ? 'Pick at least one suite.' : undefined)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (reason === undefined && !create.isPending) {
      create.mutate({ name: trimmed, scope, suites: restrictedTo })
    }
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
            onChange={(next) => {
              setScope(next)
              // The choice goes back to "All suites" (AD1), keeping the suites checked.
              if (!RESTRICTABLE_SCOPES.includes(next)) setRestrict(false)
            }}
          />
          <SuitesChoice
            suites={suites}
            unrestrictable={unrestrictable}
            restrict={restricting}
            onRestrict={setRestrict}
            checked={checked}
            onCheck={setChecked}
          />
          <ActionButton type="submit" reason={reason} busy={create.isPending}>
            {create.isPending ? 'Creating...' : 'Create key'}
          </ActionButton>
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

/** Why a key of `scope` cannot be restricted to some of `suites` for now, if it cannot. */
function whyUnrestrictable(scope: Scope, suites: ReturnType<typeof useSuites>) {
  if (!RESTRICTABLE_SCOPES.includes(scope)) {
    return "Only 'submit', 'triage' and 'manage' keys can be restricted to some suites."
  }
  if (suites.data === undefined) {
    return suites.isError ? 'The test suites could not be loaded.' : 'Loading test suites...'
  }
  if (suites.data.length === 0) return 'There are no test suites yet.'
}

interface SuitesChoiceProps {
  suites: ReturnType<typeof useSuites>
  /** Why "Only these suites:" cannot be chosen, if it cannot. */
  unrestrictable: string | undefined
  /** Whether the key is restricted to the suites checked, rather than instance-wide. */
  restrict: boolean
  onRestrict(restrict: boolean): void
  checked: string[]
  onCheck(checked: string[]): void
}

/**
 * The suites a key is for (AD1): all of them, or only those checked in a dropdown listing every
 * suite of the instance.
 */
function SuitesChoice({
  suites,
  unrestrictable,
  restrict,
  onRestrict,
  checked,
  onCheck,
}: SuitesChoiceProps) {
  const group = useId()
  const whyId = useId()

  return (
    <fieldset className={styles.suites}>
      <legend>Suites</legend>
      <label>
        <input type="radio" name={group} checked={!restrict} onChange={() => onRestrict(false)} />
        All suites (instance-wide)
      </label>
      <div className={styles.only}>
        <label title={unrestrictable}>
          <input
            type="radio"
            name={group}
            checked={restrict}
            disabled={unrestrictable !== undefined}
            aria-describedby={unrestrictable === undefined ? undefined : whyId}
            onChange={() => onRestrict(true)}
          />
          Only these suites:
        </label>
        {unrestrictable !== undefined && (
          <VisuallyHidden id={whyId}>{unrestrictable}</VisuallyHidden>
        )}
        <MultiSelect
          label="Suites to restrict to"
          hideLabel
          placeholder="Select suites"
          options={(suites.data ?? []).map(suiteOption)}
          value={checked}
          onChange={onCheck}
          isDisabled={!restrict}
        />
      </div>
      {suites.isError && suites.data === undefined && (
        <ErrorMessage
          context="The test suites could not be loaded"
          error={suites.error}
          onRetry={() => void suites.refetch()}
        />
      )}
    </fieldset>
  )
}

type SortColumn = (typeof KEY_SORT_COLUMNS)[number]

/** What the hover of a key restricted to nothing says (AD1). */
const NOTHING_HOVER = `${RESTRICTED_TO_NOTHING[0].toUpperCase()}${RESTRICTED_TO_NOTHING.slice(1)}.`

/**
 * Every column but the last, which holds each active key's Revoke button. `Suites` names a key's
 * suites by their labels as `known` has them, in AR22's order, and sorts `All` first, then by the
 * suites shown, compared in turn, and `Nothing` last (AD1).
 */
function columns(known: SuiteSchema[] | undefined): (Column<ApiKey> & { id: SortColumn })[] {
  const coveredBy = (key: ApiKey) => key.suites && suitesNamed(known, key.suites)
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
      cell: (key) => key.scope,
      // By the hierarchy, from the lowest scope to the highest (AD1).
      sortKey: (key) => scopeRank(key.scope),
    },
    {
      id: 'suites',
      header: 'Suites',
      cell: (key) => {
        const suites = coveredBy(key)
        if (suites === null) return 'All'
        if (suites.length > 0) return suites.map(suiteLabel).join(', ')
        // Its suites were all deleted, which leaves it restricted to nothing (AD1, I5).
        return (
          <span className={styles.nothing} title={NOTHING_HOVER}>
            Nothing
          </span>
        )
      },
      compare: (a, b) => {
        const [first, second] = [coveredBy(a), coveredBy(b)]
        if (first === null || second === null) {
          return Number(second === null) - Number(first === null)
        }
        if (first.length === 0 || second.length === 0) return second.length - first.length
        return compareSuiteLists(first, second)
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
    {
      id: 'is_active',
      header: 'Active',
      cell: (key) => yesNo(key.is_active),
      sortKey: (key) => Number(key.is_active),
    },
  ]
}

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
  const gate = useScopeGate('admin', null)
  const known = useKnownSuites()
  // Built again only when the suites change, so that the table sorts its rows again only then.
  const shown = useMemo(() => columns(known), [known])
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
          {revoking.prefix === ownPrefix && (
            <p>
              It is the key of the token in Settings: this tab will no longer be available, and a
              token shown above, not copied yet, will be lost.
            </p>
          )}
        </Confirmation>
      )}
      <DataTable
        label="API keys"
        ref={tableRef}
        columns={[...shown, revokeColumn(revokeGate, rowConfirm.open)]}
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
