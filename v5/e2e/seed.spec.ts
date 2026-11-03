import type { components } from '../client/src/api/schema.d.ts'
import { KEYS, PROJECTS, seed } from '../tools/seed.ts'
import { adminToken, expect, json, test } from './fixtures.ts'

type Schemas = components['schemas']

/** An entry of a key's restriction: a whole project, with a null `suite`, or a single suite. */
type Ref = Schemas['RestrictionEntry']

/** By code point, compared explicitly, rather than in the order the API happens to list. */
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const byName = (a: { name: string }, b: { name: string }) => byCodePoint(a.name, b.name)
const byNames = (a: Ref, b: Ref) =>
  byCodePoint(a.project, b.project) || byCodePoint(a.suite ?? '', b.suite ?? '')

test('the stack is seeded, and seeding it again writes nothing', async ({ request, baseURL }) => {
  const projects = await json<Schemas['ProjectList']>(request, '/api/projects')
  for (const project of PROJECTS) {
    const listed = projects.items.find((entry) => entry.name === project.name)
    expect(listed?.display_name).toBe(project.display_name ?? null)
    const names = (suites: { name: string; display_name?: string | null }[]) =>
      [...suites].sort(byName).map((suite) => [suite.name, suite.display_name ?? null])
    expect(names(listed?.suites ?? [])).toEqual(names(project.suites))
  }
  const keys = await json<Schemas['ApiKeyList']>(request, '/api/admin/api-keys', {
    Authorization: `Bearer ${adminToken()}`,
  })
  const sorted = (entries: readonly Ref[] | null | undefined) =>
    entries ? [...entries].sort(byNames) : null
  for (const { name, scope, restricted_to, revoked } of KEYS) {
    const seeded = keys.items.filter((key) => key.name === name)
    expect(
      seeded.map((key) => [key.scope, sorted(key.restricted_to), key.is_active, key.last_used_at]),
    ).toEqual([
      // Null for an instance-wide key.
      [scope, sorted(restricted_to), !revoked, null],
    ])
  }

  // Writing needs the token, so a seed that asks for none cannot have written anything.
  const token = () => {
    throw new Error('Seeding again asked for a token')
  }
  expect(await seed({ url: baseURL!, token, log: () => {} })).toEqual({
    created: [],
    seeded: [],
    skipped: ['libcxx/benchmarks', 'libcxx/header-sizes', 'llvm/nts'],
  })
})
