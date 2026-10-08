/**
 * The API token, as the Settings panel handles it (AR2).
 */

import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'

function settings(page: Page) {
  return page.getByRole('region', { name: 'Settings' })
}

async function openSettings(page: Page) {
  await page.getByRole('navigation').getByRole('button', { name: 'Settings' }).click()
  await expect(settings(page)).toBeVisible()
}

async function enterToken(page: Page, token: string) {
  await settings(page).getByLabel('API token').fill(token)
  await settings(page).getByRole('button', { name: 'Save' }).click()
}

test.describe('the Settings panel', () => {
  test('shows the key a valid token belongs to, and keeps it across a reload', async ({
    page,
    tokenFor,
  }) => {
    const token = await tokenFor('triage')
    await page.goto('/')
    await openSettings(page)

    await enterToken(page, token)
    const status = settings(page).getByRole('status')
    await expect(status).toContainText(`Using key e2e-triage (${token.slice(0, 8)})`)
    await expect(status).toContainText('with triage scope')

    await page.reload()
    await openSettings(page)
    await expect(settings(page).getByRole('status')).toContainText('with triage scope')
  })

  test('says that a token the server does not know is not valid', async ({ page }) => {
    await page.goto('/')
    await openSettings(page)

    await enterToken(page, '0'.repeat(64))
    await expect(settings(page).getByRole('status')).toContainText('This token is not valid')
  })

  test('clears the token, for good', async ({ page, signIn }) => {
    await signIn(page, 'manage')
    await page.goto('/')
    await openSettings(page)
    await expect(settings(page).getByRole('status')).toContainText('with manage scope')

    await settings(page).getByRole('button', { name: 'Clear token' }).click()
    await expect(settings(page).getByRole('status')).toContainText('No token set')

    await page.reload()
    await openSettings(page)
    await expect(settings(page).getByRole('status')).toContainText('No token set')
  })

  test('takes up a token entered in another tab', async ({ page, context, tokenFor }) => {
    const token = await tokenFor('submit')
    await page.goto('/')
    const other = await context.newPage()
    await other.goto('/')

    await openSettings(other)
    await enterToken(other, token)
    await expect(settings(other).getByRole('status')).toContainText('with submit scope')

    await openSettings(page)
    await expect(settings(page).getByRole('status')).toContainText('with submit scope')
  })
})
