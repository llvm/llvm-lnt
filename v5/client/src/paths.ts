/**
 * The paths of the SPA's pages (AR3), with the query parameters a link pre-fills them with. Every
 * identifier is encoded, since a commit value or a machine name may hold characters with a meaning
 * in a URL, such as `?` or `#`.
 */

const segment = encodeURIComponent

export function suitePath(suite: string): string {
  return `/suites/${segment(suite)}`
}

export function machinePath(suite: string, name: string): string {
  return `${suitePath(suite)}/machines/${segment(name)}`
}

export function runPath(suite: string, uuid: string): string {
  return `${suitePath(suite)}/runs/${segment(uuid)}`
}

export function commitPath(suite: string, value: string): string {
  return `${suitePath(suite)}/commits/${segment(value)}`
}

export function regressionPath(suite: string, uuid: string): string {
  return `${suitePath(suite)}/regressions/${segment(uuid)}`
}

/** `path`, followed by the parameters of `params` that are set, in order. */
function withQuery(path: string, params: [string, string | undefined][]): string {
  const set = params.filter((entry): entry is [string, string] => entry[1] !== undefined)
  const search = new URLSearchParams(set).toString()
  return search ? `${path}?${search}` : path
}

/** The Graph page (GR14), showing `suite` and `machine`, as far as they are given. */
export function graphPath({ suite, machine }: { suite?: string; machine?: string } = {}): string {
  return withQuery('/graph', [
    ['suite', suite],
    ['machine', machine],
  ])
}

/** The Compare page (CP7), with side A set to `suite` and `machine`, as far as they are given. */
export function comparePath({ suite, machine }: { suite?: string; machine?: string } = {}): string {
  return withQuery('/compare', [
    ['suite_a', suite],
    ['machine_a', machine],
  ])
}

/** The Profiles page (PF9), with side A set to `suite`, if given. */
export function profilesPath({ suite }: { suite?: string } = {}): string {
  return withQuery('/profiles', [['suite_a', suite]])
}
