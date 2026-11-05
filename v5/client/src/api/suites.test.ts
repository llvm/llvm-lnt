import { describe, expect, it } from 'vitest'
import { HttpResponse } from 'msw'
import { QueryClient } from '@tanstack/react-query'
import type { Schemas } from './client'
import { queryKeys } from './keys'
import {
  addProject,
  addSuite,
  renameProject,
  renameSuite,
  reorderProjects,
  reorderSuites,
  suiteRef,
  updateProject,
  updateSuite,
  type SuiteSchema,
} from './suites'
import { SUITE } from '../test/fixtures'
import { mockApi } from '../test/mock-api'
import { gate } from '../test/page'
import { server } from '../test/server'

const schema = (name: string, display_name: string | null = null): SuiteSchema => ({
  ...SUITE,
  name,
  display_name,
})

const project = (name: string, suites: string[] = []): Schemas['Project'] => ({
  name,
  display_name: null,
  suites: suites.map((suite) => schema(suite)),
})

/** A query client caching the projects `projects`, in that order. */
function cached(projects: Schemas['Project'][]): QueryClient {
  const queryClient = new QueryClient()
  queryClient.setQueryData<Schemas['ProjectList']>(queryKeys.projects, { items: projects })
  return queryClient
}

/** The projects the cache lists, in order, each with its suites: `llvm: a b`. */
function listed(queryClient: QueryClient): string[] {
  const list = queryClient.getQueryData<Schemas['ProjectList']>(queryKeys.projects)!
  return list.items.map(({ name, suites }) =>
    [`${name}:`, ...suites.map((suite) => suite.name)].join(' '),
  )
}

// The order of the cached list is the order shown (AR22), so a write puts what it changed where the
// API now has it (D7).
describe('the cached list of projects, after a write', () => {
  const PROJECTS = [project('llvm', ['a', 'b', 'c']), project('libcxx', ['x']), project('swift')]

  it('keeps a suite whose schema changed in its place', async () => {
    const queryClient = cached(PROJECTS)
    await updateSuite(queryClient, 'llvm', schema('a', 'Changed'))
    expect(listed(queryClient)).toEqual(['llvm: a b c', 'libcxx: x', 'swift:'])
    const [llvm] = queryClient.getQueryData<Schemas['ProjectList']>(queryKeys.projects)!.items
    expect(llvm.suites[0].display_name).toBe('Changed')
  })

  it('adds a changed suite the list does not hold, and lists the projects again', async () => {
    const queryClient = cached(PROJECTS)
    await updateSuite(queryClient, 'llvm', schema('elsewhere'))
    expect(listed(queryClient)).toEqual(['llvm: a b c elsewhere', 'libcxx: x', 'swift:'])
    expect(queryClient.getQueryState(queryKeys.projects)?.isInvalidated).toBe(true)
  })

  it('keeps a suite renamed within its project in its place', async () => {
    const queryClient = cached(PROJECTS)
    await renameSuite(queryClient, suiteRef('llvm', 'a'), suiteRef('llvm', 'z'), schema('z'), {
      leaving: false,
    })
    expect(listed(queryClient)).toEqual(['llvm: z b c', 'libcxx: x', 'swift:'])
  })

  it('puts a suite moved to another project last there', async () => {
    const queryClient = cached(PROJECTS)
    await renameSuite(queryClient, suiteRef('libcxx', 'x'), suiteRef('llvm', 'x'), schema('x'), {
      leaving: false,
    })
    expect(listed(queryClient)).toEqual(['llvm: a b c x', 'libcxx:', 'swift:'])
  })

  it('puts a new suite last, in place of one of its name deleted elsewhere', async () => {
    const queryClient = cached(PROJECTS)
    await addSuite(queryClient, 'llvm', schema('a', 'New'))
    expect(listed(queryClient)).toEqual(['llvm: b c a', 'libcxx: x', 'swift:'])
  })

  it('keeps a project whose display name changed in its place', async () => {
    const queryClient = cached(PROJECTS)
    await updateProject(queryClient, { ...project('libcxx', ['x']), display_name: 'libc++' })
    expect(listed(queryClient)).toEqual(['llvm: a b c', 'libcxx: x', 'swift:'])
  })

  it('keeps a renamed project in its place', async () => {
    const queryClient = cached(PROJECTS)
    await renameProject(queryClient, 'llvm', project('clang', ['a', 'b', 'c']))
    expect(listed(queryClient)).toEqual(['clang: a b c', 'libcxx: x', 'swift:'])
  })

  it('puts a new project last, in place of one of its name deleted elsewhere', async () => {
    const queryClient = cached(PROJECTS)
    await addProject(queryClient, project('llvm'))
    expect(listed(queryClient)).toEqual(['libcxx: x', 'swift:', 'llvm:'])
  })

  it("puts a project's suites in the order a reorder returned", async () => {
    const queryClient = cached(PROJECTS)
    const reordered = ['c', 'a', 'b'].map((name) => schema(name))
    server.use(
      mockApi('patch', '/api/projects/{project}/suites', () =>
        HttpResponse.json({ items: reordered }),
      ),
    )

    await reorderSuites(queryClient, 'llvm', ['c', 'a', 'b'])

    expect(listed(queryClient)).toEqual(['llvm: c a b', 'libcxx: x', 'swift:'])
    expect(queryClient.getQueryState(queryKeys.projects)?.isInvalidated).toBe(false)
  })

  it("keeps a project's cached suites, rearranged, over an older response", async () => {
    // Renamed in the cache before the reorder's response, which still names `c`.
    const queryClient = cached([project('llvm', ['a', 'b', 'd']), ...PROJECTS.slice(1)])
    server.use(
      mockApi('patch', '/api/projects/{project}/suites', () =>
        HttpResponse.json({ items: ['c', 'b', 'a'].map((name) => schema(name)) }),
      ),
    )

    await reorderSuites(queryClient, 'llvm', ['c', 'b', 'a'])

    expect(listed(queryClient)).toEqual(['llvm: b a d', 'libcxx: x', 'swift:'])
    expect(queryClient.getQueryState(queryKeys.projects)?.isInvalidated).toBe(true)
  })

  it('lists the projects again once the suites of a project not listed are reordered', async () => {
    const queryClient = cached(PROJECTS)
    server.use(
      mockApi('patch', '/api/projects/{project}/suites', () =>
        HttpResponse.json({ items: [schema('n')] }),
      ),
    )

    await reorderSuites(queryClient, 'new', ['n'])

    expect(listed(queryClient)).toEqual(['llvm: a b c', 'libcxx: x', 'swift:'])
    expect(queryClient.getQueryState(queryKeys.projects)?.isInvalidated).toBe(true)
  })

  it('keeps the cached projects, rearranged, over an older response', async () => {
    // Renamed in the cache before the reorder's response, which still names `llvm`, and with a
    // display name the response does not have yet.
    const clang = { ...project('clang', ['a']), display_name: 'Clang' }
    const queryClient = cached([clang, ...PROJECTS.slice(1)])
    const reordered = [PROJECTS[2], PROJECTS[1], PROJECTS[0]]
    server.use(mockApi('patch', '/api/projects', () => HttpResponse.json({ items: reordered })))

    await reorderProjects(queryClient, ['swift', 'libcxx', 'llvm'])

    expect(listed(queryClient)).toEqual(['swift:', 'libcxx: x', 'clang: a'])
    const items = queryClient.getQueryData<Schemas['ProjectList']>(queryKeys.projects)!.items
    expect(items[2]).toEqual(clang)
    expect(queryClient.getQueryState(queryKeys.projects)?.isInvalidated).toBe(true)
  })

  it('leaves the cached projects as they are once a reorder names the same', async () => {
    const queryClient = cached(PROJECTS)
    const reordered = [PROJECTS[1], PROJECTS[0], PROJECTS[2]]
    server.use(mockApi('patch', '/api/projects', () => HttpResponse.json({ items: reordered })))

    await reorderProjects(queryClient, ['libcxx', 'llvm', 'swift'])

    expect(listed(queryClient)).toEqual(['libcxx: x', 'llvm: a b c', 'swift:'])
    expect(queryClient.getQueryState(queryKeys.projects)?.isInvalidated).toBe(false)
  })

  it('puts the projects in the order a reorder returned, over a list on its way', async () => {
    const queryClient = cached(PROJECTS)
    const reordered = [PROJECTS[2], PROJECTS[0], PROJECTS[1]]
    server.use(mockApi('patch', '/api/projects', () => HttpResponse.json({ items: reordered })))
    // A list fetched before the reorder, which holds the old order, arrives after it.
    const fetched = gate()
    const fetching = queryClient
      .fetchQuery({
        queryKey: queryKeys.projects,
        queryFn: async () => {
          await fetched.promise
          return { items: PROJECTS }
        },
      })
      .catch(() => undefined)

    await reorderProjects(queryClient, ['swift', 'llvm', 'libcxx'])
    fetched.open()
    await fetching

    expect(listed(queryClient)).toEqual(['swift:', 'llvm: a b c', 'libcxx: x'])
  })
})
