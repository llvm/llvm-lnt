/**
 * The Dashboard (DA1-DA2), against the seeded libcxx history: tracked machines with a trend on
 * every metric but `peak_memory`, which no run reports, and an untracked one left out.
 *
 * Other tests create suites of their own, which the Dashboard lists too, so every check is scoped
 * to the section of the suite it is about.
 */

import type { Locator, Page } from '@playwright/test'
import { HARDENED, LINUX, MACOS, UNTRACKED } from '../tools/synthetic.ts'
import { expect, test } from './fixtures.ts'
import { withOwnSuiteName } from './own-suite.ts'

const LIBCXX_METRICS = [
  'Execution Time',
  'Instructions Retired',
  'Maximum Resident Set Size',
  'Cycles Elapsed',
  'Peak Memory Footprint',
]

/**
 * The parts of a Plotly plot that place its points on the page. They are Plotly internals, but the
 * only way to find where a given point is drawn: the SVG holds each trace as one path, without its
 * points, and a hover label only shows once the pointer is within a few pixels of one.
 */
interface PlotDiv extends HTMLElement {
  _fullLayout: {
    _size: { l: number; t: number }
    xaxis: { l2p(value: number): number }
    yaxis: { l2p(value: number): number }
  }
  _fullData: { x: number[]; y: number[] }[]
}

function section(page: Page, suite: string) {
  return page.getByRole('main').getByRole('region', { name: suite, exact: true })
}

function card(page: Page, name: string) {
  return section(page, 'libcxx').getByRole('article', { name, exact: true })
}

/** The plot of `card`'s chart, once Plotly has drawn it. */
function plotOf(card: Locator) {
  return card.locator('.js-plotly-plot')
}

/** The lines `card`'s chart draws, one per machine. */
function tracesOf(card: Locator) {
  return card.locator('.scatterlayer .trace')
}

/**
 * Where in its plot the `index`th point of the `curve`th trace of `card`'s chart is drawn: relative
 * to the plot rather than to the page, so that acting there through the plot's locator finds the
 * point wherever the plot is, as other tests' suites load above libcxx and push it down.
 */
async function pointOf(card: Locator, curve: number, index: number) {
  return plotOf(card).evaluate(
    (element, [curve, index]) => {
      const plot = element as PlotDiv
      const { _size, xaxis, yaxis } = plot._fullLayout
      const trace = plot._fullData[curve]
      return { x: _size.l + xaxis.l2p(trace.x[index]), y: _size.t + yaxis.l2p(trace.y[index]) }
    },
    [curve, index],
  )
}

/**
 * Hover the `index`th point of the `curve`th trace of `card`'s chart, until its hover label shows.
 * Returns where the point is in the plot, the label, and the machine the label names first.
 */
async function hover(card: Locator, curve: number, index: number) {
  const point = await pointOf(card, curve, index)
  await plotOf(card).hover({ position: point })
  const label = card.locator('.hoverlayer .hovertext')
  await expect(label).toBeVisible()
  const machine = await label.locator('tspan.line').first().textContent()
  expect(machine).toBeTruthy()
  return { point, label, machine: machine! }
}

/** The machines a Graph URL names, in order. */
function machinesOf(url: string) {
  return new URL(url).searchParams.getAll('machine')
}

test('draws a trace per machine of the key, which holds the tracked machines', async ({ page }) => {
  await page.goto('/')

  const key = section(page, 'libcxx').getByRole('list', { name: 'Machines' })
  await expect(key.getByRole('listitem')).toHaveCount(5)
  for (const machine of [LINUX, MACOS, HARDENED]) await expect(key).toContainText(machine)
  await expect(key).not.toContainText(UNTRACKED)

  await expect(section(page, 'libcxx').getByRole('article')).toHaveText(
    LIBCXX_METRICS.map((name) => new RegExp(`^${name}`)),
  )
  // The real machines measured every commit of the window; the others, only a few.
  await expect(tracesOf(card(page, 'Cycles Elapsed'))).toHaveCount(5)
  const description = card(page, 'Cycles Elapsed').getByText(/^Latest values: /)
  for (const machine of [LINUX, MACOS, HARDENED]) await expect(description).toContainText(machine)
  await expect(description).not.toContainText(UNTRACKED)

  // Hovering a point shows its machine, its commit and its value, with the metric's unit.
  const { label } = await hover(card(page, 'Cycles Elapsed'), 0, 3)
  await expect(label).toContainText(/ cycles$/)
})

test('says that no machine has a trend for peak_memory', async ({ page }) => {
  await page.goto('/')

  await expect(card(page, 'Peak Memory Footprint')).toContainText(
    'No machine has a trend for this metric.',
  )
})

test('asks for the commit range chosen, and keeps it in the URL', async ({ page }) => {
  await page.goto('/')
  await expect(tracesOf(card(page, 'Execution Time'))).not.toHaveCount(0)

  const request = page.waitForRequest(
    (request) =>
      request.url().includes('/api/suites/libcxx/trends?') &&
      new URL(request.url()).searchParams.get('last_n') === '100',
  )
  await page.getByRole('button', { name: 'Last 100', exact: true }).click()
  await request

  await expect(page).toHaveURL('/?range=100')
  await expect(page.getByRole('button', { name: 'Last 100', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(tracesOf(card(page, 'Execution Time'))).not.toHaveCount(0)
})

test("opens the Graph with a card's machines from its title", async ({ page }) => {
  await page.goto('/')
  const cycles = card(page, 'Cycles Elapsed')
  await expect(tracesOf(cycles)).toHaveCount(5)
  const key = await section(page, 'libcxx').getByRole('listitem').allTextContents()

  await cycles.getByRole('link', { name: 'Cycles Elapsed', exact: true }).click()

  await expect(page).toHaveURL(/\/graph\?suite=libcxx&machine=.*&metric=cycles$/)
  expect(machinesOf(page.url())).toEqual(key)
})

test('opens the Graph with the machine of the trace clicked', async ({ page }) => {
  await page.goto('/')
  const cycles = card(page, 'Cycles Elapsed')
  await expect(tracesOf(cycles)).toHaveCount(5)
  const { point, machine } = await hover(cycles, 1, 5)

  await plotOf(cycles).click({ position: point })

  await expect(page).toHaveURL(/\/graph\?/)
  expect(machinesOf(page.url())).toEqual([machine])
})

/**
 * The clicks that open a link in a new page, which reach the chart's link differently: Plotly lets
 * the browser's own click through when Control is held, and otherwise sends the link a click of its
 * own. The modified click is the platform's: Control, except Command on macOS, where a
 * Control-click opens the context menu instead.
 */
const NEW_PAGE_CLICKS: [string, Parameters<Locator['click']>[0]][] = [
  ['a modified click', { modifiers: ['ControlOrMeta'] }],
  ['a middle click', { button: 'middle' }],
]

for (const [how, click] of NEW_PAGE_CLICKS) {
  test(`opens the Graph in a new page on ${how} on a trace (AR2)`, async ({ page, context }) => {
    await page.goto('/')
    const cycles = card(page, 'Cycles Elapsed')
    await expect(tracesOf(cycles)).toHaveCount(5)
    const { point, machine } = await hover(cycles, 1, 5)

    const opened = context.waitForEvent('page')
    await plotOf(cycles).click({ position: point, ...click })
    const graph = await opened

    await expect(graph).toHaveURL(/\/graph\?/)
    expect(machinesOf(graph.url())).toEqual([machine])
    await expect(page).toHaveURL('/')
  })
}

test('says that a suite has no numeric metrics', async ({
  page,
  request,
  tokenFor,
}, testInfo) => {
  const token = await tokenFor('manage')
  await withOwnSuiteName(request, token, testInfo, async (suite) => {
    const created = await request.post('/api/suites', {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: suite, metrics: [{ name: 'hash', type: 'text' }] },
    })
    expect(created.status(), await created.text()).toBe(201)

    await page.goto('/')

    await expect(section(page, suite)).toContainText('This suite has no numeric metrics.')
    await expect(section(page, suite).getByRole('article')).toHaveCount(0)
  })
})
