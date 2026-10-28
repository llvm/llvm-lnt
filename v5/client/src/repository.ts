/**
 * The repository a suite's commits come from (D4), and the links to it that the UI builds from its
 * templates (AR20).
 */

import type { Schemas } from './api/client'

export type Repository = Schemas['Repository']
/** The repository's URL templates. */
export type UrlKey = Exclude<keyof Repository, 'label'>

/** The placeholders each URL template accepts, and requires (D4). */
export const PLACEHOLDERS: Record<UrlKey, readonly string[]> = {
  commit_url: ['commit'],
  range_url: ['from', 'to'],
}

// D4's rules for URL templates: an http or https URL that names its host literally, with no space
// or ASCII control character -- a set spelled out, rather than "whitespace", which JavaScript and
// the server's Python do not agree on -- and no brace but those of the placeholders it accepts.
// `client/src/test/url-templates.json` holds the cases both must accept or refuse alike.
// Without the `u` flag, `i` folds no non-ASCII letter onto an ASCII one, unlike Python's
// IGNORECASE, which the server limits to ASCII: U+017F (the long s) does not pass for an `s`.
const URL_SCHEME = /^https?:\/\//i
// eslint-disable-next-line no-control-regex
const URL_EXCLUDED = /[\u0000-\u0020\u007f]/
const PLACEHOLDER = /\{([^{}]*)\}/g

/**
 * Why `template` cannot be the repository's `key`, if it cannot. The schema editor refuses such a
 * template, and no link is built from one, even if the server stored it.
 */
export function templateProblem(key: UrlKey, template: string): string | undefined {
  const placeholders = PLACEHOLDERS[key]
  const accepted = placeholders.map((name) => `{${name}}`).join(' and ')
  if (URL_EXCLUDED.test(template)) return 'A URL cannot contain spaces or ASCII control characters.'
  const scheme = URL_SCHEME.exec(template)
  if (scheme === null) return 'A URL starts with http:// or https://.'
  for (const [placeholder, name] of template.matchAll(PLACEHOLDER)) {
    if (!placeholders.includes(name)) {
      return `${placeholder} is not a placeholder this URL accepts, only ${accepted}.`
    }
  }
  if (/[{}]/.test(template.replace(PLACEHOLDER, ''))) {
    return `This URL cannot contain braces other than those of ${accepted}.`
  }
  if (placeholders.some((name) => !template.includes(`{${name}}`))) {
    return `This URL must contain ${accepted}.`
  }
  const host = template.slice(scheme[0].length).split(/[/?#]/, 1)[0]
  if (host === '') return 'A URL names a host after http:// or https://.'
  if (host.includes('{')) return 'A URL names its host as it is, without a placeholder.'
  return undefined
}

/**
 * `template` with every placeholder replaced by its value in `values`, percent-encoded as D4 says:
 * every character but an ASCII letter, a digit or one of `-_.!~*'()`, which is exactly what
 * `encodeURIComponent` leaves alone.
 */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? encodeURIComponent(values[name]) : placeholder,
  )
}

/** The repository's template `key`, or null if it has none, or one that D4 refuses (AR20). */
export function usableTemplate(repository: Repository, key: UrlKey): string | null {
  const template = repository[key]
  return template === null || templateProblem(key, template) !== undefined ? null : template
}

/** The URL of the commit `commit`, by its commit string, or null if the suite has none (AR20). */
export function commitUrl(repository: Repository, commit: string): string | null {
  const template = usableTemplate(repository, 'commit_url')
  return template && fillTemplate(template, { commit })
}

/**
 * The URL of the changes from the commit `from`, excluded, to `to`, included, by their commit
 * strings, or null if the suite has none (AR20).
 */
export function rangeUrl(repository: Repository, from: string, to: string): string | null {
  const template = usableTemplate(repository, 'range_url')
  return template && fillTemplate(template, { from, to })
}

/** The attributes of a link into the repository, which opens in a new tab (AR20). */
export const NEW_TAB = { target: '_blank', rel: 'noopener noreferrer' } as const

/**
 * The text of a link into the repository that does `action` (AR20): "{action} on {label}", or
 * "{action} in repository" when the repository has no label.
 */
export function repositoryLinkText({ label }: Repository, action: string): string {
  return label === null ? `${action} in repository` : `${action} on ${label}`
}

/** The text of a link to a commit in the repository (AR20). */
export function commitLinkText(repository: Repository): string {
  return repositoryLinkText(repository, 'View')
}
