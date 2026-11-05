import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query'
import { api, ApiError, authedApi, unwrap, type Schemas } from './client'
import { fullLabelOf } from '../labels'
import { arrangeBy } from '../order'
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

// What the list of projects the API returned becomes, once per list rather than once per component
// reading it, so that every reader shares the same objects.
const derived = new WeakMap<Schemas['ProjectList'], { projects: Project[]; suites: Suite[] }>()

function derive(list: Schemas['ProjectList']) {
  let result = derived.get(list)
  if (result === undefined) {
    const projects = list.items.map(({ name, display_name, suites }) => {
      const project = { name, display_name }
      return { ...project, suites: suites.map((schema) => ({ ...schema, project })) }
    })
    result = { projects, suites: projects.flatMap((project) => project.suites) }
    derived.set(list, result)
  }
  return result
}

/** The projects of the list the API returned, and their suites, in its order, AR22's. */
const projectsOf = (list: Schemas['ProjectList']): Project[] => derive(list).projects

/** Every suite of the list the API returned, in AR22's order. */
const suitesOf = (list: Schemas['ProjectList']): Suite[] => derive(list).suites

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
  return useQuery({ ...projectsQuery, select: projectsOf })
}

/** Every suite of the instance, with its schema and its project, in AR22's order. */
export function useSuites() {
  return useQuery({ ...projectsQuery, select: suitesOf })
}

/**
 * The projects as far as they have been listed already, without listing them: for what names a
 * project or a suite by its label (AR22) without needing the list otherwise, which names it by its
 * names until then. It deliberately never fetches the list, which AR22 allows ("including until its
 * display name is known"), so that a gated control or the Settings panel costs no request of its
 * own.
 */
export function useKnownProjects(): Project[] | undefined {
  return useQuery({ ...projectsQuery, select: projectsOf, enabled: false }).data
}

/**
 * The full label of the suite `ref` names (AR22), or its names until the suites are listed, which
 * this does not do (see `useKnownProjects`).
 */
export function useSuiteLabel(ref: SuiteRef): string {
  return fullLabelOf(useQuery({ ...projectsQuery, select: suitesOf, enabled: false }).data, ref)
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
  refetchProjectsOn(queryClient, error, ['not_found', 'duplicate'])
}

/** Fetch the list of projects again if `error` is a failure of the API with one of `codes`. */
function refetchProjectsOn(queryClient: QueryClient, error: unknown, codes: string[]): void {
  if (error instanceof ApiError && error.code !== null && codes.includes(error.code)) {
    refetchProjects(queryClient)
  }
}

/**
 * `items` with `item` in place of the entry named `replaced`, if they hold it, and otherwise last,
 * along with whether it took that place. An entry already under its name, deleted elsewhere, goes.
 */
function putInPlace<Item extends { name: string }>(
  items: readonly Item[],
  item: Item,
  replaced: string | undefined,
): { items: Item[]; placed: boolean } {
  const placed = replaced !== undefined && items.some((entry) => entry.name === replaced)
  const put = items.flatMap((entry) =>
    entry.name === replaced ? [item] : entry.name === item.name ? [] : [entry],
  )
  return { items: placed ? put : [...put, item], placed }
}

/**
 * Put `schema`, as the API returned it after a write, in the list of projects, as a suite of the
 * project `project` (see `editProjects`). `from` is the suite as it was named before the write, if
 * it existed: within the same project, the suite keeps its place, under its new name if renamed.
 * Otherwise, created or moved there, it goes last in the project (D7), once taken out of its old
 * project, and once an entry already under its name, deleted elsewhere, goes. A list that does not
 * hold the project, created elsewhere since it was fetched, or the suite, is asked for again.
 */
async function putSuite(
  queryClient: QueryClient,
  project: string,
  schema: SuiteSchema,
  from?: SuiteRef,
): Promise<void> {
  // The name of the entry the suite takes the place of.
  const replaced = from?.project === project ? from.suite : undefined
  await editProjects(queryClient, (list) => {
    let found = false
    let outdated = false
    const items = list.map((entry) => {
      let suites = entry.suites
      if (entry.name === from?.project && replaced === undefined) {
        suites = suites.filter((suite) => suite.name !== from.suite)
      }
      if (entry.name === project) {
        found = true
        const put = putInPlace(suites, schema, replaced)
        outdated = replaced !== undefined && !put.placed
        suites = put.items
      }
      return suites === entry.suites ? entry : { ...entry, suites }
    })
    return { items, outdated: outdated || !found }
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
  const suite = suiteRef(project, schema.name)
  await putSuite(queryClient, project, schema, suite)
  await forgetSuite(queryClient, suite, { leaving: false })
}

/**
 * Put the suite `from`, renamed or moved to `to` (D7), in the list of projects, with the `schema` the
 * API returned: in its place when renamed within its project, and otherwise out of its old project,
 * and last in its new one (see `putSuite`). Everything read from
 * inside an earlier suite of the new names, deleted elsewhere, is dropped, so that the suite starts
 * afresh there, and what was read under the old names is forgotten, so that it is never shown for
 * whatever later takes them: see `forgetSuite`, and `forgetUnobserved` once the page has left
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
 * project `from`, its old name, or last, as a new project without `from` (D7; see `editProjects`).
 * An entry already under its name, a project deleted elsewhere since the list was fetched, goes. A
 * list that does not hold `from`, deleted elsewhere since it was fetched, is asked for again.
 */
async function putProject(
  queryClient: QueryClient,
  project: ProjectSchema,
  from?: string,
): Promise<void> {
  await editProjects(queryClient, (list) => {
    const { items, placed } = putInPlace(list, project, from)
    return { items, outdated: from !== undefined && !placed }
  })
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
 * later takes that name, and from inside the suites of an earlier project of the new name,
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

/**
 * Send the new order `saving` sends (E10, E13), and return what the API returned. A failure that
 * says that the order was out of date (AR24), as it did not name what the API holds, or as the
 * project was deleted elsewhere, has the list of projects fetched again. Any other, such as one to
 * retry, leaves the list as it is.
 */
async function saveOrder<T>(queryClient: QueryClient, saving: Promise<T>): Promise<T> {
  try {
    return await saving
  } catch (failure) {
    refetchProjectsOn(queryClient, failure, ['invalid_request', 'not_found'])
    throw failure
  }
}

const nameOf = (entry: { name: string }) => entry.name

/**
 * Put the projects in the order `order`, the name of every project (E13), and the cached projects
 * in the order the API returned, once a list on its way, which may still have the old order, is
 * cancelled (see `editProjects`). The cached entries are kept, rather than replaced by the
 * response, which may be older than a write that landed in the cache before it, such as a rename:
 * a list that holds other names than the response is asked for again.
 */
export async function reorderProjects(queryClient: QueryClient, order: string[]): Promise<void> {
  const reordered = await saveOrder(
    queryClient,
    unwrap(authedApi.PATCH('/api/projects', { body: { order } })),
  )
  const names = reordered.items.map(nameOf)
  await editProjects(queryClient, (list) => arrangeBy(list, names, nameOf))
}

/**
 * Put the suites of the project `project` in the order `order`, the name of each of them (E10), and
 * its cached suites in the order the API returned (see `reorderProjects`). A list that does not
 * hold the project, created elsewhere since it was fetched, is asked for again.
 */
export async function reorderSuites(
  queryClient: QueryClient,
  project: string,
  order: string[],
): Promise<void> {
  const params = { path: { project } }
  const reordered = await saveOrder(
    queryClient,
    unwrap(authedApi.PATCH('/api/projects/{project}/suites', { params, body: { order } })),
  )
  const names = reordered.items.map(nameOf)
  await editProjects(queryClient, (list) => {
    let outdated = !list.some((entry) => entry.name === project)
    const items = list.map((entry) => {
      if (entry.name !== project) return entry
      const arranged = arrangeBy(entry.suites, names, nameOf)
      outdated = arranged.outdated
      return { ...entry, suites: arranged.items }
    })
    return { items, outdated }
  })
}
