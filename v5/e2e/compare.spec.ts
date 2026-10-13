/**
 * The Compare page (CP1-CP7), against the seeded libcxx history: the real machines measured every
 * synthetic commit, three samples per test and run.
 */

import type { APIRequestContext, Page } from '@playwright/test'
import type { components } from '../client/src/api/schema.d.ts'
import { EXPERIMENT, LINUX, PROFILED_TEST } from '../tools/synthetic.ts'
import { expect, json, test } from './fixtures.ts'
import { pickOption } from './select.ts'
import { plotOf, type PlotDiv } from './plot.ts'
import { column, rows, table } from './tables.ts'

type Schemas = components['schemas']

/** The controls of `side`, whose fields are named without it: "Suite", "Machine", "Commit". */
function sideOf(page: Page, side: 'A' | 'B') {
  return page.getByRole('region', { name: new RegExp(`^Side ${side} `) })
}

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
  // Every test has a value on both sides, so each has a status other than N/A. Status is the
  // column after the checkboxes and the six others.
  const statuses = await column(comparison, 7)
  const comparable = ['Improved', 'Regressed', 'Noise', 'Unchanged']
  expect(statuses.slice(1).every((status) => comparable.includes(status))).toBe(true)
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
    const controls = sideOf(page, side)
    await pickOption(controls, 'Suite', 'libcxx')
    const machine = controls.getByRole('combobox', { name: 'Machine' })
    await machine.fill(LINUX)
    await page.getByRole('option', { name: LINUX, exact: true }).click()
    // The commit is searched by its commit string, and suggested by its display value.
    await controls.getByRole('combobox', { name: 'Commit' }).fill(commit.value)
    const display = String(commit.fields.svn_revision)
    await page.getByRole('option', { name: display, exact: true }).click()
  }
  await pickOption(page, 'Metric', 'Execution Time')

  await expect(rows(table(page, 'Comparison')).first()).toContainText('Geomean')
  await expect(page).toHaveURL(new RegExp(`commit_a=${older.value}.*commit_b=${newer.value}`))
})

test('links a test to its profile on both sides', async ({ page, request }) => {
  const [, newest] = await newestCommits(request)
  // The run of LINUX at `commit` that has profiles: there is one at each of these commits.
  const profiledRun = async (commit: string) => {
    const path = `/api/suites/libcxx/runs?machine=${LINUX}&commit=${commit}&has_profiles=true`
    return (await json<Schemas['RunCursorPage']>(request, path)).items[0].uuid
  }
  const [runA, runB] = [await profiledRun(newest.value), await profiledRun(EXPERIMENT)]
  const query = new URLSearchParams({
    suite_a: 'libcxx',
    machine_a: LINUX,
    commit_a: newest.value,
    suite_b: 'libcxx',
    machine_b: LINUX,
    commit_b: EXPERIMENT,
    metric: 'execution_time',
    test_filter: PROFILED_TEST,
  })
  await page.goto(`/compare?${query}`)

  const row = rows(table(page, 'Comparison')).filter({ hasText: PROFILED_TEST }).first()
  const profiles = new URLSearchParams({
    suite_a: 'libcxx',
    run_a: runA,
    test_a: PROFILED_TEST,
    suite_b: 'libcxx',
    run_b: runB,
    test_b: PROFILED_TEST,
  })
  await expect(row.getByRole('link', { name: 'Profile' })).toHaveAttribute(
    'href',
    `/profiles?${profiles}`,
  )
})
