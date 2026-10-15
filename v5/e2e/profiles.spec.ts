/**
 * The Profiles page (PF1-PF9), against the seeded libcxx history. In the seed, the first run of
 * the newest commit on LINUX (x86-64) and on MACOS (aarch64) has profiles, and so does the
 * experiment's first run on LINUX.
 */

import type { APIRequestContext, Page } from '@playwright/test'
import type { components } from '../client/src/api/schema.d.ts'
import { HARDENED, LINUX, MACOS, PROFILED_TEST } from '../tools/synthetic.ts'
import { expect, json, profiledRun, test } from './fixtures.ts'
import { pickOption, pickSuggestion } from './select.ts'
import { rows, table } from './tables.ts'

type Schemas = components['schemas']

/** The controls of `side`, whose fields are named without it: "Suite", "Machine", "Commit". */
function sideOf(page: Page, side: 'A' | 'B') {
  return page.getByRole('region', { name: `Side ${side}`, exact: true })
}

/** The column of the profile `side` shows (PF7). */
function columnOf(page: Page, side: 'A' | 'B') {
  return page.getByRole('region', { name: `Profile ${side}`, exact: true })
}

/** The newest commit, by ordinal, at which `machine` has profiles. */
async function newestProfiled(request: APIRequestContext, machine: string) {
  const path = `/api/suites/libcxx/commits?machine=${machine}&has_profiles=true&sort=-ordinal&limit=1`
  return (await json<Schemas['CommitCursorPage']>(request, path)).items[0]
}


test("shows the profile of a test that Run Detail's Profile link names", async ({
  page,
  request,
}) => {
  const commit = await newestProfiled(request, MACOS)
  const run = await profiledRun(request, MACOS, commit.value)
  await page.goto(`/suites/libcxx/runs/${run}`)
  await page.getByRole('searchbox', { name: 'Filter tests' }).fill(PROFILED_TEST)
  const row = rows(table(page, 'Samples')).filter({ hasText: PROFILED_TEST }).first()
  await row.getByRole('link', { name: 'Profile' }).click()

  await expect(page).toHaveURL(/\/profiles\?/)
  const side = sideOf(page, 'A')
  await expect(side.getByRole('combobox', { name: 'Machine' })).toHaveValue(MACOS)
  await expect(side.getByRole('combobox', { name: 'Test' })).toHaveValue(PROFILED_TEST)
  await expect(side.getByRole('link', { name: /^Run / })).toHaveAttribute(
    'href',
    `/suites/libcxx/runs/${run}`,
  )
  await expect(columnOf(page, 'A')).toBeAttached()
  await expect(columnOf(page, 'A')).not.toContainText('Loading')
  await expect(columnOf(page, 'B')).toHaveCount(0)
})

test("starts side B on side A's test, and keeps it on another machine", async ({
  page,
  request,
}) => {
  const commit = await newestProfiled(request, LINUX)
  const linuxRun = await profiledRun(request, LINUX, commit.value)
  const macosRun = await profiledRun(request, MACOS, commit.value)
  const query = new URLSearchParams({
    suite_a: 'libcxx',
    machine_a: LINUX,
    commit_a: commit.value,
    run_a: linuxRun,
    test_a: PROFILED_TEST,
  })
  await page.goto(`/profiles?${query}`)
  await expect(sideOf(page, 'A').getByRole('combobox', { name: 'Test' })).toHaveValue(
    PROFILED_TEST,
  )

  await pickOption(sideOf(page, 'B'), 'Suite', 'libcxx')
  await pickSuggestion(sideOf(page, 'B'), 'Machine', LINUX)
  // The commit is searched by its commit string, and suggested by its display value.
  await pickSuggestion(sideOf(page, 'B'), 'Commit', commit.value, String(commit.fields.svn_revision))

  // The latest run with profiles, and side A's test.
  await expect(page).toHaveURL(new RegExp(`[?&]run_b=${linuxRun}(&|$)`))
  const testB = sideOf(page, 'B').getByRole('combobox', { name: 'Test' })
  await expect(testB).toHaveValue(PROFILED_TEST)
  await expect(columnOf(page, 'B')).toBeAttached()

  // MACOS has profiles at the same commit: side B keeps it, and its test, in MACOS's run.
  await pickSuggestion(sideOf(page, 'B'), 'Machine', MACOS)
  await expect(page).toHaveURL(new RegExp(`[?&]run_b=${macosRun}(&|$)`))
  await expect(page).toHaveURL(new RegExp(`[?&]commit_b=${commit.value}(&|$)`))
  await expect(testB).toHaveValue(PROFILED_TEST)
  await expect(columnOf(page, 'A')).toBeAttached()
  await expect(columnOf(page, 'B')).not.toContainText('Loading')
})

test("shows the hottest function's instructions, as the counter and the Values say", async ({
  page,
  request,
}) => {
  const commit = await newestProfiled(request, MACOS)
  const run = await profiledRun(request, MACOS, commit.value)
  const query = new URLSearchParams({
    suite_a: 'libcxx',
    machine_a: MACOS,
    commit_a: commit.value,
    run_a: run,
    test_a: PROFILED_TEST,
  })
  await page.goto(`/profiles?${query}`)

  // The seed's hottest function of the test, with its share of the profile's branch misses: the
  // counter offered first that both have.
  const hottest = 'std::__1::__stable_sort<_ClassicAlgPolicy, __less<>&, int*>(int*, int*, long)'
  const column = columnOf(page, 'A')
  await expect(column.getByRole('combobox', { name: 'Function' })).toHaveValue(hottest)
  await expect(column.getByTitle("Share of the profile's branch-misses")).toHaveText('45%')
  const instructions = column.getByRole('table', { name: `Instructions of ${hottest}` })
  // An aarch64 function's prologue, whose instructions have no share worth showing.
  await expect(instructions.locator('tbody tr[aria-rowindex]').first()).toContainText('stp    x29, x30, [sp, #-16]!')
  await expect(instructions.getByRole('columnheader', { name: 'branch-misses' })).toBeVisible()

  await pickOption(page, 'Counter', 'cycles')
  await expect(instructions.getByRole('columnheader', { name: 'cycles' })).toBeVisible()
  await expect(page).toHaveURL(/[?&]counter=cycles(&|$)/)
  await expect(column.getByRole('combobox', { name: 'Function' })).toHaveValue(hottest)

  await pickOption(page, 'Values', 'Cumulative %')
  await expect(page).toHaveURL(/[?&]values=cumulative(&|$)/)
  await expect(instructions.locator('tbody tr[aria-rowindex]').last()).toContainText('100%')
})

test('says when a machine has no profiles', async ({ page }) => {
  await page.goto(`/profiles?suite_a=libcxx&machine_a=${HARDENED}`)

  await expect(sideOf(page, 'A').getByRole('combobox', { name: 'Commit' })).toHaveAttribute(
    'placeholder',
    'No profiles on this machine',
  )
  await expect(page.getByText('Select a test on either side to see its profile.')).toBeVisible()
})
