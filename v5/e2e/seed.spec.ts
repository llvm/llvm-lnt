import { seed } from '../tools/seed.ts'
import { expect, test } from './fixtures.ts'

test('the stack is seeded, and seeding it again writes nothing', async ({ request, baseURL }) => {
  const suites = await (await request.get('/api/suites')).json()
  const names = suites.items.map((suite: { name: string }) => suite.name)
  expect(names).toEqual(expect.arrayContaining(['libcxx', 'nts']))

  // Writing needs the token, so a seed that asks for none cannot have written anything.
  const token = () => {
    throw new Error('Seeding again asked for a token')
  }
  expect(await seed({ url: baseURL!, token, log: () => {} })).toEqual({
    seeded: [],
    skipped: ['libcxx', 'nts'],
  })
})
