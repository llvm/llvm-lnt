import type { Schemas } from '../api/client'
import type { ApiKey } from './credentials'
import { acceptedKey, useAuth, type TokenStatus } from './use-auth'

export type Scope = Schemas['Scope']

/** I5's hierarchy, lowest first: a key grants its own scope and every lower one. */
export const SCOPES = ['read', 'submit', 'triage', 'manage', 'admin'] as const satisfies Scope[]

/** The scopes a key can be restricted to some suites with (I5). */
export const RESTRICTABLE_SCOPES: readonly Scope[] = ['submit', 'triage', 'manage']

/** Where `scope` stands in the hierarchy: 0 for `read`, and one more for each scope above it. */
export function scopeRank(scope: Scope): number {
  return SCOPES.indexOf(scope)
}

/**
 * Whether `key` (null without a valid token) may do what needs `required` in `suite`, or, for an
 * action on no suite, with `suite` null. A key restricted to some suites grants its scope only in
 * them, and `read` anywhere (I5).
 */
export function grants(
  key: Pick<ApiKey, 'scope' | 'suites'> | null,
  required: Scope,
  suite: string | null,
): boolean {
  if (required === 'read') return true
  if (key === null || scopeRank(key.scope) < scopeRank(required)) return false
  return key.suites === null || (suite !== null && key.suites.includes(suite))
}

export interface ScopeGate {
  disabled: boolean
  /** Why the control is disabled, to show on hover. */
  title: string | undefined
}

/** `suites` as a sentence names them: `suite 'a'`, or `suites 'a', 'b'`. */
function suitesText(suites: readonly string[]): string {
  const names = suites.map((name) => `'${name}'`).join(', ')
  return `${suites.length === 1 ? 'suite' : 'suites'} ${names}`
}

/** Why a control needing `required` in `suite` is disabled, given the token's `status`. */
function reason(required: Scope, suite: string | null, status: TokenStatus): string {
  const restricted = status.state === 'valid' ? status.key.suites : null
  // Only a restrictable scope can be had in some suites and not in others.
  const needs =
    suite === null && RESTRICTABLE_SCOPES.includes(required)
      ? `Needs an instance-wide API token with the '${required}' scope.`
      : `Needs an API token with the '${required}' scope` +
        (suite !== null && restricted !== null ? ` in suite '${suite}'.` : '.')
  switch (status.state) {
    case 'none':
      return `${needs} Set one in Settings.`
    case 'checking':
      return `${needs} The token in Settings is still being checked.`
    case 'valid': {
      const where = restricted === null ? '' : ` only in ${suitesText(restricted)}`
      return `${needs} The token in Settings has the '${status.key.scope}' scope${where}.`
    }
    case 'invalid':
      return `${needs} The token in Settings is not valid.`
    case 'failed':
      return `${needs} The token in Settings could not be checked.`
  }
}

/**
 * AR17's gating of a control on the scope its action needs: disabled, saying on hover which scope
 * it needs, unless the token grants it in `suite`, the suite the action writes to, or null for an
 * action on no suite, which needs an instance-wide token. A control is disabled while its token is
 * being checked, since until then the SPA behaves as if there were none. Spread it onto the
 * control:
 *
 *     <button {...useScopeGate('manage', suite)} onClick={remove}>Delete</button>
 *
 * A control that is also disabled for reasons of its own combines them, as in
 * `disabled={gate.disabled || saving}`.
 *
 * A page that specifies otherwise, such as one showing a banner instead, uses `acceptedKey` with
 * `useAuth`.
 */
export function useScopeGate(required: Scope, suite: string | null): ScopeGate {
  const { status } = useAuth()
  if (grants(acceptedKey(status) ?? null, required, suite)) {
    return { disabled: false, title: undefined }
  }
  return { disabled: true, title: reason(required, suite, status) }
}
