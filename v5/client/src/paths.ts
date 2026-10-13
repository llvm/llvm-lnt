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

type Param = [string, string | undefined]

/** `path`, followed by the parameters of `params` that are set, in order. */
function withQuery(path: string, params: Param[]): string {
  const set = params.filter((entry): entry is [string, string] => entry[1] !== undefined)
  const search = new URLSearchParams(set).toString()
  return search ? `${path}?${search}` : path
}

/** What the Graph page (GR14) is to show, as far as it is given. */
interface GraphView {
  suite?: string
  machines?: string[]
  metric?: string
  test?: string
  /** Which regressions are marked on the chart (GR15). */
  regressions?: 'active' | 'all'
}

/** The Graph page (GR14), showing `view`. */
export function graphPath({
  suite,
  machines = [],
  metric,
  test,
  regressions,
}: GraphView = {}): string {
  return withQuery('/graph', [
    ['suite', suite],
    // Repeated once per machine, as a setting holding several values is (AR2 "State").
    ...machines.map((machine): Param => ['machine', machine]),
    ['metric', metric],
    ['test', test],
    ['regressions', regressions],
  ])
}

/** One side of the Compare page (CP7), as far as it is given. */
interface CompareSide {
  suite?: string
  machine?: string
  commit?: string
  /** The runs selected among those of `machine` at `commit`: every one of them when not given. */
  runs?: string[]
  /** How the side's runs are combined: Compare's default when not given. */
  runAgg?: string
}

/**
 * The Compare page (CP7), with side A and side B set as far as they are given, `metric`, and how
 * each run's samples are combined (`sampleAgg`, Compare's default when not given).
 */
export function comparePath(
  a: CompareSide = {},
  b: CompareSide = {},
  metric?: string,
  sampleAgg?: string,
): string {
  const side = (
    suffix: string,
    { suite, machine, commit, runs = [], runAgg }: CompareSide,
  ): Param[] => [
    [`suite_${suffix}`, suite],
    [`machine_${suffix}`, machine],
    [`commit_${suffix}`, commit],
    // Repeated once per run, as a setting holding several values is (AR2 "State").
    ...runs.map((run): Param => [`runs_${suffix}`, run]),
    [`run_agg_${suffix}`, runAgg],
  ]
  return withQuery('/compare', [
    ...side('a', a),
    ...side('b', b),
    ['metric', metric],
    ['sample_agg', sampleAgg],
  ])
}

/** One side of the Profiles page (PF9): the profile of `test` in `run`, as far as given. */
interface ProfileSide {
  suite?: string
  run?: string
  test?: string
}

/** The Profiles page (PF9), with side A, and side B, set as far as given. */
export function profilesPath(a: ProfileSide = {}, b: ProfileSide = {}): string {
  return withQuery('/profiles', [
    ['suite_a', a.suite],
    ['run_a', a.run],
    ['test_a', a.test],
    ['suite_b', b.suite],
    ['run_b', b.run],
    ['test_b', b.test],
  ])
}
