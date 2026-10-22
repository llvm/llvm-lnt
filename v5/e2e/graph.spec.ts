/**
 * The Graph page (GR1-GR16), against the seeded libcxx history: the real machines measured its
 * tests at every commit.
 */

import type { APIRequestContext, Locator, Page } from '@playwright/test'
import type { components } from '../client/src/api/schema.d.ts'
import { LINUX, MACOS, uuidFor } from '../tools/synthetic.ts'
import { expect, json, test } from './fixtures.ts'
import { ownSuite } from './own-suite.ts'
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

/** A commit in the middle of LINUX's history: on the x-axis, away from its ends. */
async function middleCommit(request: APIRequestContext) {
  const { items } = await json<ListPage<{ value: string }>>(
    request,
    `/api/suites/libcxx/commits?machine=${LINUX}&has_ordinal=true&sort=ordinal&limit=10000`,
  )
  return items[Math.floor(items.length / 2)].value
}

/** The index of `commit` among the points of the chart's first trace. */
function indexOf(page: Page, commit: string) {
  return plotOf(page).evaluate(
    (element, commit) => (element as PlotDiv)._fullData[0].x.indexOf(commit),
    commit,
  )
}

/** The display value of the commit of the point whose `details` are open, from their name. */
async function displayOf(details: Locator) {
  return (await details.getAttribute('aria-label'))!.split(' at ').at(-1)!
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
  // Found with the filter, which then only narrows the table: the test stays drawn under a filter
  // that hides it, and comes back selected once the filter is cleared (GR1).
  const filter = page.getByRole('searchbox', { name: 'Filter tests' })
  await filter.fill(TEST)
  await testBox(page, TEST).check()
  await expect(tracesOf(page)).toHaveCount(1)
  await filter.fill('no test is named so')
  await expect(page.getByText('No tests match the filter.')).toBeVisible()
  await expect(
    page.getByText(
      /^0 of 0 matching tests selected · \d+ tests in total · 1 more hidden by the filter$/,
    ),
  ).toBeVisible()
  await expect(tracesOf(page)).toHaveCount(1)
  await filter.fill('')

  await expect(testBox(page, TEST)).toBeChecked()
  await expect(tracesOf(page)).toHaveCount(1)
  await expect(page).toHaveURL(
    `/graph?suite=libcxx&machine=${LINUX}&metric=execution_time&test=${encodeURIComponent(TEST)}`,
  )
})

test('keeps the x-axis as it is while the data arrives (GR3)', async ({ page, request }) => {
  // The axis spans every commit of both machines, before anything is plotted.
  const commits = new Set<string>()
  for (const machine of [LINUX, MACOS]) {
    const path = `/api/suites/libcxx/commits?machine=${machine}&has_ordinal=true&sort=ordinal&limit=10000`
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

test("shows a point's samples on hover, and keeps them with its details (GR10, GR11)", async ({
  page,
  request,
}) => {
  await page.goto(LINUX_TEST)
  await expect(tracesOf(page)).toHaveCount(1)

  // A point of a single run, whose samples the hover scatter shows (GR10), and that has a point
  // before it to compare with (GR11).
  const { index, commit } = await plotOf(page).evaluate((element) => {
    const [trace] = (element as PlotDiv & { _fullData: { customdata: string[][] }[] })._fullData
    const index = trace.customdata.findIndex(([, , runs], i) => i > 0 && runs === '1 run')
    return { index, commit: String(trace.x[index]) }
  })
  expect(index).toBeGreaterThan(0)
  // Retried, since a series is cut short when any suite's schema changes (E9), as the suites other
  // tests create do.
  let body = ''
  await expect(async () => {
    const response = await request.get('/api/suites/libcxx/series', {
      params: { metric: 'execution_time', machine: LINUX, test: TEST, commit },
    })
    body = await response.text()
    expect(response.status(), body).toBe(200)
  }).toPass()
  // One sample per line (NDJSON).
  const items = body
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { run_uuid: string })
  const samples = items.length
  expect(samples).toBeGreaterThan(1)

  const position = await pointOf(page, 0, index)
  const plotLabel = page.locator('.hoverlayer')
  const circles = page.locator('svg[class*="scatter"] circle')
  // The background of the test's row, which hovering its line highlights (GR7).
  const box = page.getByRole('checkbox', { name: TEST, exact: true })
  const row = table(page, 'Tests').getByRole('row').filter({ has: box })
  const background = () => row.evaluate((element) => getComputedStyle(element).backgroundColor)
  const usual = await background()
  await plotOf(page).hover({ position })
  await expect(plotLabel).toContainText('Click for details')
  await expect(circles).toHaveCount(samples)
  await expect.poll(background).not.toBe(usual)

  await plotOf(page).click({ position })
  const details = page.getByRole('dialog')
  await expect(details).toBeFocused()
  // The details take the place of Plotly's label, which would linger over the samples, and the
  // hover ends with it.
  await expect(plotLabel).not.toContainText('Click for details')
  await expect.poll(background).toBe(usual)
  expect(await details.getAttribute('aria-label')).toMatch(`${TEST} on ${LINUX} at `)
  await expect(details.getByRole('link', { name: LINUX })).toBeVisible()
  const compare = details.getByRole('link', { name: 'Compare with previous commit' })
  await expect(compare).toHaveAttribute('href', /^\/compare\?suite_a=libcxx&machine_a=.*&commit_b=/)
  // The run's samples are on one line: the list scrolls sideways rather than wrap them.
  const samplesCell = details.getByRole('table', { name: 'Runs' }).getByRole('cell').last()
  const lines = await samplesCell.evaluate((cell) => {
    const range = document.createRange()
    range.selectNodeContents(cell)
    return range.getClientRects().length
  })
  expect(lines).toBe(1)

  // The samples stay while the details are open, wherever the pointer is.
  await plotOf(page).hover({ position: { x: 5, y: 5 } })
  await expect(circles).toHaveCount(samples)

  // Hovering one shows its tooltip in place of Plotly's. The sample at the point's value, which is
  // their median, is within the plot whatever its range, and over the point itself: Plotly's label
  // shows beside it.
  await plotOf(page).hover({ position: { x: position.x + 6, y: position.y } })
  await expect(plotLabel).toContainText('Click for details')
  const top = (await plotOf(page).boundingBox())!.y + position.y
  const nearest = await circles.evaluateAll((all, top) => {
    const off = all.map((circle) => Math.abs(circle.getBoundingClientRect().y + 4 - top))
    return off.indexOf(Math.min(...off))
  }, top)
  const median = circles.nth(nearest)
  await median.hover()
  const tip = page.getByRole('tooltip')
  const run = items[0].run_uuid.slice(0, 8)
  await expect(tip.locator('span')).toHaveText([/^\d{4}-\d\d-\d\d, /, `${run}…`, /^Value: \d/])
  await expect(plotLabel).not.toContainText('Click for details')

  // Pressing it leaves the details open, with the focus for Escape to close them, and their links.
  await median.click()
  await expect(details).toBeFocused()

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
  await expect(page.locator('.hoverlayer')).not.toContainText('std::format slowdown')
  await details.getByRole('link', { name: `${uuid.slice(0, 8)}…` }).click()
  await expect(page).toHaveURL(`/suites/libcxx/regressions/${uuid}`)
})

test('creates a regression from a point, and marks it at once (GR11, GR15)', async ({
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
      `/graph?suite=${suite}&machine=m1&metric=execution_time&test=bench&regressions=all`,
    )
    await expect(tracesOf(page)).toHaveCount(1)

    await plotOf(page).click({ position: await pointOf(page, 0, 1) })
    const details = page.getByRole('dialog', { name: 'bench on m1 at c2' })
    await details.getByRole('button', { name: 'Create regression' }).click()
    const title = details.getByRole('textbox', { name: 'Title' })
    await expect(title).toBeFocused()
    await title.fill('bench slowed down')
    await title.press('Enter')
    const link = details.getByRole('status').getByRole('link', { name: 'bench slowed down' })
    await expect(link).toBeFocused()
    const uuid = (await link.getAttribute('href'))!.split('/').at(-1)!
    const created = await json<components['schemas']['RegressionDetail']>(
      request,
      `/api/suites/${suite}/regressions/${uuid}`,
    )
    expect(created).toMatchObject({
      title: 'bench slowed down',
      state: 'detected',
      commit: 'c2',
      indicators: [{ machine: 'm1', test: 'bench', metric: 'execution_time' }],
    })

    // The chart marks it without a reload, which leaves the details open.
    await expect.poll(() => draws(page, `regression ${uuid}`)).toBe(true)
    await expect(details).toBeVisible()
    await link.click()
    await expect(page).toHaveURL(`/suites/${suite}/regressions/${uuid}`)
  })
})

test("shows a test's name as it is in the tooltip, even with Plotly's template syntax (GR10)", async ({
  page,
  request,
  tokenFor,
}, testInfo) => {
  const name = 'fmt/%{x} <&>'
  const run = {
    machine: 'm1',
    commit: 'c1',
    ordinal: 1,
    tests: [{ name, samples: [{ execution_time: 1 }] }],
  }
  await ownSuite(request, tokenFor, testInfo, [run], async (suite) => {
    const query = new URLSearchParams({ suite, machine: 'm1', metric: 'execution_time', test: name })
    await page.goto(`/graph?${query}`)
    await expect(tracesOf(page)).toHaveCount(1)

    await plotOf(page).hover({ position: await pointOf(page, 0, 0) })
    await expect(page.locator('.hoverlayer .hovertext')).toContainText(name)
  })
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

test("adds a baseline from a point's details, which stay open (GR9, GR11)", async ({
  page,
  request,
}) => {
  const commit = await middleCommit(request)
  await page.goto(LINUX_TEST)
  await expect(page.getByText(/^1 of \d+ tests selected$/)).toBeVisible()
  const index = await indexOf(page, commit)
  const yRange = () =>
    plotOf(page).evaluate((element) => (element as PlotDiv)._fullLayout.yaxis.range)
  const before = await yRange()
  const position = await pointOf(page, 0, index)
  await plotOf(page).click({ position })
  const details = page.getByRole('dialog')
  await expect(details).toBeFocused()
  const display = await displayOf(details)
  // Where the details are on the plot, which the chip added moves down the page.
  const placement = async () => {
    const [box, plot] = [(await details.boundingBox())!, (await plotOf(page).boundingBox())!]
    return { x: box.x - plot.x, y: box.y - plot.y }
  }
  const placed = await placement()

  await details.getByRole('button', { name: 'Add as baseline' }).click()

  await expect
    .poll(() => new URL(page.url()).searchParams.get('baseline'))
    .toBe(`libcxx/${LINUX}/${commit}`)
  const chips = page.getByRole('list', { name: 'Baselines added' })
  await expect(chips).toContainText(`libcxx/${LINUX}/${display}`)
  await expect(tracesOf(page)).toHaveCount(2)
  // Its line runs through the point, which stays where it was, and so do its details.
  expect(await yRange()).toEqual(before)
  expect(await placement()).toEqual(placed)
  await expect(details.getByRole('button', { name: 'Remove the baseline' })).toBeFocused()

  // Under its line, once loaded from the URL, the point keeps its tooltip and details, which
  // remove the baseline.
  await page.reload()
  await expect(page.getByText(/^1 of \d+ tests selected$/)).toBeVisible()
  await expect(tracesOf(page)).toHaveCount(2)
  await plotOf(page).hover({ position })
  await expect(page.locator('.hoverlayer')).toContainText('Click for details')
  await plotOf(page).click({ position })
  await details.getByRole('button', { name: 'Remove the baseline' }).click()
  await expect(tracesOf(page)).toHaveCount(1)
  expect(new URL(page.url()).searchParams.has('baseline')).toBe(false)
  await expect(details.getByRole('button', { name: 'Add as baseline' })).toBeFocused()
})

test('highlights a commit with a band of fixed width, circling its point (GR16)', async ({
  page,
  request,
}) => {
  const commit = await middleCommit(request)
  await page.goto(`${LINUX_TEST}&highlight=${commit}`)
  // Named as the trace is, its test name escaped (see client/src/pages/graph/chart.ts).
  const circle = `BM_num_get&lt;void*&gt; - ${LINUX} - highlighted`
  await expect.poll(() => draws(page, circle)).toBe(true)

  const index = await indexOf(page, commit)
  const band = plotOf(page).locator('.shapelayer path')
  // Centred on the point, relative to the plot as pointOf places it, and 12 pixels wide.
  const expectAround = async () => {
    const { x } = await pointOf(page, 0, index)
    const plot = (await plotOf(page).boundingBox())!
    const box = (await band.boundingBox())!
    expect(Math.abs(box.x - plot.x + box.width / 2 - x)).toBeLessThan(1)
    expect(Math.round(box.width)).toBe(12)
  }
  await expectAround()

  // The point keeps its tooltip and details.
  const position = await pointOf(page, 0, index)
  await plotOf(page).hover({ position })
  await expect(page.locator('.hoverlayer')).toContainText('Click for details')
  await plotOf(page).click({ position })
  const details = page.getByRole('dialog')
  await expect(details).toBeFocused()
  const display = await displayOf(details)
  // Its details remove the highlight, and put it back, staying open (GR11).
  await details.getByRole('button', { name: 'Remove the highlight' }).click()
  await expect(band).toHaveCount(0)
  expect(new URL(page.url()).searchParams.has('highlight')).toBe(false)
  await details.getByRole('button', { name: 'Highlight this commit' }).click()
  await expect(band).toHaveCount(1)
  expect(new URL(page.url()).searchParams.get('highlight')).toBe(commit)
  await expect(details.getByRole('button', { name: 'Remove the highlight' })).toBeFocused()
  await page.keyboard.press('Escape')

  // Zoomed in around it, it keeps its width.
  const before = await xRange(page)
  const { x, y } = await pointOf(page, 0, index)
  const plot = (await plotOf(page).boundingBox())!
  await page.mouse.move(plot.x + x - 60, plot.y + y)
  await page.mouse.down()
  await page.mouse.move(plot.x + x + 60, plot.y + y, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => xRange(page)).not.toEqual(before)
  await expectAround()

  const chip = page.getByRole('list', { name: 'Highlighted commits' })
  await expect(chip).toContainText(`Highlighted: ${display}`)
  await chip.getByRole('button', { name: `Remove the highlight of ${display}` }).click()
  await expect(band).toHaveCount(0)
  await expect.poll(() => draws(page, circle)).toBe(false)
  expect(new URL(page.url()).searchParams.has('highlight')).toBe(false)
})
