/**
 * The Graph page (GR1-GR14), against the seeded libcxx history: the real machines measured its
 * tests at every commit.
 */

import type { Page } from '@playwright/test'
import type { components } from '../client/src/api/schema.d.ts'
import { LINUX, MACOS, uuidFor } from '../tools/synthetic.ts'
import { expect, json, test } from './fixtures.ts'
import { plotOf, pointOf, tracesOf, type PlotDiv } from './plot.ts'
import { pickOption } from './select.ts'
import { table } from './tables.ts'

/** A page of a cursor-paginated list (I2). */
interface ListPage<Item> {
  items: Item[]
}

/** A test every real machine measured, at every commit. */
const TEST = 'BM_num_get<void*>'

const GRAPHED = `/graph?suite=libcxx&machine=${LINUX}&machine=${MACOS}&metric=execution_time`

/** The range of the x-axis as Plotly drew it. */
function xRange(page: Page) {
  return plotOf(page).evaluate((element) => (element as PlotDiv)._fullLayout.xaxis.range)
}

/** Whether the chart draws a trace named `name`. */
function draws(page: Page, name: string) {
  return plotOf(page).evaluate(
    // Undefined until the plot is first drawn.
    (element, name) => (element as PlotDiv)._fullData?.some((d) => d.name === name) ?? false,
    name,
  )
}

/** The Graph of TEST on LINUX. */
const LINUX_TEST =
  `/graph?suite=libcxx&machine=${LINUX}&metric=execution_time` +
  `&test=${encodeURIComponent(TEST)}`

function testBox(page: Page, name: string) {
  return table(page, 'Tests').getByRole('checkbox', { name, exact: true })
}

test('plots a test chosen from scratch', async ({ page }) => {
  await page.goto('/graph')

  await pickOption(page, 'Suite', 'libcxx')
  const machines = page.getByRole('combobox', { name: 'Machines' })
  await machines.fill(LINUX)
  await page.getByRole('option', { name: LINUX, exact: true }).click()
  await pickOption(page, 'Metric', 'Execution Time')
  await testBox(page, TEST).check()

  await expect(tracesOf(page)).toHaveCount(1)
  await expect(page).toHaveURL(
    `/graph?suite=libcxx&machine=${LINUX}&metric=execution_time&test=${encodeURIComponent(TEST)}`,
  )
})

test('keeps the x-axis as it is while the data arrives (GR3)', async ({ page, request }) => {
  // The axis spans every commit of both machines, before anything is plotted.
  const commits = new Set<string>()
  for (const machine of [LINUX, MACOS]) {
    const path = `/api/suites/libcxx/commits?machine=${machine}&sort=ordinal&limit=10000`
    const list = await json<ListPage<{ value: string }>>(request, path)
    for (const commit of list.items) commits.add(commit.value)
  }
  await page.goto(GRAPHED)
  await expect.poll(() => xRange(page)).toEqual([-0.5, commits.size - 0.5])
  const before = await xRange(page)

  await testBox(page, TEST).check()

  await expect(tracesOf(page)).toHaveCount(2)
  expect(await xRange(page)).toEqual(before)
})

test('restores the chart from its URL, after a reload too', async ({ page }) => {
  await page.goto(`${GRAPHED}&test=${encodeURIComponent(TEST)}`)
  await expect(tracesOf(page)).toHaveCount(2)
  await expect(testBox(page, TEST)).toBeChecked()

  await page.reload()

  await expect(tracesOf(page)).toHaveCount(2)
  await expect(page.getByText(/^1 of \d+ tests selected$/)).toBeVisible()
})

test("lists the tests of a Dashboard card's machines, and plots none", async ({ page }) => {
  await page.goto('/')
  // Other tests create suites of their own, which the Dashboard lists too.
  const card = page
    .getByRole('main')
    .getByRole('region', { name: 'libcxx', exact: true })
    .getByRole('article', { name: 'Execution Time', exact: true })
  await card.getByRole('link', { name: 'Execution Time', exact: true }).click()

  await expect(page).toHaveURL(/\/graph\?suite=libcxx&machine=.*&metric=execution_time$/)
  await expect(testBox(page, TEST)).not.toBeChecked()
  await expect(tracesOf(page)).toHaveCount(0)
})

test("shows a point's runs on hover, and its details on a click (GR10, GR11)", async ({ page }) => {
  await page.goto(LINUX_TEST)
  await expect(tracesOf(page)).toHaveCount(1)

  // A point that combines several runs, whose values the hover scatter shows (GR10), and that
  // has a point before it to compare with (GR11).
  const index = await plotOf(page).evaluate((element) => {
    const [trace] = (element as PlotDiv & { _fullData: { customdata: string[][] }[] })._fullData
    return trace.customdata.findIndex(([, , runs], i) => i > 0 && runs !== '1 run')
  })
  expect(index).toBeGreaterThan(0)
  const position = await pointOf(page, 0, index)
  await plotOf(page).hover({ position })
  await expect(page.locator('.hoverlayer')).toContainText('Click for details')
  await expect(page.locator('svg[class*="scatter"] circle').first()).toBeVisible()
  expect(await page.locator('svg[class*="scatter"] circle').count()).toBeGreaterThan(1)

  await plotOf(page).click({ position })
  const details = page.getByRole('dialog')
  await expect(details).toBeFocused()
  expect(await details.getAttribute('aria-label')).toMatch(`${TEST} on ${LINUX} at `)
  await expect(details.getByRole('link', { name: LINUX })).toBeVisible()
  const compare = details.getByRole('link', { name: 'Compare with previous' })
  await expect(compare).toHaveAttribute('href', /^\/compare\?suite_a=libcxx&machine_a=.*&commit_b=/)

  await details.getByRole('table', { name: 'Runs' }).getByRole('link').first().click()
  await expect(page).toHaveURL(/\/suites\/libcxx\/runs\//)
})

test("marks a regression at its commit, and shows its details from its marker (GR15)", async ({
  page,
  request,
}) => {
  const uuid = uuidFor('libcxx/regression/format')
  const regression = await json<components['schemas']['RegressionDetail']>(
    request,
    `/api/suites/libcxx/regressions/${uuid}`,
  )
  const { test: name } = regression.indicators.find((indicator) => indicator.machine === LINUX)!
  const graph = `/graph?suite=libcxx&machine=${LINUX}&metric=execution_time`
  await page.goto(`${graph}&test=${encodeURIComponent(name)}&regressions=all`)

  const marker = `regression ${uuid}`
  await expect.poll(() => draws(page, marker)).toBe(true)
  const position = await pointOf(page, marker, 0)
  await plotOf(page).hover({ position })
  await expect(page.locator('.hoverlayer')).toContainText('std::format slowdown')

  await plotOf(page).click({ position })
  const details = page.getByRole('dialog', { name: 'Regression: std::format slowdown' })
  await expect(details).toBeFocused()
  await details.getByRole('link', { name: `${uuid.slice(0, 8)}…` }).click()
  await expect(page).toHaveURL(`/suites/libcxx/regressions/${uuid}`)
})

test('adds a baseline from its panel, drawn across the chart (GR9)', async ({ page }) => {
  await page.goto(LINUX_TEST)
  await expect(tracesOf(page)).toHaveCount(1)

  await page.getByRole('button', { name: 'Add a baseline' }).click()
  await pickOption(page, 'Baseline suite', 'libcxx')
  const machine = page.getByRole('combobox', { name: 'Baseline machine' })
  await machine.fill(MACOS)
  await page.getByRole('option', { name: MACOS, exact: true }).click()
  const commit = page.getByRole('combobox', { name: 'Baseline commit' })
  await commit.click()
  await commit.press('ArrowDown')
  await page.getByRole('option').first().click()

  await expect(page).toHaveURL(new RegExp(`&baseline=libcxx%2F${MACOS}%2F`))
  const chips = page.getByRole('list', { name: 'Baselines added' })
  await expect(chips).toContainText(`libcxx/${MACOS}/`)
  await expect(tracesOf(page)).toHaveCount(2)
})

