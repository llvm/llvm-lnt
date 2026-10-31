/** A suite's identity, apart from what the UI holds of it (see `suites.ts`). */

/** A suite's identity, which the UI takes everywhere (AR22): its project's name and its own. */
export interface SuiteRef {
  project: string
  suite: string
}

const refs = new Map<string, SuiteRef>()

/**
 * The suite named `suite` in the project named `project`: the same object for the same names, so
 * that what depends on it, such as a memoized value, does not change from one render to the next,
 * and two of them are the same suite exactly when they are the same object.
 */
export function suiteRef(project: string, suite: string): SuiteRef {
  const key = `${project}\0${suite}`
  let ref = refs.get(key)
  if (ref === undefined) {
    ref = { project, suite }
    refs.set(key, ref)
  }
  return ref
}

/**
 * What stands for no suite, where a URL names none, and what a hook that needs a suite is given
 * while there is none, along with what disables it. A URL naming only one of a suite's names names
 * no usable suite: the suite it gives, with the other name empty, is in no list of suites, and is
 * dropped like any other suite that does not exist (AR2 "State").
 */
export const NO_SUITE: SuiteRef = suiteRef('', '')

/** Whether `suite` names a suite in full: both its project and itself, as a request needs. */
export function isNamed(suite: SuiteRef): boolean {
  return suite.project !== '' && suite.suite !== ''
}

/** What names a suite: its name, and its project's (see `Suite` in suites.ts). */
interface Named {
  name: string
  project: { name: string }
}

/** The suite `ref` names among `suites`, if they hold it. */
export function findSuite<S extends Named>(
  suites: readonly S[] | undefined,
  ref: SuiteRef,
): S | undefined {
  return suites?.find((suite) => suite.name === ref.suite && suite.project.name === ref.project)
}

/**
 * The full name of `ref`: its project's name and its own, separated by a `/`, which neither
 * contains (D7). It stands for the suite where a single string must, such as in a dropdown's
 * values, a React key or a message naming a suite that does not exist.
 */
export function fullName(ref: SuiteRef): string {
  return `${ref.project}/${ref.suite}`
}

/**
 * The suite whose full name is `name` (see `fullName`), or `NO_SUITE` if `name` is no full name: a
 * suite that is in no list of suites.
 */
export function suiteOfFullName(name: string): SuiteRef {
  const parts = name.split('/')
  return parts.length === 2 ? suiteRef(parts[0], parts[1]) : NO_SUITE
}
