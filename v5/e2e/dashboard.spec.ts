/**
 * The Dashboard (DA1-DA2), against the seeded history of `libcxx/benchmarks`: tracked machines
 * with a trend on every metric but `peak_memory`, which no run reports, and an untracked one left
 * out, mostly on no branch, and on `release/22.x` for two of them.
 *
 * Other tests create projects of their own, which the Dashboard lists too, so every check is scoped
 * to the section of the project or the suite it is about, which their labels name (AR22).
 */

import type { Locator, Page } from '@playwright/test'
import { suitePath } from '../client/src/paths.ts'
import { HARDENED, LINUX, MACOS, RELEASE_BRANCH, UNTRACKED } from '../tools/synthetic.ts'
import { expect, test } from './fixtures.ts'
import { ownSuite, withOwnSuite, type OwnRun } from './own-suite.ts'
import { plotOf, pointOf, tracesOf } from './plot.ts'
import { openSelect, pickOption, selectButton } from './select.ts'

const LIBCXX_METRICS = [
  'Execution Time',
  'Instructions Retired',
  'Maximum Resident Set Size',
  'Cycles Elapsed',
  'Peak Memory Footprint',
]

/** The section of the project labelled `project`. */
function projectSection(page: Page, project: string) {
  return page.getByRole('main').getByRole('region', { name: project, exact: true })
}

/** The section of the suite labelled `suite`, in that of the project labelled `project`. */
function section(page: Page, project: string, suite: string) {
  return projectSection(page, project).getByRole('region', { name: suite, exact: true })
}

/** The section of `libcxx/benchmarks`. */
function benchmarks(page: Page) {
  return section(page, 'libc++', 'Microbenchmarks')
}

function card(page: Page, name: string) {
  return benchmarks(page).getByRole('article', { name, exact: true })
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

test('draws a trace per tracked machine on each card of libcxx/benchmarks', async ({ page }) => {
  await page.goto('/')

  await expect(benchmarks(page).getByRole('article')).toHaveText(
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

  // On the branch it shows, since the suite has named branches (DA2).
  await expect(card(page, 'Peak Memory Footprint')).toContainText(
    'No machine has a trend for this metric on this branch.',
  )
})

test('asks for the commit range chosen, and keeps it in the URL', async ({ page }) => {
  await page.goto('/')
  await expect(tracesOf(card(page, 'Execution Time'))).not.toHaveCount(0)

  const request = page.waitForRequest(
    (request) =>
      request.url().includes('/api/projects/libcxx/suites/benchmarks/trends?') &&
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

  await expect(page).toHaveURL(/\/graph\?project=libcxx&suite=benchmarks&machine=.*&metric=cycles$/)
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
  await withOwnSuite(request, token, testInfo, async (suite) => {
    const created = await request.post(`/api/projects/${suite.project}/suites`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: suite.suite, metrics: [{ name: 'hash', type: 'text' }] },
    })
    expect(created.status(), await created.text()).toBe(201)

    await page.goto('/')

    // Without display names, the project and the suite are labelled by their names.
    const own = section(page, suite.project, suite.suite)
    await expect(own).toContainText('This suite has no numeric metrics.')
    await expect(own.getByRole('article')).toHaveCount(0)
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
    const own = section(page, suite.project, suite.suite)
    await expect(own).toContainText('This suite shows no metrics on the Dashboard.')
    await expect(own.getByRole('article')).toHaveCount(0)

    await own.getByRole('link', { name: 'its schema', exact: true }).click()
    await expect(page).toHaveURL(`${suitePath(suite)}?tab=schema`)
    await page.getByRole('button', { name: 'Edit schema' }).click()
    const editor = page.getByRole('region', { name: `Editing ${suite.project} › ${suite.suite}` })
    await editor.getByRole('checkbox', { name: 'On the Dashboard of metric compile_time' }).check()
    await editor.getByRole('button', { name: 'Save', exact: true }).first().click()
    await expect(editor).toBeHidden()

    await page.goBack()
    await expect(page).toHaveURL('/')
    await expect(own.getByRole('article')).toHaveText([/^compile_time/])
    await expect(tracesOf(own.getByRole('article'))).toHaveCount(1)
  })
})

test('groups the suites by project, under headings leading to the Projects page', async ({
  page,
}) => {
  await page.goto('/')

  const libcxx = projectSection(page, 'libc++')
  // Each suite under its project's heading by its own label, in AR22's order.
  await expect(libcxx.getByRole('heading', { level: 3 })).toHaveText([
    'Microbenchmarks',
    'header-sizes',
  ])
  await expect(projectSection(page, 'swift')).toContainText('No test suites.')

  // The project's page, which goes to its first suite (TS1).
  await libcxx.getByRole('heading', { level: 2 }).getByRole('link').click()
  await expect(page).toHaveURL('/projects/libcxx/suites/benchmarks')
})

test('shows one project alone, fetching nothing for the others', async ({ page }) => {
  const asked: string[] = []
  page.on('request', (request) => asked.push(new URL(request.url()).pathname))
  await page.goto('/?project=libcxx')

  await expect(selectButton(page, 'Project')).toContainText('libc++')
  await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toHaveText(['libc++'])
  // header-sizes, labelled by its name, has no runs.
  await expect(section(page, 'libc++', 'header-sizes')).toContainText(
    'No tracked machine has runs yet.',
  )
  await expect(tracesOf(card(page, 'Cycles Elapsed'))).toHaveCount(5)
  // Everything asked of a project is asked of libcxx, the list of projects aside.
  const inProjects = asked.filter((path) => path.startsWith('/api/projects/'))
  expect(inProjects).not.toEqual([])
  expect(inProjects.filter((path) => !path.startsWith('/api/projects/libcxx/'))).toEqual([])

  await pickOption(page, 'Project', 'All projects')
  await expect(page).toHaveURL('/')
  await expect(projectSection(page, 'LLVM')).toBeVisible()
})

test('keeps the project picked in the URL, along with the commit range', async ({ page }) => {
  await page.goto('/?range=100&project=libcxx')
  await expect(page.getByRole('button', { name: 'Last 100', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(tracesOf(card(page, 'Execution Time'))).not.toHaveCount(0)

  await pickOption(page, 'Project', 'LLVM')
  await expect(page).toHaveURL('/?range=100&project=llvm')
  await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toHaveText(['LLVM'])
})

test('drops a project that does not exist from the URL', async ({ page }) => {
  await page.goto('/?project=nope')

  await expect(page).toHaveURL('/')
  await expect(selectButton(page, 'Project')).toContainText('All projects')
  await expect(benchmarks(page)).toBeVisible()
})

test('shows a card on the branch picked, and opens the Graph on it', async ({ page }) => {
  await page.goto('/')
  const cycles = card(page, 'Cycles Elapsed')
  await expect(tracesOf(cycles)).toHaveCount(5)
  // The commits without a branch come first (DA2).
  await expect(selectButton(cycles, 'Branch of Cycles Elapsed')).toHaveText(/^No branch/)

  await pickOption(cycles, 'Branch of Cycles Elapsed', RELEASE_BRANCH)

  const entry = `libcxx/benchmarks/cycles/${RELEASE_BRANCH}`
  await expect(page).toHaveURL(`/?branch=${encodeURIComponent(entry)}`)
  // The release branch is measured by two machines only; the other cards stay as they are.
  await expect(tracesOf(cycles)).toHaveCount(2)
  const description = cycles.getByText(/^Latest values: /)
  for (const machine of [LINUX, MACOS]) await expect(description).toContainText(machine)
  const executionTime = card(page, 'Execution Time')
  await expect(selectButton(executionTime, 'Branch of Execution Time')).toHaveText(/^No branch/)
  await expect(tracesOf(executionTime)).toHaveCount(5)

  await cycles.getByRole('link', { name: 'Cycles Elapsed', exact: true }).click()
  await expect(page).toHaveURL(/\/graph\?project=libcxx&suite=benchmarks&branch=release%2F22\.x&/)
  await expect(selectButton(page, 'Branch')).toContainText(RELEASE_BRANCH)

  // Back on the Dashboard, the card shows the branch it did.
  await page.goBack()
  await expect(selectButton(cycles, 'Branch of Cycles Elapsed')).toHaveText(
    new RegExp(`^${RELEASE_BRANCH}`),
  )
  await expect(tracesOf(cycles)).toHaveCount(2)
})

test("does not follow the chart's link when an option over it is picked", async ({ page }) => {
  await page.goto('/')
  const cycles = card(page, 'Cycles Elapsed')
  await expect(tracesOf(cycles)).toHaveCount(5)
  const option = page.getByRole('option', { name: RELEASE_BRANCH, exact: true })
  await openSelect(cycles, 'Branch of Cycles Elapsed', option)
  // The option is drawn over the chart.
  const over = (await option.boundingBox())!
  const chart = (await plotOf(cycles).boundingBox())!
  expect(over.y + over.height / 2).toBeGreaterThan(chart.y)
  expect(over.y + over.height / 2).toBeLessThan(chart.y + chart.height)
  expect(over.x + over.width / 2).toBeGreaterThan(chart.x)
  expect(over.x + over.width / 2).toBeLessThan(chart.x + chart.width)

  await option.click()

  await expect(tracesOf(cycles)).toHaveCount(2)
  expect(new URL(page.url()).pathname).toBe('/')
})

test('shows no branch selector on the cards of a suite without branches', async ({ page }) => {
  await page.goto('/')
  const nts = section(page, 'LLVM', 'nts')
  // Once some card is drawn.
  await expect(tracesOf(nts).first()).toBeAttached()

  await expect(nts.getByRole('button', { name: /Branch of/ })).toHaveCount(0)
})
