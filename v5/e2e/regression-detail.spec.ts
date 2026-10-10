/**
 * The Regression Detail page (DT4).
 *
 * Reading tests use the seeded libcxx regressions (tools/synthetic.ts). Tests that write use a
 * suite of their own (see own-suite.ts).
 */

import type { Page } from '@playwright/test'
import type { components } from '../client/src/api/schema.d.ts'
import { uuidFor } from '../tools/synthetic.ts'
import { expect, json, test } from './fixtures.ts'
import { ownSuite, type OwnRun } from './own-suite.ts'
import { pickOption } from './select.ts'
import { rows, table } from './tables.ts'

type RegressionDetail = components['schemas']['RegressionDetail']

const FORMAT = uuidFor('libcxx/regression/format')

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
    const created = await request.post(`/api/suites/${suite}/regressions`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { title: 'Slow', commit: 'c1' },
    })
    expect(created.status(), await created.text()).toBe(201)
    const { uuid } = (await created.json()) as RegressionDetail
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
    const uuids: string[] = []
    for (const title of ['Kept', 'Deleted']) {
      const created = await request.post(`/api/suites/${suite}/regressions`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { title },
      })
      expect(created.status(), await created.text()).toBe(201)
      uuids.push(((await created.json()) as RegressionDetail).uuid)
    }
    const uuid = uuids[1]
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
