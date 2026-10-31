import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query'
import { api, ApiError, unwrap, type Schemas } from './client'
import { compareProjects, compareSuites, fullLabelOf } from '../labels'
import { forgetSuite, queryKeys } from './keys'
import { suiteRef, type SuiteRef } from './suite-ref'

export {
  findSuite,
  isNamed,
  NO_SUITE,
  fullName,
  suiteOfFullName,
  suiteRef,
  type SuiteRef,
} from './suite-ref'

export type SuiteSchema = Schemas['SuiteSchema']

/** A project, by what names it (D7). */
export type ProjectName = Pick<Schemas['Project'], 'name' | 'display_name'>

/** A suite as the UI holds it: its schema, as the API returns it, and its project. */
export type Suite = SuiteSchema & { project: ProjectName }

/** A project, with its suites, each in AR22's order. */
export interface Project extends ProjectName {
  suites: Suite[]
}

/** The identity of `suite` (see `suiteRef`). */
export function refOf(suite: Pick<Suite, 'name' | 'project'>): SuiteRef {
  return suiteRef(suite.project.name, suite.name)
}

/** The schema of `suite`, exactly as the API returns it: without the project the UI adds. */
export function schemaOf(suite: Suite): SuiteSchema {
  const { project, ...schema } = suite
  void project
  return schema
}

// What the list of projects the API returned is put in order as, once per list rather than once
// per component reading it, so that every reader shares the same objects.
const ordered = new WeakMap<Schemas['ProjectList'], { projects: Project[]; suites: Suite[] }>()

function inOrder(list: Schemas['ProjectList']) {
  let result = ordered.get(list)
  if (result === undefined) {
    const projects = list.items
      .map(({ name, display_name, suites }) => {
        const project = { name, display_name }
        const held = suites.map((schema) => ({ ...schema, project }))
        return { ...project, suites: held.sort(compareSuites) }
      })
      .sort(compareProjects)
    result = { projects, suites: projects.flatMap((project) => project.suites) }
    ordered.set(list, result)
  }
  return result
}

/** The projects of the list the API returned, and their suites, in AR22's order. */
const projectsInOrder = (list: Schemas['ProjectList']): Project[] => inOrder(list).projects

/** Every suite of the list the API returned, in AR22's order. */
const suitesInOrder = (list: Schemas['ProjectList']): Suite[] => inOrder(list).suites

const projectsQuery = queryOptions({
  queryKey: queryKeys.projects,
  queryFn: ({ signal }) => unwrap(api.GET('/api/projects', { signal })),
})

/**
 * The projects of the instance, with their suites and the suites' schemas, in the order the UI
 * lists them (AR22). Projects and suites are few, and the list carries every schema, so pages read
 * a suite's schema from it rather than fetching it on its own.
 */
export function useProjects() {
  return useQuery({ ...projectsQuery, select: projectsInOrder })
}

/** Every suite of the instance, with its schema and its project, in AR22's order. */
export function useSuites() {
  return useQuery({ ...projectsQuery, select: suitesInOrder })
}

/**
 * The suites as far as they have been listed already, without listing them: for what names a suite
 * by its label (AR22) without needing the list otherwise, which names it by its names until then.
 * It deliberately never fetches the list, which AR22 allows ("including until its display name is
 * known"), so that a gated control or the Settings panel costs no request of its own.
 */
export function useKnownSuites(): Suite[] | undefined {
  return useQuery({ ...projectsQuery, select: suitesInOrder, enabled: false }).data
}

/** The projects as far as they have been listed already, without listing them (see above). */
export function useKnownProjects(): Project[] | undefined {
  return useQuery({ ...projectsQuery, select: projectsInOrder, enabled: false }).data
}

/** The full label of the suite `ref` names (AR22), or its names until the suites are listed. */
export function useSuiteLabel(ref: SuiteRef): string {
  return fullLabelOf(useKnownSuites(), ref)
}

/** Fetch the list of projects again, after a write that found it out of date. */
export function refetchProjects(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.projects, exact: true })
}

type ProjectItems = Schemas['ProjectList']['items']

/**
 * Change the cached list of projects with `edit`, after a write, once a list on its way, which may
 * not hold the change, is cancelled. That list is asked for again, since it may have held more than
 * the cache does, such as a suite created elsewhere, and so is a list that `edit` finds `outdated`,
 * or that is not cached.
 */
async function editProjects(
  queryClient: QueryClient,
  edit: (items: ProjectItems) => { items: ProjectItems; outdated: boolean },
): Promise<void> {
  const fetching = queryClient.isFetching({ queryKey: queryKeys.projects, exact: true }) > 0
  await queryClient.cancelQueries({ queryKey: queryKeys.projects, exact: true })
  let outdated = true
  queryClient.setQueryData<Schemas['ProjectList']>(queryKeys.projects, (list) => {
    if (list === undefined) return list
    const edited = edit(list.items)
    outdated = edited.outdated
    return { items: edited.items }
  })
  if (fetching || outdated) refetchProjects(queryClient)
}

/**
 * Fetch the list of projects again if `error`, a write's failure, says that it is out of date: that
 * what the write named was deleted elsewhere, or that a name it gave was taken there. The list then
 * shows it gone, or the name check says so.
 */
export function refetchProjectsIfOutdated(queryClient: QueryClient, error: unknown): void {
  if (error instanceof ApiError && (error.code === 'not_found' || error.code === 'duplicate')) {
    refetchProjects(queryClient)
  }
}

/**
 * Put `schema`, as the API returned it after a write, in the list of projects, as a suite of the
 * project `project`: in place of the suite's schema, or as a new suite of the project, once the
 * suite `from`, if given, is taken out of its project (see `editProjects`). A list that does not
 * hold the project, created elsewhere since it was fetched, is asked for again.
 */
async function putSuite(
  queryClient: QueryClient,
  project: string,
  schema: SuiteSchema,
  from?: SuiteRef,
): Promise<void> {
  await editProjects(queryClient, (list) => {
    let found = false
    const items = list.map((entry) => {
      let suites = entry.suites
      if (entry.name === from?.project) {
        suites = suites.filter((suite) => suite.name !== from.suite)
      }
      if (entry.name === project) {
        found = true
        suites = [...suites.filter((suite) => suite.name !== schema.name), schema]
      }
      return suites === entry.suites ? entry : { ...entry, suites }
    })
    return { items, outdated: !found }
  })
}

/**
 * Forget the list of API keys, which names the projects and suites the keys list by their current
 * names (E11), and no longer lists what was deleted (I5).
 */
function forgetApiKeys(queryClient: QueryClient): void {
  queryClient.removeQueries({ queryKey: queryKeys.apiKeys, type: 'inactive' })
  void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys })
}

/**
 * Add the created `schema` to the project `project` in the list of projects, and drop everything
 * read from inside an earlier suite of the same names, deleted elsewhere, so that the new one starts
 * afresh.
 */
export async function addSuite(
  queryClient: QueryClient,
  project: string,
  schema: SuiteSchema,
): Promise<void> {
  await putSuite(queryClient, project, schema)
  queryClient.removeQueries({ queryKey: queryKeys.suite({ project, suite: schema.name }) })
}

/**
 * Put the changed `schema` of a suite of the project `project` in the list of projects, and forget
 * what was read from inside the suite, whose fields or metrics may have changed.
 */
export async function updateSuite(
  queryClient: QueryClient,
  project: string,
  schema: SuiteSchema,
): Promise<void> {
  await putSuite(queryClient, project, schema)
  await forgetSuite(queryClient, { project, suite: schema.name }, { leaving: false })
}

/**
 * Put the suite `from`, renamed or moved to `to` (D7), in the list of projects, with the `schema` the
 * API returned: out of its old project, and into its new one (see `putSuite`). Everything read from
 * inside an earlier suite of the new names, deleted elsewhere, is dropped, so that the suite starts
 * afresh there, and what was read under the old names is forgotten, so that it is never shown for
 * whatever later takes them (AR16): see `forgetSuite`, and `forgetUnobserved` once the page has left
 * them. The list of API keys goes too, since it names the suite and the projects by their names.
 *
 * Nothing it waits for, once the list is changed, is a request, so that the page can leave the old
 * names before it shows them as gone.
 */
export async function renameSuite(
  queryClient: QueryClient,
  from: SuiteRef,
  to: SuiteRef,
  schema: SuiteSchema,
  { leaving }: { leaving: boolean },
): Promise<void> {
  await putSuite(queryClient, to.project, schema, from)
  queryClient.removeQueries({ queryKey: queryKeys.suite(to) })
  void forgetSuite(queryClient, from, { leaving })
  forgetApiKeys(queryClient)
}

/**
 * Forget the deleted `suite`: drop it from the cached list of projects, once a list on its way,
 * which may still hold it, is cancelled (see `editProjects`), and drop everything read from inside
 * it, so that a suite created later under the same names starts afresh. The list of API keys goes
 * too, since the suite is gone from the keys restricted to it (I5), which would otherwise still
 * show it.
 */
export async function removeSuite(queryClient: QueryClient, suite: SuiteRef): Promise<void> {
  await editProjects(queryClient, (list) => ({
    items: list.map((entry) =>
      entry.name === suite.project
        ? { ...entry, suites: entry.suites.filter((schema) => schema.name !== suite.suite) }
        : entry,
    ),
    outdated: false,
  }))
  queryClient.removeQueries({ queryKey: queryKeys.suite(suite) })
  forgetApiKeys(queryClient)
}

/** A project as the API returns it, with its suites' schemas (E13). */
type ProjectSchema = Schemas['Project']

/**
 * Put `project`, as the API returned it after a write, in the list of projects: in place of the
 * project `from`, its old name, or as a new project without `from` (see `editProjects`). An entry
 * already under its name, a project deleted elsewhere since the list was fetched, goes. A list that
 * does not hold `from`, deleted elsewhere since it was fetched, is asked for again.
 */
async function putProject(
  queryClient: QueryClient,
  project: ProjectSchema,
  from?: string,
): Promise<void> {
  await editProjects(queryClient, (list) => ({
    items: [...list.filter((entry) => entry.name !== project.name && entry.name !== from), project],
    outdated: from !== undefined && !list.some((entry) => entry.name === from),
  }))
}

/**
 * Add the created `project` to the list of projects, and drop everything read from inside the
 * suites of an earlier project of the same name, deleted elsewhere, so that the new one starts
 * afresh.
 */
export async function addProject(queryClient: QueryClient, project: ProjectSchema): Promise<void> {
  await putProject(queryClient, project)
  queryClient.removeQueries({ queryKey: queryKeys.projectSuites(project.name) })
}

/** Put `project`, whose display name changed, in the list of projects. */
export async function updateProject(
  queryClient: QueryClient,
  project: ProjectSchema,
): Promise<void> {
  await putProject(queryClient, project, project.name)
}

/**
 * Put the project `from`, renamed (D7), in the list of projects, as the API returned it, and drop
 * everything read from inside its suites under the old name, so that it is never shown for whatever
 * later takes that name (AR16), and from inside the suites of an earlier project of the new name,
 * deleted elsewhere. Dropping them outright is safe: every page of a suite reads the suite from the
 * list of projects, so once the list holds the new name, a page still under the old one says that
 * the suite was not found, and stops reading from it. The list of API keys goes too, since it names
 * the projects and suites the keys list by their names.
 */
export async function renameProject(
  queryClient: QueryClient,
  from: string,
  project: ProjectSchema,
): Promise<void> {
  await putProject(queryClient, project, from)
  queryClient.removeQueries({ queryKey: queryKeys.projectSuites(from) })
  queryClient.removeQueries({ queryKey: queryKeys.projectSuites(project.name) })
  forgetApiKeys(queryClient)
}

/**
 * Forget the deleted project `name`: drop it from the cached list of projects, once a list on its
 * way, which may still hold it, is cancelled (see `editProjects`). The list of API keys goes too,
 * since the project is gone from the keys that listed it (I5), which would otherwise still show it.
 */
export async function removeProject(queryClient: QueryClient, name: string): Promise<void> {
  await editProjects(queryClient, (list) => ({
    items: list.filter((entry) => entry.name !== name),
    outdated: false,
  }))
  forgetApiKeys(queryClient)
}
