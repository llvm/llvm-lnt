/**
 * The Compare page (CP1-CP7), against the seeded libcxx history: the real machines measured every
 * synthetic commit, three samples per test and run.
 */

import type { APIRequestContext } from '@playwright/test'
import type { components } from '../client/src/api/schema.d.ts'
import { LINUX } from '../tools/synthetic.ts'
import { expect, json, test } from './fixtures.ts'
import { pickOption } from './select.ts'
import { plotOf, type PlotDiv } from './plot.ts'
import { column, rows, table } from './tables.ts'

type Schemas = components['schemas']

/** The two newest commits LINUX has runs at, by ordinal: the older first. */
async function newestCommits(request: APIRequestContext) {
  const path = `/api/suites/libcxx/commits?machine=${LINUX}&sort=-ordinal&limit=2`
  const { items } = await json<Schemas['CommitCursorPage']>(request, path)
  return [items[1], items[0]]
}

test('compares the runs of two commits the URL names', async ({ page, request }) => {
  const [older, newer] = await newestCommits(request)
  await page.goto(
    `/compare?suite_a=libcxx&machine_a=${LINUX}&commit_a=${older.value}` +
      `&suite_b=libcxx&machine_b=${LINUX}&commit_b=${newer.value}&metric=execution_time`,
  )

  const comparison = table(page, 'Comparison')
  await expect(rows(comparison).first()).toContainText('Geomean')
  expect(await rows(comparison).count()).toBeGreaterThan(10)
  // Every test has a value on both sides, so each has a status other than N/A.
  const statuses = await column(comparison, 6)
  expect(statuses.slice(1).every((status) => status !== 'N/A')).toBe(true)
  await expect(page.getByRole('list', { name: 'Summary' })).toContainText('Only in A 0')
  // A bar per compared test.
  const drawn = () =>
    plotOf(page).evaluate((element) => (element as PlotDiv)._fullData?.[0]?.y.length ?? 0)
  await expect.poll(drawn).toBe((await rows(comparison).count()) - 1)
})

test('compares two commits chosen from scratch', async ({ page, request }) => {
  const [older, newer] = await newestCommits(request)
  await page.goto('/compare')

  for (const [side, commit] of [
    ['A', older],
    ['B', newer],
  ] as const) {
    await pickOption(page, `Suite ${side}`, 'libcxx')
    const machine = page.getByRole('combobox', { name: `Machine ${side}` })
    await machine.fill(LINUX)
    await page.getByRole('option', { name: LINUX, exact: true }).click()
    // The commit is searched by its commit string, and suggested by its display value.
    await page.getByRole('combobox', { name: `Commit ${side}` }).fill(commit.value)
    const display = String(commit.fields.svn_revision)
    await page.getByRole('option', { name: display, exact: true }).click()
  }
  await pickOption(page, 'Metric', 'Execution Time')

  await expect(rows(table(page, 'Comparison')).first()).toContainText('Geomean')
  await expect(page).toHaveURL(new RegExp(`commit_a=${older.value}.*commit_b=${newer.value}`))
})
