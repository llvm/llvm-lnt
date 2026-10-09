/**
 * The paths of the SPA's suite-scoped pages (AR3). Every identifier is encoded, since a commit
 * value or a machine name may hold characters with a meaning in a URL, such as `?` or `#`.
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
