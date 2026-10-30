/**
 * The Profiles page (PF1-PF9), against the seeded libcxx history. In the seed, the run of the
 * newest commit on LINUX (x86-64) and on MACOS (aarch64) has profiles, and so do both runs of the
 * experiment on LINUX.
 */

import type { APIRequestContext, Locator, Page } from '@playwright/test'
import type { components } from '../client/src/api/schema.d.ts'
import { defaultDescription } from '../client/src/pages/profiles/defaults.ts'
import { profilesPath } from '../client/src/paths.ts'
import {
  EXPERIMENT,
  FORMAT_HOTTEST,
  FORMAT_TEST,
  HARDENED,
  LINUX,
  MACOS,
  PROFILED_TEST,
} from '../tools/synthetic.ts'
import { BENCHMARKS, expect, json, profiledRun, test } from './fixtures.ts'
import { clickSuggestion, pickOption, pickSuggestion, pickSuite, typeInto } from './select.ts'
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
  const path =
    `/api/projects/libcxx/suites/benchmarks/commits?machine=${machine}&has_profiles=true` +
    '&sort=-ordinal&limit=1'
  return (await json<Schemas['CommitCursorPage']>(request, path)).items[0]
}


test("shows the profile of a test that Run Detail's Profile link names", async ({
  page,
  request,
}) => {
  const commit = await newestProfiled(request, MACOS)
  const run = await profiledRun(request, MACOS, commit.value)
  await page.goto(`/projects/libcxx/suites/benchmarks/runs/${run}`)
  await page.getByRole('searchbox', { name: 'Filter tests' }).fill(PROFILED_TEST)
  const row = rows(table(page, 'Samples')).filter({ hasText: PROFILED_TEST }).first()
  await row.getByRole('link', { name: 'Profile' }).click()

  await expect(page).toHaveURL(/\/profiles\?/)
  const side = sideOf(page, 'A')
  await expect(side.getByRole('combobox', { name: 'Machine' })).toHaveValue(MACOS)
  await expect(side.getByRole('combobox', { name: 'Test' })).toHaveValue(PROFILED_TEST)
  await expect(side.getByRole('link', { name: /^Run / })).toHaveAttribute(
    'href',
    `/projects/libcxx/suites/benchmarks/runs/${run}`,
  )
  // A function of the profile is shown, which a profile loading or failed would not show.
  const functionA = columnOf(page, 'A').getByRole('combobox', { name: 'Function' })
  await expect(functionA).toHaveValue(/^std::__1::__stable_sort</)
  await expect(columnOf(page, 'B')).toHaveCount(0)
})

/** Expect the combobox `field` to show `name` as side B's default, holding no value. */
async function expectDefault(field: Locator, name: string) {
  await expect(field).toHaveValue('')
  await expect(field).toHaveAttribute('placeholder', name)
  await expect(field).toHaveAccessibleDescription(defaultDescription(name))
}

/**
 * Pick the function `name` in the column of `side`, whose suggestions show their share too. Only
 * once the column shows its profile's functions for good: a new profile, or counter, mounts a new
 * selector, which would lose what was typed.
 */
async function pickFunction(page: Page, side: 'A' | 'B', name: string) {
  await typeInto(columnOf(page, side).getByRole('combobox', { name: 'Function' }), name)
  // Named by its share too: "main, 1% of cycles".
  await clickSuggestion(page.getByRole('option', { name: `${name}, ` }))
}

test("defaults side B's test to side A's, also on another machine", async ({ page, request }) => {
  const commit = await newestProfiled(request, LINUX)
  const linuxRun = await profiledRun(request, LINUX, commit.value)
  const macosRun = await profiledRun(request, MACOS, commit.value)
  const query = new URLSearchParams({
    project_a: 'libcxx',
    suite_a: 'benchmarks',
    machine_a: LINUX,
    commit_a: commit.value,
    run_a: linuxRun,
    test_a: PROFILED_TEST,
  })
  await page.goto(`/profiles?${query}`)
  await expect(sideOf(page, 'A').getByRole('combobox', { name: 'Test' })).toHaveValue(
    PROFILED_TEST,
  )

  await pickSuite(sideOf(page, 'B'), 'Suite', 'libc++', 'Microbenchmarks')
  await pickSuggestion(sideOf(page, 'B'), 'Machine', LINUX)
  // The commit is searched by its commit string, and suggested by its display value.
  await pickSuggestion(sideOf(page, 'B'), 'Commit', commit.value, String(commit.fields.svn_revision))

  // The latest run with profiles, on side A's test by default, which the URL leaves out.
  await expect(page).toHaveURL(new RegExp(`[?&]run_b=${linuxRun}(&|$)`))
  const testB = sideOf(page, 'B').getByRole('combobox', { name: 'Test' })
  await expectDefault(testB, PROFILED_TEST)
  await expect(columnOf(page, 'B')).toBeAttached()
  await expect(page).not.toHaveURL(/[?&]test_b=/)

  // MACOS has profiles at the same commit: side B keeps it, and shows the default test there.
  await pickSuggestion(sideOf(page, 'B'), 'Machine', MACOS)
  await expect(page).toHaveURL(new RegExp(`[?&]run_b=${macosRun}(&|$)`))
  await expect(page).toHaveURL(new RegExp(`[?&]commit_b=${commit.value}(&|$)`))
  await expectDefault(testB, PROFILED_TEST)
  await expect(columnOf(page, 'A').getByRole('combobox', { name: 'Function' })).toHaveValue(
    /^std::__1::__stable_sort</,
  )
  await expectDefault(
    columnOf(page, 'B').getByRole('combobox', { name: 'Function' }),
    'std::__1::__stable_sort<_ClassicAlgPolicy, __less<>&, int*>(int*, int*, long)',
  )
})

test("defaults side B's test and function to side A's, until the user picks on side B", async ({
  page,
  request,
}) => {
  const commit = await newestProfiled(request, LINUX)
  const side = { suite: BENCHMARKS, machine: LINUX }
  await page.goto(
    profilesPath(
      { ...side, commit: commit.value, run: await profiledRun(request, LINUX, commit.value) },
      { ...side, commit: EXPERIMENT, run: await profiledRun(request, LINUX, EXPERIMENT) },
    ),
  )
  const testA = sideOf(page, 'A').getByRole('combobox', { name: 'Test' })
  const testB = sideOf(page, 'B').getByRole('combobox', { name: 'Test' })
  const functionB = columnOf(page, 'B').getByRole('combobox', { name: 'Function' })
  await expect(testB).toHaveAttribute('placeholder', 'Select a test')

  // Side A's test, then its function, which side B shows by default.
  await pickSuggestion(sideOf(page, 'A'), 'Test', FORMAT_TEST)
  await expectDefault(testB, FORMAT_TEST)
  await expectDefault(functionB, FORMAT_HOTTEST)
  await pickFunction(page, 'A', 'memcpy')
  await expectDefault(functionB, 'memcpy')
  const instructionsB = columnOf(page, 'B').getByRole('table', { name: 'Instructions of memcpy' })
  await expect(instructionsB).toBeVisible()
  await expect(page).not.toHaveURL(/[?&](test_b|function_b)=/)

  // A function picked on side B stays as side A's changes, until it is cleared.
  await pickFunction(page, 'B', 'main')
  await expect(functionB).toHaveValue('main')
  await expect(page).toHaveURL(/[?&]function_b=main(&|$)/)
  await pickFunction(page, 'A', FORMAT_HOTTEST)
  await expect(functionB).toHaveValue('main')
  await columnOf(page, 'B').getByRole('button', { name: 'Clear Function' }).click()
  await expectDefault(functionB, FORMAT_HOTTEST)
  await expect(page).not.toHaveURL(/[?&]function_b=/)

  // So is a test picked on side B, even side A's.
  await pickSuggestion(sideOf(page, 'B'), 'Test', FORMAT_TEST)
  await expect(testB).toHaveValue(FORMAT_TEST)
  await pickSuggestion(sideOf(page, 'A'), 'Test', PROFILED_TEST)
  await expect(testA).toHaveValue(PROFILED_TEST)
  await expect(testB).toHaveValue(FORMAT_TEST)
  // Side B's profile has no function of side A's name: it shows none until the user picks one.
  await expect(functionB).toHaveValue('')
  await expect(functionB).toHaveAttribute('placeholder', 'Select a function')
  await sideOf(page, 'B').getByRole('button', { name: 'Clear Test' }).click()
  await expectDefault(testB, PROFILED_TEST)
  await expect(page).not.toHaveURL(/[?&]test_b=/)
})

test("shows the hottest function's instructions, as the counter and the Values say", async ({
  page,
  request,
}) => {
  const commit = await newestProfiled(request, MACOS)
  const run = await profiledRun(request, MACOS, commit.value)
  const query = new URLSearchParams({
    project_a: 'libcxx',
    suite_a: 'benchmarks',
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
  const badge = column.getByTitle("Share of the profile's branch-misses")
  await expect(badge.locator('[aria-hidden="true"]')).toHaveText('45%')
  // Assistive technology reads it with its counter.
  await expect(badge.getByText('45% of branch-misses')).toBeAttached()
  const instructions = column.getByRole('table', { name: `Instructions of ${hottest}` })
  // The instruction in row `index`, counting the header as row 1.
  const row = (index: number) => instructions.locator(`tr[aria-rowindex="${index}"]`)
  // An aarch64 function's prologue, which has no branch misses: its value is left empty.
  await expect(row(2)).toContainText('stp    x29, x30, [sp, #-16]!')
  await expect(row(2).getByRole('cell').first()).toHaveText('')
  await expect(instructions.getByRole('columnheader', { name: 'branch-misses' })).toBeVisible()

  await pickOption(page, 'Counter', 'cycles')
  await expect(instructions.getByRole('columnheader', { name: 'cycles' })).toBeVisible()
  await expect(page).toHaveURL(/[?&]counter=cycles(&|$)/)
  await expect(column.getByRole('combobox', { name: 'Function' })).toHaveValue(hottest)

  await pickOption(page, 'Values', 'Cumulative %')
  await expect(page).toHaveURL(/[?&]values=cumulative(&|$)/)
  // The function's last instruction, its 19th (see tools/synthetic.ts), accounts for the rest.
  await expect(row(20)).toContainText('ret')
  await expect(row(20)).toContainText('100%')
  // An instruction of its loop does not, yet.
  await expect(row(10)).not.toContainText('100%')
})

test('keeps the test on another run of the same commit', async ({ page, request }) => {
  // Both runs of the experiment have profiles: the page starts on the latest.
  const path =
    `/api/projects/libcxx/suites/benchmarks/runs?machine=${LINUX}&commit=${EXPERIMENT}` +
    '&has_profiles=true'
  const runs = (await json<Schemas['RunCursorPage']>(request, `${path}&sort=measured_at`)).items
  expect(runs).toHaveLength(2)
  const [first, latest] = runs.map((run) => run.uuid)
  const query = new URLSearchParams({
    project_a: 'libcxx',
    suite_a: 'benchmarks',
    machine_a: LINUX,
    commit_a: EXPERIMENT,
    test_a: PROFILED_TEST,
  })
  await page.goto(`/profiles?${query}`)
  await expect(page).toHaveURL(new RegExp(`[?&]run_a=${latest}(&|$)`))
  // The share of the hottest function, which differs a little between the two runs' profiles.
  const functionA = columnOf(page, 'A').getByRole('combobox', { name: 'Function' })
  await expect(functionA).toHaveValue(/^std::__1::__stable_sort</)
  const share = columnOf(page, 'A').getByTitle(/^Share of the profile's /).locator('[aria-hidden]')
  const latestShare = await share.textContent()

  const side = sideOf(page, 'A')
  // Each run is listed by when it was measured, in the browser's time zone, and its short UUID.
  await side.getByRole('button', { name: / Run$/ }).click()
  await page.getByRole('option').filter({ hasText: first.slice(0, 8) }).click()
  await expect(page).toHaveURL(new RegExp(`[?&]run_a=${first}(&|$)`))
  await expect(side.getByRole('combobox', { name: 'Test' })).toHaveValue(PROFILED_TEST)
  await expect(side.getByRole('link', { name: /^Run / })).toHaveAttribute(
    'href',
    `/projects/libcxx/suites/benchmarks/runs/${first}`,
  )
  // The first run's profile of the test, with its own share of the same function.
  await expect(functionA).toHaveValue(/^std::__1::__stable_sort</)
  await expect(share).toHaveText(/%$/)
  await expect(share).not.toHaveText(latestShare!)
})

test('says when a machine has no profiles', async ({ page }) => {
  await page.goto(`/profiles?project_a=libcxx&suite_a=benchmarks&machine_a=${HARDENED}`)

  await expect(sideOf(page, 'A').getByRole('combobox', { name: 'Commit' })).toHaveAttribute(
    'placeholder',
    'No profiles on this machine',
  )
  await expect(page.getByText('Select a test on either side to see its profile.')).toBeVisible()
})

test('compares the counters of two profiles, and the functions they show', async ({
  page,
  request,
}) => {
  // The newest commit's profile on LINUX, and the first run of the experiment, whose hottest
  // function takes a share of 0.376 of each counter rather than 0.47 (see tools/synthetic.ts).
  const commit = await newestProfiled(request, LINUX)
  const linuxRun = await profiledRun(request, LINUX, commit.value)
  const path =
    `/api/projects/libcxx/suites/benchmarks/runs?machine=${LINUX}&commit=${EXPERIMENT}` +
    '&has_profiles=true'
  const [first] = (await json<Schemas['RunCursorPage']>(request, `${path}&sort=measured_at`)).items
  const side = { suite: BENCHMARKS, machine: LINUX, test: PROFILED_TEST }
  await page.goto(
    profilesPath(
      { ...side, commit: commit.value, run: linuxRun },
      { ...side, commit: EXPERIMENT, run: first.uuid },
    ),
  )

  // Every counter goes down by the hottest function's 0.094 of the 0.94 that the listed functions
  // account for, and the hottest function by a fifth. The cells hold no separator between them.
  const comparison = table(page, 'Counter comparison')
  await expect(rows(comparison)).toHaveText([
    /^branch-misses\d+\d+-10%$/,
    /^cycles\d+\d+-10%$/,
    /^instructions\d+\d+-10%$/,
    /^Function branch-misses\d+\d+-20%$/,
  ])
  // Green, since fewer events are better.
  await expect(rows(comparison).first().getByText('-10%')).toHaveCSS('color', 'rgb(21, 128, 61)')

  await pickOption(page, 'Counter', 'cycles')
  await expect(rows(comparison).last()).toHaveText(/^Function cycles\d+\d+-20%$/)
})

test('steps through the hottest instructions of a function', async ({ page, request }) => {
  const commit = await newestProfiled(request, MACOS)
  const run = await profiledRun(request, MACOS, commit.value)
  await page.goto(
    profilesPath({
      suite: BENCHMARKS,
      machine: MACOS,
      commit: commit.value,
      run,
      test: PROFILED_TEST,
    }),
  )

  const column = columnOf(page, 'A')
  const hottest = column.getByRole('group', { name: 'Hottest' })
  const previous = hottest.getByRole('button', { name: /Previous/ })
  const next = hottest.getByRole('button', { name: /Next/ })
  const highlighted = column.locator('tr[aria-current="true"]')
  await expect(column.getByRole('table', { name: /^Instructions of / })).toBeVisible()
  await expect(previous).toHaveAttribute('aria-disabled', 'true')

  // Under branch-misses, only the branches of the hottest function's loop have a value: the one
  // closing the loop, then the one skipping it (see tools/synthetic.ts).
  await next.click()
  await expect(highlighted).toHaveAttribute('aria-rowindex', '18')
  await expect(highlighted).toContainText('b.ne')
  await expect(highlighted).toBeInViewport()
  await expect(hottest.getByRole('status')).toHaveText(/^Hottest instruction 1 of 2, at 0x/)
  await next.click()
  await expect(highlighted).toHaveAttribute('aria-rowindex', '4')
  await expect(highlighted).toContainText('cbz')
  await expect(next).toHaveAttribute('aria-disabled', 'true')
  await expect(next).toBeFocused()
  await previous.click()
  await expect(highlighted).toHaveAttribute('aria-rowindex', '18')

  // Another counter starts again, under which every instruction has a value.
  await pickOption(page, 'Counter', 'cycles')
  await expect(column.getByRole('columnheader', { name: 'cycles' })).toBeVisible()
  await expect(highlighted).toHaveCount(0)
  await next.click()
  await expect(hottest.getByRole('status')).toHaveText(/^Hottest instruction 1 of 19, at 0x/)
  await expect(highlighted).toHaveCount(1)
})
