/**
 * The Graph page (GR1-GR14), against the seeded libcxx history: the real machines measured its
 * tests at every commit.
 */

import type { Page } from '@playwright/test'
import { LINUX, MACOS } from '../tools/synthetic.ts'
import { expect, test } from './fixtures.ts'
import { pickOption } from './select.ts'

/** A test every real machine measured, at every commit. */
const TEST = 'BM_num_get<void*>'

const GRAPHED = `/graph?suite=libcxx&machine=${LINUX}&machine=${MACOS}&metric=execution_time`

/** The plot, once Plotly has drawn it. */
function plotOf(page: Page) {
  return page.getByRole('main').locator('.js-plotly-plot')
}

/** The lines the chart draws, one per test and machine. */
function tracesOf(page: Page) {
  return plotOf(page).locator('.scatterlayer .trace')
}

/** The range of the x-axis as Plotly drew it, from its internals (see dashboard.spec.ts). */
function xRange(page: Page) {
  return plotOf(page).evaluate(
    (element) =>
      (element as unknown as { _fullLayout: { xaxis: { range: number[] } } })._fullLayout.xaxis
        .range,
  )
}

function testBox(page: Page, name: string) {
  return page.getByRole('table', { name: 'Tests' }).getByRole('checkbox', { name, exact: true })
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

test('keeps the x-axis as it is while the data arrives (GR3)', async ({ page }) => {
  await page.goto(GRAPHED)
  // The axis spans the machines' commits before anything is plotted.
  await expect(page.getByRole('table', { name: 'Tests' })).toBeVisible()
  await expect.poll(async () => (await xRange(page))[0]).toBe(-0.5)
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
  await expect(page.getByText('1 of ')).toBeVisible()
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
