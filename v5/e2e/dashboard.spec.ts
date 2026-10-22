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
import { ownSuite, withOwnSuiteName, type OwnRun } from './own-suite.ts'
import { plotOf, pointOf, tracesOf } from './plot.ts'

const LIBCXX_METRICS = [
  'Execution Time',
  'Instructions Retired',
  'Maximum Resident Set Size',
  'Cycles Elapsed',
  'Peak Memory Footprint',
]

function section(page: Page, suite: string) {
  return page.getByRole('main').getByRole('region', { name: suite, exact: true })
}

function card(page: Page, name: string) {
  return section(page, 'libcxx').getByRole('article', { name, exact: true })
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

test('draws a trace per tracked machine on each libcxx card', async ({ page }) => {
  await page.goto('/')

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

  await cycles.getByRole('link', { name: 'Cycles Elapsed', exact: true }).click()

  await expect(page).toHaveURL(/\/graph\?suite=libcxx&machine=.*&metric=cycles$/)
  const machines = machinesOf(page.url())
  expect(machines).toHaveLength(5)
  expect(machines).toEqual(expect.arrayContaining([LINUX, MACOS, HARDENED]))
  expect(machines).not.toContain(UNTRACKED)
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

test('leads from a suite that shows no metric to its schema, where one is chosen', async ({
  page,
  request,
  signIn,
  tokenFor,
}, testInfo) => {
  // Its metrics are numeric, but none is on the Dashboard; its runs give each a trend.
  const run = (commit: string, ordinal: number): OwnRun => ({
    machine: 'm1',
    commit,
    ordinal,
    tests: [{ name: 'bench', samples: [{ execution_time: ordinal, compile_time: 0.5 }] }],
  })
  await ownSuite(request, tokenFor, testInfo, [run('c1', 1), run('c2', 2)], async (suite) => {
    await signIn(page, 'manage')
    await page.goto('/')
    const own = section(page, suite)
    await expect(own).toContainText('No metric of this suite is shown on the Dashboard.')
    await expect(own.getByRole('article')).toHaveCount(0)

    await own.getByRole('link', { name: 'its schema', exact: true }).click()
    await expect(page).toHaveURL(`/admin?tab=suites&suite=${suite}`)
    await page.getByRole('button', { name: 'Edit schema' }).click()
    const editor = page.getByRole('region', { name: `Editing ${suite}` })
    await editor.getByRole('checkbox', { name: 'On the Dashboard of metric compile_time' }).check()
    await editor.getByRole('button', { name: 'Save', exact: true }).first().click()
    await expect(editor).toBeHidden()

    await page.goBack()
    await expect(page).toHaveURL('/')
    await expect(own.getByRole('article')).toHaveText([/^compile_time/])
    await expect(tracesOf(own.getByRole('article'))).toHaveCount(1)
  })
})
