/**
 * The Compare page (CP1-CP7), against the seeded libcxx history: the real machines measured every
 * synthetic commit, three samples per test and run.
 */

import type { APIRequestContext, Locator, Page } from '@playwright/test'
import type { components } from '../client/src/api/schema.d.ts'
import { EXPERIMENT, LINUX, PROFILED_TEST, UNTRACKED } from '../tools/synthetic.ts'
import { expect, json, profiledRun, test } from './fixtures.ts'
import { ownSuite } from './own-suite.ts'
import { pickOption, pickSuggestion } from './select.ts'
import { plotOf, pointOf, type PlotDiv } from './plot.ts'
import { column, rows, table } from './tables.ts'

type Schemas = components['schemas']

/** The controls of `side`, whose fields are named without it: "Suite", "Machine", "Commit". */
function sideOf(page: Page, side: 'A' | 'B') {
  return page.getByRole('region', { name: new RegExp(`^Side ${side} `) })
}

/** The CSS `position` of `cell`, which is `sticky` for a cell kept in view (CP2 "Width"). */
const positionOf = (cell: Locator) =>
  cell.evaluate((element) => getComputedStyle(element).position)

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
  // The columns fit, so none sticks: sticky cells by the thousand are slow to scroll past.
  const box = comparison.locator('xpath=..')
  expect(await box.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  const cells = rows(comparison).nth(1).locator('td')
  expect(await positionOf(cells.nth(0))).toBe('static')
  expect(await positionOf(cells.nth(1))).toBe('static')
})

test('highlights the row of the bar hovered on the chart (CP5)', async ({ page, request }) => {
  const [older, newer] = await newestCommits(request)
  await page.goto(
    `/compare?suite_a=libcxx&machine_a=${LINUX}&commit_a=${older.value}` +
      `&suite_b=libcxx&machine_b=${LINUX}&commit_b=${newer.value}&metric=execution_time`,
  )
  const comparison = table(page, 'Comparison')
  await expect(rows(comparison).first()).toContainText('Geomean')

  await plotOf(page).hover({ position: await pointOf(page, 0, 0) })
  const label = page.locator('.hoverlayer .hovertext')
  await expect(label).toBeVisible()
  // The rows whose background differs from the geomean's, which is never highlighted, by test.
  const highlighted = () =>
    rows(comparison).evaluateAll((all) => {
      const background = (row: Element) => getComputedStyle(row).backgroundColor
      const usual = background(all[0])
      return all.filter((row) => background(row) !== usual).map((row) => row.children[1].textContent)
    })
  await expect.poll(highlighted).toHaveLength(1)
  await expect(label).toContainText((await highlighted())[0]!)
})

test('scrolls the table rather than the page when its columns do not fit', async ({
  page,
  request,
}) => {
  const [older, newer] = await newestCommits(request)
  const statistics = ['samples', 'mean', 'median', 'min', 'max', 'stddev', 'cv', 'pvalue']
  await page.goto(
    `/compare?suite_a=libcxx&machine_a=${LINUX}&commit_a=${older.value}` +
      `&suite_b=libcxx&machine_b=${LINUX}&commit_b=${newer.value}&metric=execution_time` +
      statistics.map((key) => `&columns=${key}`).join(''),
  )
  const comparison = table(page, 'Comparison')
  await expect(rows(comparison).first()).toContainText('Geomean')
  // The Profile column's header is visually hidden, absolutely positioned, which the box must clip
  // as well for the page not to scroll: the check below covers that only while it is shown.
  await expect(comparison.getByRole('columnheader', { name: 'Profile' })).toHaveCount(1)
  const box = comparison.locator('xpath=..')
  expect(await box.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
  expect(
    await page.evaluate(() => {
      const { scrollWidth, clientWidth } = document.documentElement
      return scrollWidth <= clientWidth
    }),
  ).toBe(true)

  const row = rows(comparison).nth(1)
  const cells = row.locator('td')
  const [check, name] = [cells.nth(0), cells.nth(1)]
  const status = row.getByText(/^(Improved|Regressed|Noise|Unchanged)$/)
  // The tests' names are not squeezed to make room for the other columns.
  expect((await name.boundingBox())!.width).toBeGreaterThanOrEqual(200)

  // The row in view, from the page's scrolling: scrolling the cell into view could scroll the box.
  await row.evaluate((element) =>
    window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 100),
  )
  await expect(status).not.toBeInViewport()
  await box.evaluate((element) => (element.scrollLeft = element.scrollWidth))
  await expect(status).toBeInViewport()
  // The checkbox and the name stay in view, over the columns scrolled under them: they stick once
  // the page has found that the columns do not fit.
  await expect.poll(() => positionOf(check)).toBe('sticky')
  await expect.poll(() => positionOf(name)).toBe('sticky')
  const onTop = (cell: Locator) =>
    cell.evaluate((element) => {
      const { left, top, width, height } = element.getBoundingClientRect()
      const hit = document.elementFromPoint(left + width / 2, top + height / 2)
      return hit !== null && element.contains(hit)
    })
  expect(await onTop(check)).toBe(true)
  expect(await onTop(name)).toBe(true)
  // With no gap between them, which the columns scrolled under them would show through.
  const [checkBox, nameBox] = [(await check.boundingBox())!, (await name.boundingBox())!]
  expect(nameBox.x - (checkBox.x + checkBox.width)).toBeCloseTo(0, 0)
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
    await pickSuggestion(controls, 'Machine', LINUX)
    // The commit is searched by its commit string, and suggested by its display value.
    await pickSuggestion(controls, 'Commit', commit.value, String(commit.fields.svn_revision))
  }
  await pickOption(page, 'Metric', 'Execution Time')

  await expect(rows(table(page, 'Comparison')).first()).toContainText('Geomean')
  await expect(page).toHaveURL(new RegExp(`commit_a=${older.value}.*commit_b=${newer.value}`))
})

test('offers the untracked machines last, under their heading (AR18)', async ({ page }) => {
  await page.goto('/compare?suite_a=libcxx')
  const machine = sideOf(page, 'A').getByRole('combobox', { name: 'Machine' })

  await machine.fill('macos-26.5-arm64')

  const untracked = page.getByRole('group', { name: 'Untracked' })
  await expect(untracked.getByRole('option')).toHaveText([UNTRACKED])
  // After every tracked machine matching the text.
  await expect(page.getByRole('option').last()).toHaveText(UNTRACKED)
  await expect(page.getByRole('option').first()).not.toHaveText(UNTRACKED)
})

test('suggests the commits highest ordinal first (AR15)', async ({ page, request }) => {
  const [, newest] = await newestCommits(request)
  await page.goto(`/compare?suite_a=libcxx&machine_a=${LINUX}`)

  await sideOf(page, 'A').getByRole('button', { name: 'Show suggestions Commit' }).click()

  // Not the experiment, although LINUX saw it last: it has no ordinal, so it comes after them.
  await expect(page.getByRole('option').first()).toContainText(String(newest.fields.svn_revision))
})

test("links a test to its profile on both sides, side B on its default test", async ({
  page,
  request,
}) => {
  const [, newest] = await newestCommits(request)
  const runA = await profiledRun(request, LINUX, newest.value)
  const runB = await profiledRun(request, LINUX, EXPERIMENT)
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
    machine_a: LINUX,
    commit_a: newest.value,
    run_a: runA,
    test_a: PROFILED_TEST,
    suite_b: 'libcxx',
    machine_b: LINUX,
    commit_b: EXPERIMENT,
    run_b: runB,
  })
  await expect(row.getByRole('link', { name: 'Profile' })).toHaveAttribute(
    'href',
    `/profiles?${profiles}`,
  )
})

test('adds the comparison to a new regression, then to that one', async ({
  page,
  request,
  tokenFor,
  signIn,
}, testInfo) => {
  const run = (commit: string, ordinal: number, value: number) => ({
    machine: 'm1',
    commit,
    ordinal,
    tests: [{ name: 'bench', samples: [{ execution_time: value }] }],
  })
  await ownSuite(request, tokenFor, testInfo, [run('c1', 1, 1), run('c2', 2, 2)], async (suite) => {
    await signIn(page, 'triage')
    await page.goto(
      `/compare?suite_a=${suite}&machine_a=m1&commit_a=c1&suite_b=${suite}&machine_b=m1` +
        '&commit_b=c2&metric=execution_time',
    )
    await expect(rows(table(page, 'Comparison')).first()).toContainText('Geomean')

    const toggle = page.getByRole('button', { name: 'Add to regression' })
    await toggle.click()
    const create = page.getByRole('form', { name: 'Create new regression' })
    await create.getByLabel('Title').fill('From compare')
    await create.getByRole('button', { name: 'Create regression' }).click()
    const link = page.getByRole('status').getByRole('link', { name: 'From compare' })
    await expect(link).toBeVisible()
    const uuid = (await link.getAttribute('href'))!.split('/').at(-1)!
    const created = await json<Schemas['RegressionDetail']>(
      request,
      `/api/suites/${suite}/regressions/${uuid}`,
    )
    expect(created.commit).toBe('c2')
    expect(created.indicators).toMatchObject([
      { machine: 'm1', test: 'bench', metric: 'execution_time' },
    ])

    // Adding the same indicator again adds none.
    await toggle.click()
    const add = page.getByRole('form', { name: 'Add to existing' })
    await add.getByRole('combobox', { name: 'Regression' }).fill('From')
    await page.getByRole('option', { name: 'From compare' }).click()
    await add.getByRole('button', { name: 'Add indicators' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Added' })).toHaveText(
      'Added 0 indicators to From compare. 1 indicator already existed.',
    )
  })
})

test('overlays a pinned side B on the chart once side B changes', async ({ page, request }) => {
  const [older, newer] = await newestCommits(request)
  await page.goto(
    `/compare?suite_a=libcxx&machine_a=${LINUX}&commit_a=${older.value}` +
      `&suite_b=libcxx&machine_b=${LINUX}&commit_b=${newer.value}&metric=execution_time`,
  )
  await expect(rows(table(page, 'Comparison')).first()).toContainText('Geomean')

  await page.getByRole('button', { name: 'Pin as shadow' }).click()
  await expect(page.getByText(/^Shadow:/)).toHaveText(
    `Shadow: ${newer.fields.svn_revision} on ${LINUX}×`,
  )
  await expect(page.getByRole('button', { name: 'Dismiss the shadow' })).toBeFocused()
  // Side B on the experiment: its comparison is the bars, and the newest commit's the line.
  // Typed key by key, as a user does: `fill`, which sets the whole text at once, is sometimes lost
  // when the focus comes from the chip's button.
  const commitB = sideOf(page, 'B').getByRole('combobox', { name: 'Commit' })
  await commitB.click()
  await commitB.press('ControlOrMeta+a')
  await commitB.pressSequentially(EXPERIMENT)
  await page.getByRole('option', { name: EXPERIMENT, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`[?&]commit_b=${EXPERIMENT}(&|$)`))
  await expect(page).toHaveURL(new RegExp(`[?&]commit_shadow_b=${newer.value}(&|$)`))
  const traces = () =>
    plotOf(page).evaluate((element) =>
      (element as PlotDiv)._fullData.map((trace) => ({ name: trace.name, y: trace.y })),
    )
  await expect.poll(async () => (await traces()).map((trace) => trace.name)).toEqual([
    'comparison',
    'shadow',
  ])
  // The line goes through a point per test, sorted by its own ratios.
  const points = (await traces())[1].y
  expect(points.length).toBeGreaterThan(10)
  expect(points).toEqual([...points].sort((x, y) => x - y))
})
