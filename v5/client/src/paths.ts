/**
 * The paths of the SPA's pages (AR3), with the query parameters a link pre-fills them with. Every
 * identifier is encoded, since a commit value or a machine name may hold characters with a meaning
 * in a URL, such as `?` or `#`.
 */

/**
 * A suite, by its project's name and its own: a `SuiteRef` (see api/suite-ref.ts), spelled out so
 * that this module imports nothing, and the end-to-end tests can load it as it is.
 */
interface SuiteRef {
  project: string
  suite: string
}

const segment = encodeURIComponent

/** The Test Suites page listing every project's suites (TS1). */
export const PROJECTS_PATH = '/projects'

/** The Test Suites page listing the suites of the project `project` (TS1). */
export function projectPath(project: string): string {
  return `${PROJECTS_PATH}/${segment(project)}`
}

export function suitePath({ project, suite }: SuiteRef): string {
  return `${projectPath(project)}/suites/${segment(suite)}`
}

export function machinePath(suite: SuiteRef, name: string): string {
  return `${suitePath(suite)}/machines/${segment(name)}`
}

export function runPath(suite: SuiteRef, uuid: string): string {
  return `${suitePath(suite)}/runs/${segment(uuid)}`
}

export function commitPath(suite: SuiteRef, value: string): string {
  return `${suitePath(suite)}/commits/${segment(value)}`
}

export function regressionPath(suite: SuiteRef, uuid: string): string {
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
  suite?: SuiteRef
  machines?: string[]
  metric?: string
  test?: string
  /** Which regressions are marked on the chart (GR15). */
  regressions?: 'active' | 'all'
  /** How each run's samples, then the runs, are combined: the Graph's defaults when not given. */
  sampleAgg?: string
  runAgg?: string
  /** The commits highlighted on the chart (GR16). */
  highlight?: string[]
}

/** The Graph page (GR14), showing `view`. */
export function graphPath({
  suite,
  machines = [],
  metric,
  test,
  regressions,
  sampleAgg,
  runAgg,
  highlight = [],
}: GraphView = {}): string {
  return withQuery('/graph', [
    ['project', suite?.project],
    ['suite', suite?.suite],
    // Repeated once per machine, as a setting holding several values is (AR2 "State").
    ...machines.map((machine): Param => ['machine', machine]),
    ['metric', metric],
    ['test', test],
    ['run_agg', runAgg],
    ['sample_agg', sampleAgg],
    ['regressions', regressions],
    // Each once, as the Graph highlights it.
    ...[...new Set(highlight)].map((commit): Param => ['highlight', commit]),
  ])
}

/** One side of the Compare page (CP7), as far as it is given. */
interface CompareSide {
  suite?: SuiteRef
  machine?: string
  commit?: string
  /** The runs selected among those of `machine` at `commit`: every one of them when not given. */
  runs?: string[]
}

/** What the Compare page compares the two sides by (CP7), as far as it is given. */
interface CompareSettings {
  metric?: string
  /** How each run's samples, then the runs, are combined: Compare's defaults when not given. */
  sampleAgg?: string
  runAgg?: string
}

/** The Compare page (CP7), with side A and side B, and what they are compared by, as far as given. */
export function comparePath(
  a: CompareSide = {},
  b: CompareSide = {},
  { metric, sampleAgg, runAgg }: CompareSettings = {},
): string {
  const side = (suffix: string, { suite, machine, commit, runs = [] }: CompareSide): Param[] => [
    [`project_${suffix}`, suite?.project],
    [`suite_${suffix}`, suite?.suite],
    [`machine_${suffix}`, machine],
    [`commit_${suffix}`, commit],
    // Repeated once per run, as a setting holding several values is (AR2 "State").
    ...runs.map((run): Param => [`runs_${suffix}`, run]),
  ]
  return withQuery('/compare', [
    ...side('a', a),
    ...side('b', b),
    ['metric', metric],
    ['run_agg', runAgg],
    ['sample_agg', sampleAgg],
  ])
}

/**
 * One side of the Profiles page (PF9): the profile of `test` in `run`, a run of `machine` at
 * `commit`, as far as given.
 */
interface ProfileSide {
  suite?: SuiteRef
  machine?: string
  commit?: string
  run?: string
  test?: string
}

/** The Profiles page (PF9), with side A, and side B, set as far as given. */
export function profilesPath(a: ProfileSide = {}, b: ProfileSide = {}): string {
  const side = (suffix: string, { suite, machine, commit, run, test }: ProfileSide): Param[] => [
    [`project_${suffix}`, suite?.project],
    [`suite_${suffix}`, suite?.suite],
    [`machine_${suffix}`, machine],
    [`commit_${suffix}`, commit],
    [`run_${suffix}`, run],
    [`test_${suffix}`, test],
  ]
  return withQuery('/profiles', [...side('a', a), ...side('b', b)])
}
