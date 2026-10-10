/**
 * The Regression Detail page (DT4).
 *
 * Reading tests use the seeded libcxx regressions (tools/synthetic.ts). Tests that write use a
 * suite of their own (see own-suite.ts).
 */

import type { APIRequestContext, Page } from '@playwright/test'
import type { components } from '../client/src/api/schema.d.ts'
import { uuidFor } from '../tools/synthetic.ts'
import { expect, json, test } from './fixtures.ts'
import { ownSuite, type OwnRun } from './own-suite.ts'
import { pickOption } from './select.ts'
import { rows, table } from './tables.ts'

type RegressionDetail = components['schemas']['RegressionDetail']

const FORMAT = uuidFor('libcxx/regression/format')

/** Create a regression in `suite` from `data`, with `token`; returns its UUID. */
async function createRegression(
  request: APIRequestContext,
  suite: string,
  token: string,
  data: components['schemas']['RegressionCreate'],
): Promise<string> {
  const created = await request.post(`/api/suites/${suite}/regressions`, {
    headers: { Authorization: `Bearer ${token}` },
    data,
  })
  expect(created.status(), await created.text()).toBe(201)
  return ((await created.json()) as RegressionDetail).uuid
}

function info(page: Page) {
  return page.getByRole('group', { name: 'Regression', exact: true })
}

test('shows the regression, with links to its bug and its commit', async ({ page, request }) => {
  const regression = await json<RegressionDetail>(
    request,
    `/api/suites/libcxx/regressions/${FORMAT}`,
  )
  await page.goto(`/suites/libcxx/regressions/${FORMAT}`)

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Regression: std::format slowdown',
  )
  await expect(info(page)).toContainText('About 15% slower on every machine, std::format only.')
  await expect(page.getByRole('button', { name: /active State$/ })).toBeVisible()
  const bug = info(page).getByRole('link', { name: 'https://example.com/bugs/1001' })
  await expect(bug).toHaveAttribute('target', '_blank')
  // The commit's link shows its display value, and leads to its page.
  const commit = info(page).getByRole('link', { name: /^r\d+/ })
  await expect(commit).toHaveAttribute('href', `/suites/libcxx/commits/${regression.commit}`)
})

test('cannot be changed without a token', async ({ page }) => {
  await page.goto(`/suites/libcxx/regressions/${FORMAT}`)
  await expect(info(page)).toBeVisible()

  for (const field of ['Title', 'Bug', 'Commit', 'Notes']) {
    await expect(page.getByRole('button', { name: `Edit ${field}` })).toBeDisabled()
  }
  await expect(page.getByRole('button', { name: /State$/ })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Delete regression' })).toBeDisabled()
})

/** Commits `c1` and `c2`, ordered, with a run of the machine `m1` each. */
const RUNS: OwnRun[] = [1, 2].map((ordinal) => ({
  machine: 'm1',
  commit: `c${ordinal}`,
  ordinal,
  tests: [{ name: 'bench' }],
}))

test('every field is edited by a holder of triage scope', async ({
  page,
  request,
  tokenFor,
  signIn,
}, testInfo) => {
  await ownSuite(request, tokenFor, testInfo, RUNS, async (suite) => {
    const token = await signIn(page, 'triage')
    const uuid = await createRegression(request, suite, token, { title: 'Slow', commit: 'c1' })
    await page.goto(`/suites/${suite}/regressions/${uuid}`)

    await page.getByRole('button', { name: 'Edit Title' }).click()
    await page.getByRole('textbox', { name: 'Title' }).fill(' Slower ')
    await page.getByRole('textbox', { name: 'Title' }).press('Enter')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Regression: Slower')

    await page.getByRole('button', { name: 'Edit Bug' }).click()
    await page.getByRole('textbox', { name: 'Bug' }).fill('https://bugs.example/7')
    await page.getByRole('textbox', { name: 'Bug' }).press('Enter')
    await expect(info(page).getByRole('link', { name: 'https://bugs.example/7' })).toBeVisible()

    await pickOption(info(page), 'State', 'fixed')
    await expect(page.getByRole('button', { name: /fixed State$/ })).toBeVisible()

    await page.getByRole('button', { name: 'Edit Commit' }).click()
    const picker = page.getByRole('combobox', { name: 'Commit' })
    await expect(picker).toBeFocused()
    await picker.fill('c2')
    await page.getByRole('option', { name: 'c2', exact: true }).click()
    // The list closes just after the pick, and until then takes Enter for itself.
    await expect(picker).toHaveAttribute('aria-expanded', 'false')
    await picker.press('Enter')
    await expect(info(page).getByRole('link', { name: 'c2' })).toBeVisible()

    await page.getByRole('button', { name: 'Edit Notes' }).click()
    const notes = page.getByRole('textbox', { name: 'Notes' })
    await notes.fill('Bisected.')
    await notes.press('Enter')
    await notes.pressSequentially('Only on m1.')
    await notes.press('ControlOrMeta+Enter')
    await expect(notes).toHaveCount(0)
    // Shown with its line break: the rendered text keeps it, unlike the text content.
    expect(await info(page).innerText()).toContain('Bisected.\nOnly on m1.')

    const stored = await json<RegressionDetail>(request, `/api/suites/${suite}/regressions/${uuid}`)
    expect(stored).toMatchObject({
      title: 'Slower',
      bug: 'https://bugs.example/7',
      state: 'fixed',
      commit: 'c2',
      notes: 'Bisected.\nOnly on m1.',
    })
  })
})

test('deleting a regression shows the regressions left', async ({
  page,
  request,
  tokenFor,
  signIn,
}, testInfo) => {
  await ownSuite(request, tokenFor, testInfo, RUNS, async (suite) => {
    const token = await signIn(page, 'triage')
    await createRegression(request, suite, token, { title: 'Kept' })
    const uuid = await createRegression(request, suite, token, { title: 'Deleted' })
    await page.goto(`/suites/${suite}/regressions/${uuid}`)

    await page.getByRole('button', { name: 'Delete regression' }).click()
    await page.getByLabel(/to confirm/).fill(uuid.slice(0, 8))
    await page.getByRole('button', { name: 'Delete', exact: true }).click()

    await expect(page).toHaveURL(`/suites/${suite}?tab=regressions`)
    const list = table(page, 'Regressions')
    await expect(rows(list)).toHaveCount(1)
    await expect(list).toContainText('Kept')
    expect((await request.get(`/api/suites/${suite}/regressions/${uuid}`)).status()).toBe(404)
  })
})

/** Tests `t1` to `t4`, measured on the machines `m1` and `m2`, at one commit each. */
const MEASURED: OwnRun[] = ['m1', 'm2'].map((machine, i) => ({
  machine,
  commit: `c${i + 1}`,
  ordinal: i + 1,
  tests: [1, 2, 3, 4].map((n) => ({ name: `t${n}`, execution_time: n })),
}))

test('indicators are added across machines, filtered and removed', async ({
  page,
  request,
  tokenFor,
  signIn,
}, testInfo) => {
  await ownSuite(request, tokenFor, testInfo, MEASURED, async (suite) => {
    const token = await signIn(page, 'triage')
    const uuid = await createRegression(request, suite, token, { title: 'Slow' })
    await page.goto(`/suites/${suite}/regressions/${uuid}`)
    const panel = page.getByRole('region', { name: 'Add indicators' })
    const box = (name: string) => panel.getByRole('checkbox', { name, exact: true })

    await box('Select all machines shown').click()
    await expect(panel.getByRole('group', { name: /^Tests/ })).toContainText('0 of 4 tests')
    // Ranges selected and deselected with Shift held, by mouse and from the keyboard, on both
    // machines: t1 to t3, then t1 alone, then all four.
    const preview = panel.getByRole('status').first()
    await box('t1').click()
    await box('t3').click({ modifiers: ['Shift'] })
    await expect(preview).toHaveText('This will add 6 indicators.')
    await box('t2').click({ modifiers: ['Shift'] })
    await expect(preview).toHaveText('This will add 2 indicators.')
    await box('t4').focus()
    await page.keyboard.press('Shift+Space')
    await expect(preview).toHaveText('This will add 8 indicators.')
    await panel.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(panel.getByText('Added 8 indicators.')).toBeVisible()

    const indicators = table(page, 'Indicators')
    await expect(rows(indicators)).toHaveCount(8)
    await page.getByRole('searchbox', { name: 'Filter indicators' }).fill('m2')
    await expect(rows(indicators)).toHaveCount(4)
    await expect(page).toHaveURL(`/suites/${suite}/regressions/${uuid}?indicator_filter=m2`)
    await page.getByRole('checkbox', { name: 'Select all indicators shown' }).click()
    await page.getByRole('button', { name: 'Remove 4 selected' }).click()
    await expect(indicators).toContainText('No indicators match the filter.')

    await page.getByRole('searchbox', { name: 'Filter indicators' }).fill('')
    await expect(rows(indicators)).toHaveCount(4)
    await page.getByRole('button', { name: 'Remove m1, t1, execution_time' }).click()
    await expect(rows(indicators)).toHaveCount(3)
    await expect(page.getByRole('button', { name: 'Remove m1, t2, execution_time' })).toBeFocused()

    const stored = await json<RegressionDetail>(request, `/api/suites/${suite}/regressions/${uuid}`)
    expect(stored.indicators.map(({ machine, test }) => `${machine}/${test}`)).toEqual([
      'm1/t2',
      'm1/t3',
      'm1/t4',
    ])
  })
})

/**
 * Tests measured on `m1` and `m2`, which share only `shared`, with a compile time on `m1` alone
 * for `built`.
 */
const DIFFERENT: OwnRun[] = [
  {
    machine: 'm1',
    commit: 'c1',
    ordinal: 1,
    tests: [
      { name: 'shared', execution_time: 1 },
      { name: 'only-m1', execution_time: 2 },
      { name: 'built', execution_time: 3, compile_time: 4 },
    ],
  },
  {
    machine: 'm2',
    commit: 'c2',
    ordinal: 2,
    tests: [
      { name: 'shared', execution_time: 1 },
      { name: 'only-m2', execution_time: 2 },
    ],
  },
]

test('the tests offered are those of the machines selected, on the metric selected', async ({
  page,
  request,
  tokenFor,
  signIn,
}, testInfo) => {
  await ownSuite(request, tokenFor, testInfo, DIFFERENT, async (suite) => {
    const token = await signIn(page, 'triage')
    const uuid = await createRegression(request, suite, token, { title: 'Slow' })
    await page.goto(`/suites/${suite}/regressions/${uuid}`)
    const panel = page.getByRole('region', { name: 'Add indicators' })
    const tests = panel.getByRole('table', { name: 'Tests' })
    const names = () => rows(tests).allTextContents()

    await panel.getByRole('checkbox', { name: 'm1', exact: true }).click()
    await expect.poll(names).toEqual(['built', 'only-m1', 'shared'])
    await panel.getByRole('checkbox', { name: 'm2', exact: true }).click()
    await expect.poll(names).toEqual(['built', 'only-m1', 'only-m2', 'shared'])

    // Only `built` has a compile time, on `m1`.
    await pickOption(panel, 'Metric', 'compile_time')
    await expect.poll(names).toEqual(['built'])
    await tests.getByRole('checkbox', { name: 'built', exact: true }).click()
    await panel.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(panel.getByText('Added 2 indicators.')).toBeVisible()

    // The one on `m1` leads to the Graph page.
    const graph = rows(table(page, 'Indicators'))
      .filter({ hasText: 'm1' })
      .getByRole('link', { name: 'View on graph' })
    await expect(graph).toHaveAttribute(
      'href',
      `/graph?suite=${suite}&machine=m1&metric=compile_time&test=built&regressions=all`,
    )
    await graph.click()
    await expect(page).toHaveURL(/^[^?]*\/graph\?/)
  })
})
