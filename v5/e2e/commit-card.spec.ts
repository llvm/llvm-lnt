/**
 * The card of a commit's link (AR21), on the pages of the seeded libcxx suite.
 */

import type { Locator } from '@playwright/test'
import { EXPERIMENT } from '../tools/synthetic.ts'
import { cardOf } from './cards.ts'
import { expect, REAL_RUN, test } from './fixtures.ts'
import { rows, table } from './tables.ts'

/** The commit string of the commit `link` leads to. */
async function commitOf(link: Locator): Promise<string> {
  const href = (await link.getAttribute('href'))!
  return decodeURIComponent(href.split('/').at(-1)!)
}

test('a commit link of the Runs tab opens its card on hover, which stays open over it', async ({
  page,
}) => {
  // To let time pass for the card without waiting for it.
  await page.clock.install()
  await page.goto('/suites/libcxx')
  // A commit with a display value, which hides its commit string.
  const link = table(page, 'Runs').getByRole('link', { name: /^r\d+/ }).first()
  const commit = await commitOf(link)

  await link.hover()
  const card = await cardOf(page, link)
  await expect(card).toHaveRole('group')
  await expect(card).toHaveAccessibleName((await link.textContent())!)
  await expect(card).toContainText(commit)
  await expect(card.getByRole('link', { name: 'View on GitHub' })).toHaveAttribute(
    'href',
    `https://github.com/llvm/llvm-project/commit/${commit}`,
  )

  // Its links can be followed: it stays open while the pointer is on it.
  await card.hover()
  await page.clock.runFor(1000)
  await expect(card).toBeVisible()

  await page.getByRole('heading', { level: 1 }).hover()
  await expect(card).toBeHidden()
  await expect(link).not.toHaveAttribute('aria-details')
})

test('Escape closes a card', async ({ page }) => {
  await page.goto('/suites/libcxx')
  const link = rows(table(page, 'Runs')).first().getByRole('link').nth(2)

  await link.hover()
  const card = await cardOf(page, link)
  await expect(card).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(card).toBeHidden()
})

test('keyboard focus does not open a card', async ({ page }) => {
  await page.clock.install()
  await page.goto('/suites/libcxx')
  const link = rows(table(page, 'Runs')).first().getByRole('link').nth(2)
  await expect(link).toBeVisible()

  await link.focus()
  await page.clock.runFor(1000)
  await expect(link).not.toHaveAttribute('aria-details')
  await expect(page.getByRole('link', { name: 'View on GitHub' })).toHaveCount(0)
})

test("the Commits tab's card shows a commit without an ordinal", async ({ page }) => {
  await page.goto(`/suites/libcxx?tab=commits&search=${EXPERIMENT}`)
  const link = table(page, 'Commits').getByRole('link', { name: EXPERIMENT, exact: true })

  await link.hover()
  const card = await cardOf(page, link)
  await expect(card).toHaveAccessibleName(EXPERIMENT)
  await expect(card.getByRole('term')).toHaveText(['Commit', 'commit_info'])
  await expect(card).toContainText('A/B experiment')
})

test("the Run Detail page's commit has its card", async ({ page }) => {
  await page.goto(`/suites/libcxx/runs/${REAL_RUN}`)
  const info = page.getByRole('group', { name: 'Run', exact: true })
  const link = info.getByRole('link', { name: 'r552558' })

  await link.hover()
  const card = await cardOf(page, link)
  await expect(card).toHaveAccessibleName('r552558')
  await expect(card.getByRole('term')).toHaveText(['Commit', 'Ordinal', 'svn_revision'])
  await expect(card).toContainText('552558')
})
