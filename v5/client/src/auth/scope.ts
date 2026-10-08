import type { Schemas } from '../api/client'
import { useAuth, type TokenStatus } from './use-auth'

export type Scope = Schemas['Scope']

/** I5's hierarchy: a key grants its own scope and every lower one. */
const RANK: Record<Scope, number> = { read: 0, submit: 1, triage: 2, manage: 3, admin: 4 }

/** Whether a caller with `granted` (null without a valid token) may do what needs `required`. */
export function grants(granted: Scope | null, required: Scope): boolean {
  return required === 'read' || (granted !== null && RANK[granted] >= RANK[required])
}

/** The scope a token with `status` grants: null without a valid one, undefined while it is checked. */
function grantedBy(status: TokenStatus): Scope | null | undefined {
  if (status.state === 'checking') return undefined
  return status.state === 'valid' ? status.key.scope : null
}

/**
 * The scope of the token, once a check has accepted it: null without a valid token (none, refused,
 * or a check that failed), and undefined while its check is under way, so that a page waiting on
 * it can show that it is loading rather than that permission is denied.
 */
export function useGrantedScope(): Scope | null | undefined {
  return grantedBy(useAuth().status)
}

export interface ScopeGate {
  disabled: boolean
  /** Why the control is disabled, to show on hover. */
  title: string | undefined
}

/** Why a control needing `required` is disabled, given the token's `status`. */
function reason(required: Scope, status: TokenStatus): string {
  const needs = `Needs an API token with the '${required}' scope.`
  switch (status.state) {
    case 'none':
      return `${needs} Set one in Settings.`
    case 'checking':
      return `${needs} The token in Settings is still being checked.`
    case 'valid':
      return `${needs} The token in Settings has the '${status.key.scope}' scope.`
    case 'invalid':
      return `${needs} The token in Settings is not valid.`
    case 'failed':
      return `${needs} The token in Settings could not be checked.`
  }
}

/**
 * AR2's gating of a control on the scope its action needs: disabled, saying on hover which scope it
 * needs, unless the token grants it. A control is disabled while its token is being checked, since
 * until then the SPA behaves as if there were none. Spread it onto the control:
 *
 *     <button {...useScopeGate('manage')} onClick={remove}>Delete</button>
 *
 * A control that is also disabled for reasons of its own combines them, as in
 * `disabled={gate.disabled || saving}`.
 *
 * A page that specifies otherwise, such as one showing a banner instead, uses `useGrantedScope`.
 */
export function useScopeGate(required: Scope): ScopeGate {
  const { status } = useAuth()
  if (grants(grantedBy(status) ?? null, required)) return { disabled: false, title: undefined }
  return { disabled: true, title: reason(required, status) }
}
