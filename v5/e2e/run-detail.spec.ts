/**
 * The Run Detail page (DT2).
 *
 * Reading tests use the seeded libcxx suite. Tests that write use a suite of their own (see
 * own-suite.ts).
 */

import type { Page } from '@playwright/test'
import type { components } from '../client/src/api/schema.d.ts'
import { EXPERIMENT, LINUX, MACOS, PROFILED_TEST } from '../tools/synthetic.ts'
import { expect, json, REAL_RUN, test } from './fixtures.ts'
import { ownSuite } from './own-suite.ts'
import { pickOption } from './select.ts'
import { column, rows, settled, table } from './tables.ts'

type Schemas = components['schemas']

/** The query of the page's link named `name`, as an object. */
async function linkQuery(page: Page, name: string) {
  const link = page.getByRole('main').getByRole('link', { name, exact: true })
  await expect(link).toHaveAttribute('href', /^\/compare\?/)
  return Object.fromEntries(new URL((await link.getAttribute('href'))!, 'http://x').searchParams)
}

/** The UUID of the newest run that `query` selects. */
async function newestRun(request: Parameters<typeof json>[0], query: string) {
  const runs = await json<Schemas['RunCursorPage']>(
    request,
    `/api/suites/libcxx/runs?${query}&sort=-submitted_at&limit=1`,
  )
  return runs.items[0].uuid
}

test('shows the run, and its samples sorted and filtered by test name', async ({ page }) => {
  await page.goto(`/suites/libcxx/runs/${REAL_RUN}`)

  const info = page.getByRole('group', { name: 'Run', exact: true })
  await expect(info).toContainText(LINUX)
  await expect(info).toContainText('r552558')
  await expect(info).toContainText('start_time')
  await expect(page.getByRole('button', { name: 'Execution Time Metric' })).toBeVisible()
  const samples = table(page, 'Samples')
  await expect(page.getByText('25 samples', { exact: true })).toBeVisible()
  await expect(rows(samples)).toHaveCount(25)
  await expect(rows(samples).last()).toContainText('std::vprint_unicode("Hello,_World!")')

  const filter = page.getByRole('searchbox', { name: 'Filter tests' })
  await filter.fill('std::format')
  await expect(page.getByText('2 of 25 samples matching')).toBeVisible()
  expect(await column(samples, 0)).toEqual([
    'std::format(double)_(value:_-inf,_fmt:_{:0^17500_0})',
    'std::format(float)_(value:_random,_fmt:_{:0^17500_0L})',
  ])

  await filter.fill('bm_from_sys/')
  await expect(rows(samples)).toHaveCount(2)
  await expect(page).toHaveURL(
    `/suites/libcxx/runs/${REAL_RUN}?test_filter=${encodeURIComponent('bm_from_sys/')}`,
  )
})

test('keeps the metric in the URL, and passes it on to the comparisons', async ({ page }) => {
  await page.goto(`/suites/libcxx/runs/${REAL_RUN}`)

  await pickOption(page, 'Metric', 'Instructions Retired')

  await expect(page).toHaveURL(`/suites/libcxx/runs/${REAL_RUN}?metric=instructions`)
  await expect(table(page, 'Samples').getByRole('columnheader').nth(1)).toHaveText(
    'Instructions Retired',
  )
  expect(await linkQuery(page, 'Compare with...')).toEqual({
    suite_a: 'libcxx',
    machine_a: LINUX,
    commit_a: '53a4e4a77bd70731320bfa82ddbe6f88ee30ea6f',
    runs_a: REAL_RUN,
    metric: 'instructions',
  })
})

test('links to the profile of a test that has one', async ({ page, request }) => {
  const uuid = await newestRun(request, `machine=${MACOS}&has_profiles=true`)
  await page.goto(`/suites/libcxx/runs/${uuid}`)

  await page.getByRole('searchbox', { name: 'Filter tests' }).fill(PROFILED_TEST)
  const row = rows(table(page, 'Samples')).filter({ hasText: PROFILED_TEST }).first()
  await expect(row.getByRole('link', { name: 'Profile' })).toHaveAttribute(
    'href',
    `/profiles?${new URLSearchParams({ suite_a: 'libcxx', run_a: uuid, test_a: PROFILED_TEST })}`,
  )
})

test('compares the run with the commit before it on its machine', async ({ page, request }) => {
  // The machine's newest commit, and the one before it at which it has runs.
  const commits = await json<Schemas['CommitCursorPage']>(
    request,
    `/api/suites/libcxx/commits?machine=${MACOS}&sort=-ordinal&limit=2`,
  )
  const [newest, previous] = commits.items
  const uuid = await newestRun(request, `machine=${MACOS}&commit=${newest.value}`)
  await page.goto(`/suites/libcxx/runs/${uuid}`)

  expect(await linkQuery(page, 'Compare with previous commit')).toEqual({
    suite_a: 'libcxx',
    machine_a: MACOS,
    commit_a: previous.value,
    suite_b: 'libcxx',
    machine_b: MACOS,
    commit_b: newest.value,
    runs_b: uuid,
    metric: 'execution_time',
  })
})

test('cannot compare with a previous commit when the run’s commit has no ordinal', async ({
  page,
  request,
}) => {
  await page.goto(`/suites/libcxx/runs/${await newestRun(request, `commit=${EXPERIMENT}`)}`)

  const link = page.getByRole('main').getByRole('link', { name: 'Compare with previous commit' })
  await expect(link).toHaveAttribute('aria-disabled', 'true')
  await expect(link).toHaveAttribute('title', /no ordinal/)
})

test('deleting the run shows its machine', async ({ page, request, tokenFor, signIn }, testInfo) => {
  const run = (commit: string, ordinal: number) => ({
    machine: 'm1',
    commit,
    ordinal,
    tests: [{ name: 'bench', execution_time: [1, 2] }],
  })
  await ownSuite(request, tokenFor, testInfo, [run('c1', 1), run('c2', 2)], async (suite, uuids) => {
    const [first, second] = uuids
    await signIn(page, 'manage')
    await page.goto(`/suites/${suite}/runs/${second}`)

    await page.getByRole('button', { name: 'Delete run' }).click()
    await page.getByLabel(/to confirm/).fill(second.slice(0, 8))
    await page.getByRole('button', { name: 'Delete', exact: true }).click()

    await expect(page).toHaveURL(`/suites/${suite}/machines/m1`)
    const history = table(page, 'Run history')
    await settled(history)
    expect(await column(history, 0)).toEqual([`${first.slice(0, 8)}…`])
    expect((await request.get(`/api/suites/${suite}/runs/${second}`)).status()).toBe(404)
  })
})
