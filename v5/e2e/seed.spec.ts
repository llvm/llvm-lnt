import type { components } from '../client/src/api/schema.d.ts'
import { KEYS, seed } from '../tools/seed.ts'
import { adminToken, expect, json, test } from './fixtures.ts'

test('the stack is seeded, and seeding it again writes nothing', async ({ request, baseURL }) => {
  const suites = await (await request.get('/api/suites')).json()
  const names = suites.items.map((suite: { name: string }) => suite.name)
  expect(names).toEqual(expect.arrayContaining(['libcxx', 'nts']))
  const keys = await json<components['schemas']['ApiKeyList']>(request, '/api/admin/api-keys', {
    Authorization: `Bearer ${adminToken()}`,
  })
  for (const { name, scope, revoked } of KEYS) {
    const seeded = keys.items.filter((key) => key.name === name)
    expect(seeded.map((key) => [key.scope, key.is_active, key.last_used_at])).toEqual([
      [scope, !revoked, null],
    ])
  }

  // Writing needs the token, so a seed that asks for none cannot have written anything.
  const token = () => {
    throw new Error('Seeding again asked for a token')
  }
  expect(await seed({ url: baseURL!, token, log: () => {} })).toEqual({
    seeded: [],
    skipped: ['libcxx', 'nts'],
  })
})
