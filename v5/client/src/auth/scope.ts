import type { Schemas } from '../api/client'
import { useKnownProjects, type Project, type ProjectName } from '../api/suites'
import { fullLabel, fullLabelOf, projectLabel, projectNamed, suitesNamed } from '../labels'
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

/** An entry of a restricted key's list (I5): a single suite. */
export type Entry = Schemas['RestrictionEntry']

/**
 * What an action writes to (I5): a suite; a project, in full, when `suite` is left out, such as when
 * a suite is created in it; or, with null, the instance, which only an instance-wide key covers.
 */
export type Target = { project: string; suite?: string } | null

/**
 * Whether a key restricted to `restrictedTo`, unless null, covers `target` (I5): a suite it lists.
 * Since a key lists single suites, only an instance-wide key covers a project in full.
 */
function covers(restrictedTo: readonly Entry[] | null, target: Target): boolean {
  if (restrictedTo === null) return true
  return (
    target?.suite !== undefined &&
    restrictedTo.some((entry) => entry.project === target.project && entry.suite === target.suite)
  )
}

/**
 * Whether `key` (null without a valid token) may do what needs `required` on `target`. A restricted
 * key grants its scope only on what it covers, and `read` anywhere (I5). Once everything it listed
 * has been deleted, it lists nothing, and grants only `read`.
 */
export function grants(
  key: Pick<ApiKey, 'scope' | 'restricted_to'> | null,
  required: Scope,
  target: Target,
): boolean {
  if (required === 'read') return true
  if (key === null || scopeRank(key.scope) < scopeRank(required)) return false
  return covers(key.restricted_to, target)
}

export interface ScopeGate {
  disabled: boolean
  /** Why the control is disabled, to show on hover. */
  title: string | undefined
}

/** What happened to a key whose suites were all deleted, which leaves it restricted to nothing. */
export const RESTRICTED_TO_NOTHING =
  'the suites it was restricted to have been deleted, so it can only read'

/** The suites `entries` list, as the projects `known` hold them (AR22), in AR22's order. */
export function coveredSuites(entries: readonly Entry[], known: readonly Project[] | undefined) {
  return suitesNamed(
    known?.flatMap((project) => project.suites),
    entries,
  )
}

/**
 * Where a key restricted to `entries` has its scope, as a sentence says it, naming the suites by
 * their full labels as `known` has them (AR22): `only in suite 'a/b'`, `only in suites 'a/b', 'c/d'`,
 * or in none once they have all been deleted (I5).
 */
function restrictionText(entries: readonly Entry[], known: readonly Project[] | undefined): string {
  if (entries.length === 0) return `in no suite: ${RESTRICTED_TO_NOTHING}`
  const labels = coveredSuites(entries, known).map((suite) => `'${fullLabel(suite)}'`)
  return `only in ${labels.length === 1 ? 'suite' : 'suites'} ${labels.join(', ')}`
}

/** What a reason can be about: a target, or any one project in full, picked among several. */
type Wanted = Target | typeof SOME_PROJECT

const SOME_PROJECT = 'some project'

/** What the target needs to be covered, as a sentence says it, naming it as AR22 says. */
function needed(required: Scope, target: Wanted, known: readonly Project[] | undefined): string {
  if (target === null) return `Needs an instance-wide API token with the '${required}' scope.`
  if (target === SOME_PROJECT) {
    return `Needs an API token with the '${required}' scope covering a project in full.`
  }
  if (target.suite === undefined) {
    const project = projectLabel(projectNamed(known, target.project))
    return `Needs an API token with the '${required}' scope covering project '${project}' in full.`
  }
  const ref = { project: target.project, suite: target.suite }
  const suites = known?.flatMap((project) => project.suites)
  return `Needs an API token with the '${required}' scope in suite '${fullLabelOf(suites, ref)}'.`
}

/**
 * Why a control needing `required` on `target` is disabled, given the token's `status`, naming the
 * suites and projects by their labels as `known` has them.
 */
function reason(
  required: Scope,
  target: Wanted,
  status: TokenStatus,
  known: readonly Project[] | undefined,
): string {
  const restricted = status.state === 'valid' ? status.key.restricted_to : null
  // Only a restrictable scope can be had in some suites and not in others, and the token's
  // restriction only matters for one that has it.
  const needs =
    RESTRICTABLE_SCOPES.includes(required) && (target === null || restricted !== null)
      ? needed(required, target, known)
      : `Needs an API token with the '${required}' scope.`
  switch (status.state) {
    case 'none':
      return `${needs} Set one in Settings.`
    case 'checking':
      return `${needs} The token in Settings is still being checked.`
    case 'valid': {
      const where = restricted === null ? '' : ` ${restrictionText(restricted, known)}`
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
 * it needs, unless the token grants it on `target`: the suite the action writes to, the project it
 * writes to in full, or null for an action on neither, which needs an instance-wide token. A control
 * is disabled while its token is being checked, since until then the SPA behaves as if there were
 * none. Spread it onto the control:
 *
 *     <button {...useScopeGate('manage', suite)} onClick={remove}>Delete</button>
 *
 * A control that is also disabled for reasons of its own combines them, as in
 * `disabled={gate.disabled || saving}`.
 *
 * A page that specifies otherwise, such as one showing a banner instead, uses `acceptedKey` with
 * `useAuth`.
 */
export function useScopeGate(required: Scope, target: Target): ScopeGate {
  const { status } = useAuth()
  const known = useKnownProjects()
  if (grants(acceptedKey(status) ?? null, required, target)) {
    return { disabled: false, title: undefined }
  }
  return { disabled: true, title: reason(required, target, status, known) }
}

/**
 * Why the token, as `status` has it, does not grant `required` on `target`, or undefined if it does:
 * for the options of a control that picks what an action writes to, which the token does not allow
 * (AR17), as `useScopeGate` would say it.
 */
export function refusal(
  required: Scope,
  target: Target,
  status: TokenStatus,
  known: readonly Project[] | undefined,
): string | undefined {
  if (grants(acceptedKey(status) ?? null, required, target)) return undefined
  return reason(required, target, status, known)
}

/**
 * Why the token, as `status` has it, grants `required` on none of `projects` in full, or undefined
 * if it grants it on one of them: for a control starting an action on a project picked among them,
 * such as "New suite", which is enabled as long as one of them is allowed (AR17). Until the
 * projects are listed (undefined), only a token without the scope is known to be refused.
 */
export function refusalInEvery(
  required: Scope,
  projects: readonly ProjectName[] | undefined,
  status: TokenStatus,
  known: readonly Project[] | undefined,
): string | undefined {
  const key = acceptedKey(status) ?? null
  const allowed =
    projects === undefined
      ? key !== null && scopeRank(key.scope) >= scopeRank(required)
      : projects.some((project) => grants(key, required, { project: project.name }))
  if (allowed) return undefined
  if (projects === undefined) return reason(required, SOME_PROJECT, status, known)
  const target = projects.length === 1 ? { project: projects[0].name } : SOME_PROJECT
  return reason(required, target, status, known)
}
