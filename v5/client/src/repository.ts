/**
 * The repository a suite's commits come from (D4), and the links to it that the UI builds from its
 * templates (AR20).
 */

import type { Schemas } from './api/client'

export type Repository = Schemas['Repository']
/** The repository's URL templates. */
export type UrlKey = Exclude<keyof Repository, 'label'>

/** The commit fields a template may name, by their names and types. */
export type TemplateFields = readonly { name: string; type: string }[]

/** What a URL template needs of its suite: the template, and the commit fields it may name. */
export interface LinkedSuite {
  repository: Repository
  commit_fields: TemplateFields
}

/** What a commit fills a template in with: its commit string, and its values for its fields. */
export type LinkedCommit = Pick<Schemas['Commit'], 'value' | 'fields'>

/**
 * The commits each URL template is filled in with (D4). A template accepts the placeholders of
 * each, `{commit}` and `{commit.<field>}` say, and requires at least one of each.
 */
const TEMPLATE_COMMITS: Record<UrlKey, readonly string[]> = {
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
// What a placeholder of one of a commit's fields holds: the commit, and the field's name.
const FIELD_PLACEHOLDER = /^([a-z]+)\.([A-Za-z][A-Za-z0-9_]*)$/
// The values that cannot fill a field placeholder in, besides null (D4): next to dots of the
// template, each could make a dot segment, which would change the path.
const UNFILLABLE: ReadonlySet<string> = new Set(['', '.', '..'])

/** The commit that the placeholder `{name}` is of, and the field it names, if it names one. */
function parsePlaceholder(name: string): { commit: string; field?: string } {
  const field = FIELD_PLACEHOLDER.exec(name)
  return field ? { commit: field[1], field: field[2] } : { commit: name }
}

/**
 * Why `template` cannot be the repository's `key`, if it cannot, in a suite with the commit fields
 * `fields`. The schema editor refuses such a template, and no link is built from one, even if the
 * server stored it.
 */
export function templateProblem(
  key: UrlKey,
  template: string,
  fields: TemplateFields,
): string | undefined {
  const commits = TEMPLATE_COMMITS[key]
  if (URL_EXCLUDED.test(template)) return 'A URL cannot contain spaces or ASCII control characters.'
  const scheme = URL_SCHEME.exec(template)
  if (scheme === null) return 'A URL starts with http:// or https://.'
  const named = new Set<string>()
  for (const [placeholder, name] of template.matchAll(PLACEHOLDER)) {
    const { commit } = parsePlaceholder(name)
    if (!commits.includes(commit)) {
      const accepted = [...commits.map((c) => `{${c}}`), ...commits.map((c) => `{${c}.<field>}`)]
      const last = accepted.pop()
      const only = `${accepted.join(', ')} and ${last}`
      return `${placeholder} is not a placeholder this URL accepts, only ${only}.`
    }
    named.add(commit)
  }
  if (/[{}]/.test(template.replace(PLACEHOLDER, ''))) {
    return 'This URL cannot contain braces other than those of its placeholders.'
  }
  if (commits.some((commit) => !named.has(commit))) {
    const required = commits.map((commit) => `{${commit}} or {${commit}.<field>}`)
    return `This URL must contain ${required.join(', and ')}.`
  }
  const host = template.slice(scheme[0].length).split(/[/?#]/, 1)[0]
  if (host === '') return 'A URL names a host after http:// or https://.'
  if (host.includes('{')) return 'A URL names its host as it is, without a placeholder.'
  return templateFieldProblem(template, fields)
}

/**
 * Why `template` names a field that is not one of the `text` commit fields `fields`, if it does
 * (D4). It reads only the placeholders that name a field, so that it can check a template that
 * `templateProblem` refuses otherwise.
 */
export function templateFieldProblem(
  template: string,
  fields: TemplateFields,
): string | undefined {
  for (const [, placeholder] of template.matchAll(PLACEHOLDER)) {
    const name = parsePlaceholder(placeholder).field
    if (name === undefined) continue
    const field = fields.find((field) => field.name === name)
    if (field === undefined) return `This URL names ${name}, which is not a commit field.`
    if (field.type !== 'text') return `This URL names ${name}, which is not a text field.`
  }
  return undefined
}

/** A field placeholder that its commit cannot fill in (D4): the commit's, and the field's name. */
export interface MissingValue {
  commit: string
  field: string
}

/**
 * `template` with every placeholder replaced by its value, from its commit in `commits`,
 * percent-encoded as D4 says: every character but an ASCII letter, a digit or one of `-_.!~*'()`,
 * which is exactly what `encodeURIComponent` leaves alone. If a commit cannot fill in one of its
 * field placeholders (D4), the first such placeholder instead.
 */
export function fillTemplate(
  template: string,
  commits: Readonly<Record<string, LinkedCommit>>,
): string | MissingValue {
  let missing: MissingValue | undefined
  const url = template.replace(PLACEHOLDER, (placeholder, name: string) => {
    const { commit, field } = parsePlaceholder(name)
    if (!Object.hasOwn(commits, commit)) return placeholder
    if (field === undefined) return encodeURIComponent(commits[commit].value)
    const value = commits[commit].fields[field]
    if (typeof value === 'string' && !UNFILLABLE.has(value)) return encodeURIComponent(value)
    missing ??= { commit, field }
    return placeholder
  })
  return missing ?? url
}

/** The suite's template `key`, or null if it has none, or one that D4 refuses (AR20). */
export function usableTemplate(suite: LinkedSuite, key: UrlKey): string | null {
  const template = suite.repository[key]
  if (template === null) return null
  return templateProblem(key, template, suite.commit_fields) === undefined ? template : null
}

/** `template` filled in with `commits`, or null if there is none, or they cannot fill it in. */
function filledIn(template: string | null, commits: Record<string, LinkedCommit>): string | null {
  const url = template === null ? null : fillTemplate(template, commits)
  return typeof url === 'string' ? url : null
}

/**
 * The URL of the commit `commit`, or null if the suite has no usable template of it, or the commit
 * cannot fill it in (AR20).
 */
export function commitUrl(suite: LinkedSuite, commit: LinkedCommit): string | null {
  return filledIn(usableTemplate(suite, 'commit_url'), { commit })
}

/**
 * The URL of the changes from the commit `from`, excluded, to `to`, included, or null if the suite
 * has no usable template of it, or the commits cannot fill it in (AR20).
 */
export function rangeUrl(suite: LinkedSuite, from: LinkedCommit, to: LinkedCommit): string | null {
  return filledIn(usableTemplate(suite, 'range_url'), { from, to })
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
