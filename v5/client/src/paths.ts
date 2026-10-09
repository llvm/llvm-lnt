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

/** One side of the Compare page (CP7), as far as it is given. */
interface CompareSide {
  suite?: string
  machine?: string
  commit?: string
  /** The runs selected among those of `machine` at `commit`: every one of them when not given. */
  runs?: string[]
}

/** The Compare page (CP7), with side A and side B set as far as they are given, and `metric`. */
export function comparePath(a: CompareSide = {}, b: CompareSide = {}, metric?: string): string {
  type Param = [string, string | undefined]
  const side = (suffix: string, { suite, machine, commit, runs = [] }: CompareSide): Param[] => [
    [`suite_${suffix}`, suite],
    [`machine_${suffix}`, machine],
    [`commit_${suffix}`, commit],
    // Repeated once per run, as a setting holding several values is (AR2 "State").
    ...runs.map((run): Param => [`runs_${suffix}`, run]),
  ]
  return withQuery('/compare', [...side('a', a), ...side('b', b), ['metric', metric]])
}

/** The Profiles page (PF9), with side A set to the profile of `test` in `run`, as far as given. */
export function profilesPath({
  suite,
  run,
  test,
}: { suite?: string; run?: string; test?: string } = {}): string {
  return withQuery('/profiles', [
    ['suite_a', suite],
    ['run_a', run],
    ['test_a', test],
  ])
}
