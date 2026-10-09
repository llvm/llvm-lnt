/**
 * The Regressions tab of the Test Suites page (TS5), against the seeded libcxx regressions
 * (tools/synthetic.ts).
 *
 * Other tests may add regressions to the suite, so these look for what the seed holds rather than
 * assuming that it is all there is. Those this file creates have unique titles and no indicators,
 * so that no machine or metric filter ever matches them, and are deleted by the test creating them.
 */

import type { APIRequestContext, TestInfo } from '@playwright/test'
import type { components } from '../client/src/api/schema.d.ts'
import { HARDENED, TAG, uuidFor } from '../tools/synthetic.ts'
import { adminToken, expect, test } from './fixtures.ts'
import { column, rows, settled, table } from './tables.ts'

type RegressionDetail = components['schemas']['RegressionDetail']

/** The index of each column of the regression table that these tests read. */
const COLUMN = { uuid: 0, title: 1, state: 2, commit: 3, machines: 4 }

/** A title no other test uses. */
function uniqueTitle(testInfo: TestInfo): string {
  return `e2e ${testInfo.testId} ${Date.now()}`
}

async function deleteRegression(request: APIRequestContext, uuid: string) {
  await request.delete(`/api/suites/libcxx/regressions/${uuid}`, {
    headers: { Authorization: `Bearer ${adminToken()}` },
  })
}

/** Delete the regressions titled `title`, whichever of a test's steps created them. */
async function deleteRegressionsTitled(request: APIRequestContext, title: string) {
  const response = await request.get('/api/suites/libcxx/regressions', {
    params: { search: title, limit: 100 },
  })
  const { items } = (await response.json()) as components['schemas']['RegressionCursorPage']
  for (const regression of items.filter((item) => item.title === title)) {
    await deleteRegression(request, regression.uuid)
  }
}

test.describe('filtering', () => {
  test('by state', async ({ page }) => {
    await page.goto('/suites/libcxx?tab=regressions')
    const list = table(page, 'Regressions')
    await expect(rows(list).first()).toBeVisible()

    const chips = page.getByRole('group', { name: 'State' })
    await chips.getByRole('button', { name: 'fixed', exact: true }).click()

    await expect(page).toHaveURL('/suites/libcxx?tab=regressions&state=fixed')
    await settled(list)
    await expect.poll(() => column(list, COLUMN.state)).toEqual(['fixed'])
    await expect(rows(list).first().locator('td').nth(COLUMN.title)).toHaveText(
      'filesystem::path construction regressed on macOS',
    )
  })

  test('by machine, picked through its combobox', async ({ page }) => {
    await page.goto('/suites/libcxx?tab=regressions')
    const list = table(page, 'Regressions')

    const machine = page.getByRole('combobox', { name: 'Machine' })
    await machine.fill('hardenedfast')
    await page.getByRole('option', { name: HARDENED }).click()

    await expect(page).toHaveURL(`/suites/libcxx?tab=regressions&machine=${HARDENED}`)
    await settled(list)
    await expect
      .poll(async () => new Set(await column(list, COLUMN.title)))
      .toEqual(
        new Set([
          'std::format slowdown',
          'Everything slower in hardened mode',
          'dynamic_cast_(Chain,_1_level) jumps around',
          'Hardening overhead in std::find_if',
        ]),
      )
  })

  test('by metric, and by commit', async ({ page }) => {
    await page.goto('/suites/libcxx?tab=regressions')
    const list = table(page, 'Regressions')

    // Only the std::format regression has indicators on `cycles`.
    await page.getByLabel('Metric').selectOption({ label: 'Cycles Elapsed' })
    await expect(page).toHaveURL('/suites/libcxx?tab=regressions&metric=cycles')
    await settled(list)
    await expect.poll(() => column(list, COLUMN.title)).toEqual(['std::format slowdown'])
    await expect(rows(list).first().locator('td').nth(COLUMN.commit)).toHaveText(/^r\d+$/)

    await page.getByLabel('Metric').selectOption({ label: 'Any metric' })
    await page.getByLabel('No commit set').check()
    await expect(page).toHaveURL('/suites/libcxx?tab=regressions&has_commit=false')
    await settled(list)
    await expect.poll(() => column(list, COLUMN.title)).toContain('(untitled)')
    expect(new Set(await column(list, COLUMN.commit))).toEqual(new Set(['--']))
  })

  test('a deep link restores the filters', async ({ page }) => {
    await page.goto(`/suites/libcxx?tab=regressions&state=active&machine=${HARDENED}`)

    await expect(page.getByRole('button', { name: 'active', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(page.getByRole('combobox', { name: 'Machine' })).toHaveValue(HARDENED)
    await expect
      .poll(async () => new Set(await column(table(page, 'Regressions'), COLUMN.title)))
      .toEqual(new Set(['std::format slowdown', 'Everything slower in hardened mode']))
  })
})

test.describe('searching', () => {
  // The seed derives its regressions' UUIDs from their names (tools/synthetic.ts).
  for (const [name, title] of [
    ['format', 'std::format slowdown'],
    ['untitled', '(untitled)'],
  ]) {
    test(`finds the ${name} regression by a prefix of its UUID`, async ({ page }) => {
      const uuid = uuidFor(`libcxx/regression/${name}`)
      const prefix = uuid.slice(0, 8)
      await page.goto('/suites/libcxx?tab=regressions')
      const list = table(page, 'Regressions')
      await expect(rows(list).first()).toBeVisible()

      await page
        .getByRole('searchbox', { name: 'Search regressions by title or UUID prefix' })
        .fill(prefix)

      await expect(page).toHaveURL(`/suites/libcxx?tab=regressions&search=${prefix}`)
      await settled(list)
      await expect.poll(() => column(list, COLUMN.title)).toContain(title)
      const row = rows(list).filter({ hasText: title }).first()
      await expect(row.locator('td').nth(COLUMN.uuid)).toHaveText(`${prefix}…`)
      await row.locator('td').nth(COLUMN.title).click()
      await expect(page).toHaveURL(`/suites/libcxx/regressions/${uuid}`)
    })
  }

  test('finds a regression by the UUID prefix its row shows', async ({ page }) => {
    await page.goto('/suites/libcxx?tab=regressions')
    const list = table(page, 'Regressions')
    const link = rows(list).first().locator('td').nth(COLUMN.uuid).getByRole('link')
    await expect(link).toHaveText(/^[0-9a-f]{8}…$/)
    const shown = (await link.textContent())!
    const uuid = (await link.getAttribute('title'))!
    expect(uuid.startsWith(shown.replace('…', ''))).toBe(true)
    await expect(link).toHaveAttribute('href', `/suites/libcxx/regressions/${uuid}`)

    await page
      .getByRole('searchbox', { name: 'Search regressions by title or UUID prefix' })
      .fill(shown.replace('…', ''))

    await settled(list)
    await expect.poll(() => column(list, COLUMN.uuid)).toContain(shown)
    await list.getByRole('link', { name: shown, exact: true }).click()
    await expect(page).toHaveURL(`/suites/libcxx/regressions/${uuid}`)
  })
})

test('a click on a row opens the regression', async ({ page }) => {
  await page.goto('/suites/libcxx?tab=regressions&state=fixed')
  const row = rows(table(page, 'Regressions')).first()
  await expect(row).toContainText('filesystem::path')

  await row.locator('td').nth(COLUMN.machines).click()

  await expect(page).toHaveURL(/^.*\/suites\/libcxx\/regressions\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Regression Detail')
})

test('creating and deleting are disabled without a token', async ({ page }) => {
  await page.goto('/suites/libcxx?tab=regressions')
  await expect(rows(table(page, 'Regressions')).first()).toBeVisible()

  const create = page.getByRole('button', { name: 'New Regression' })
  await expect(create).toBeDisabled()
  await expect(create).toHaveAttribute('title', /'triage' scope/)
  const firstRow = rows(table(page, 'Regressions')).first()
  await expect(firstRow.getByRole('button', { name: /Delete/ })).toBeDisabled()
})

test('creates a regression with a commit picked through the picker', async ({
  page,
  request,
  signIn,
}, testInfo) => {
  await signIn(page, 'triage')
  const title = uniqueTitle(testInfo)
  try {
    await page.goto('/suites/libcxx?tab=regressions')

    const create = page.getByRole('button', { name: 'New Regression' })
    await expect(create).toBeEnabled()
    await create.click()
    const form = page.getByRole('form', { name: 'New regression' })
    await form.getByLabel('Title').fill(title)
    await form.getByLabel('State').selectOption('active')
    const picker = form.getByRole('combobox', { name: 'Commit' })
    // The tag is searched, and only one commit has it.
    await picker.fill(TAG)
    const suggestion = page.getByRole('option', { name: new RegExp(`^r\\d+ \\(${TAG}\\)$`) })
    await suggestion.click()
    await expect(picker).toHaveValue(new RegExp(`\\(${TAG}\\)$`))
    await form.getByRole('button', { name: 'Create' }).click()

    await expect(page).toHaveURL(/\/suites\/libcxx\/regressions\/[0-9a-f-]{36}$/)
    const uuid = page.url().split('/').at(-1)!
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Regression Detail')
    const created = (await (
      await request.get(`/api/suites/libcxx/regressions/${uuid}`)
    ).json()) as RegressionDetail
    expect(created).toMatchObject({ title, state: 'active' })
    const commit = await (await request.get(`/api/suites/libcxx/commits/${created.commit}`)).json()
    expect(commit.tag).toBe(TAG)
  } finally {
    await deleteRegressionsTitled(request, title)
  }
})

test.describe('the commit picker', () => {
  test.beforeEach(async ({ page, signIn }) => {
    await signIn(page, 'triage')
    await page.goto('/suites/libcxx?tab=regressions')
    await page.getByRole('button', { name: 'New Regression' }).click()
  })

  test('picks nothing on Enter for text that is not a commit', async ({ page }) => {
    const form = page.getByRole('form', { name: 'New regression' })
    const picker = form.getByRole('combobox', { name: 'Commit' })

    // A substring of many commits, which the picker lists, but not a commit itself.
    await picker.fill('r55')
    await expect(page.getByRole('listbox').getByRole('option').first()).toBeVisible()
    await picker.press('Enter')
    await expect(picker).toHaveValue('r55')
    await expect(page.getByRole('listbox')).toBeVisible()

    // Leaving it puts back the text of its value, which is none.
    await form.getByLabel('Title').click()
    await expect(picker).toHaveValue('')
  })

  test('creates nothing while it holds text that was not picked', async ({ page, request }) => {
    const form = page.getByRole('form', { name: 'New regression' })
    const picker = form.getByRole('combobox', { name: 'Commit' })
    const title = `e2e unpicked commit ${Date.now()}`
    try {
      await form.getByLabel('Title').fill(title)

      await picker.fill('r55')
      const create = form.getByRole('button', { name: 'Create', includeHidden: true })
      await expect(create).toBeDisabled()
      const reason = 'Pick a commit from the list, or clear the field.'
      await expect(form.getByText(reason)).toBeVisible()
      await expect(create).toHaveAccessibleDescription(reason)

      // A click on Create keeps the focus, and so the text, in the picker, and creates nothing.
      // The mouse is driven directly: Playwright's own click waits for the button to be enabled.
      const box = (await create.boundingBox())!
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await page.waitForTimeout(500)
      await expect(picker).toHaveValue('r55')
      await expect(picker).toBeFocused()
      await expect(create).toBeDisabled()
      await expect(page).toHaveURL(/tab=regressions/)
      const found = await request.get('/api/suites/libcxx/regressions', {
        params: { search: title },
      })
      expect(((await found.json()) as { items: unknown[] }).items).toEqual([])
    } finally {
      await deleteRegressionsTitled(request, title)
    }
  })

  test('picks a commit entered by its commit string', async ({ page, request }) => {
    const form = page.getByRole('form', { name: 'New regression' })
    const picker = form.getByRole('combobox', { name: 'Commit' })
    const response = await request.get('/api/suites/libcxx/commits', {
      params: { search: TAG, limit: 1 },
    })
    const [tagged] = ((await response.json()) as components['schemas']['CommitCursorPage']).items

    await picker.fill(tagged.value)
    await picker.press('Enter')

    await expect(picker).toHaveValue(new RegExp(`\\(${TAG}\\)$`))
    await expect(page.getByRole('listbox')).toHaveCount(0)
  })

  test('loads more commits when its list is scrolled to the end', async ({ page }) => {
    const form = page.getByRole('form', { name: 'New regression' })
    // React Aria closes the list when the page scrolls, as reaching the button would.
    await form.scrollIntoViewIfNeeded()
    await form.getByRole('button', { name: /Show suggestions/ }).click()
    const options = page.getByRole('listbox').getByRole('option')
    await expect(options).toHaveCount(25)

    await options.nth(24).scrollIntoViewIfNeeded()

    await expect.poll(() => options.count()).toBeGreaterThan(25)
  })
})

test('deletes a regression, confirmed by its UUID', async ({ page, request, signIn }, testInfo) => {
  const title = uniqueTitle(testInfo)
  const response = await request.post('/api/suites/libcxx/regressions', {
    headers: { Authorization: `Bearer ${adminToken()}` },
    data: { title },
  })
  expect(response.status(), await response.text()).toBe(201)
  const { uuid } = (await response.json()) as RegressionDetail
  try {
    await signIn(page, 'triage')
    await page.goto(`/suites/libcxx?tab=regressions&search=${encodeURIComponent(title)}`)
    const list = table(page, 'Regressions')
    await expect.poll(() => column(list, COLUMN.title)).toEqual([title])

    await rows(list).first().getByRole('button', { name: /Delete/ }).click()
    const prompt = page.getByRole('form', { name: 'Confirmation' })
    await expect(prompt).toContainText(`Type ${uuid.slice(0, 8)} to confirm`)
    const confirm = prompt.getByRole('button', { name: 'Delete' })
    await expect(confirm).toBeDisabled()
    await prompt.getByRole('textbox').fill(uuid.slice(0, 8))
    await confirm.click()

    await expect(page.getByText('No regressions match these filters.')).toBeVisible()
    await expect(prompt).toHaveCount(0)
    expect((await request.get(`/api/suites/libcxx/regressions/${uuid}`)).status()).toBe(404)
  } finally {
    await deleteRegression(request, uuid)
  }
})
