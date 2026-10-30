import type { components } from '../client/src/api/schema.d.ts'
import { KEYS, PROJECTS, seed } from '../tools/seed.ts'
import { adminToken, expect, json, test } from './fixtures.ts'

type Schemas = components['schemas']

test('the stack is seeded, and seeding it again writes nothing', async ({ request, baseURL }) => {
  const projects = await json<Schemas['ProjectList']>(request, '/api/projects')
  for (const project of PROJECTS) {
    const listed = projects.items.find((entry) => entry.name === project.name)
    expect(listed?.display_name).toBe(project.display_name ?? null)
    expect(listed?.suites.map((suite) => [suite.name, suite.display_name])).toEqual(
      project.suites.map((suite) => [suite.name, suite.display_name ?? null]).sort(),
    )
  }
  const keys = await json<Schemas['ApiKeyList']>(request, '/api/admin/api-keys', {
    Authorization: `Bearer ${adminToken()}`,
  })
  // By code point, as the API sorts them.
  const order = ({ project, suite }: { project: string; suite: string }) => `${project}\0${suite}`
  const byNames = (a: { project: string; suite: string }, b: { project: string; suite: string }) =>
    order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0
  for (const { name, scope, restricted_to, revoked } of KEYS) {
    const seeded = keys.items.filter((key) => key.name === name)
    expect(
      seeded.map((key) => [key.scope, key.restricted_to, key.is_active, key.last_used_at]),
    ).toEqual([
      // The API returns a key's suites sorted by their names, and null for an instance-wide key.
      [scope, restricted_to ? [...restricted_to].sort(byNames) : null, !revoked, null],
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
