/**
 * The Admin page's API Keys tab (AD1) and Test Suites tab (AD2).
 *
 * Tests that write change what they create: a key of their own to revoke, and a suite of their own
 * to delete. The seeded suites and the harness's admin key are left alone.
 */

import { readFileSync } from 'node:fs'
import type { APIRequestContext, Page } from '@playwright/test'
import type { components } from '../client/src/api/schema.d.ts'
import { PERMISSION_DENIED } from '../client/src/api/permission-denied.ts'
import { expect, json, test } from './fixtures.ts'
import { ownSuite } from './own-suite.ts'
import { pickOption } from './select.ts'
import { column, rows, table } from './tables.ts'

/** The name of the key that `token` belongs to, or null if the API does not accept it. */
async function keyOf(request: APIRequestContext, token: string): Promise<string | null> {
  const response = await request.get('/api/auth', { headers: { Authorization: `Bearer ${token}` } })
  if (response.status() === 401) return null
  expect(response.status(), await response.text()).toBe(200)
  return ((await response.json()) as components['schemas']['Authentication']).key?.name ?? null
}

/** Revoke the key `prefix` from its row of the keys table. */
async function revoke(page: Page, prefix: string) {
  await table(page, 'API keys').getByRole('button', { name: `Revoke key ${prefix}` }).click()
  const prompt = page.getByRole('form', { name: 'Confirmation' })
  await prompt.getByRole('button', { name: 'Revoke' }).click()
  await expect(prompt).toBeHidden()
}

test.describe('the API Keys tab', () => {
  test('says that permission is denied without a token', async ({ page }) => {
    await page.goto('/admin')
    await expect(page.getByRole('main').getByRole('alert')).toHaveText(PERMISSION_DENIED)
  })

  test('says that permission is denied to a manage token', async ({ page, signIn }) => {
    await signIn(page, 'manage')
    await page.goto('/admin')
    await expect(page.getByRole('main').getByRole('alert')).toHaveText(PERMISSION_DENIED)
  })

  test('creates a key, shows its token once, and revokes it', async ({
    page,
    request,
    signIn,
  }, testInfo) => {
    await signIn(page, 'admin')
    await page.goto('/admin')
    const keys = table(page, 'API keys')
    await expect(rows(keys).first()).toBeVisible()

    const name = `e2e-created-${testInfo.testId}`
    const form = page.getByRole('form', { name: 'Create API Key' })
    await form.getByLabel('Name').fill(name)
    await pickOption(form, 'Scope', 'triage')
    await form.getByRole('button', { name: 'Create key' }).click()

    const created = page.getByRole('region', { name: 'Created key' })
    const token = (await created.locator('code').textContent()) ?? ''
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(await keyOf(request, token)).toBe(name)
    const prefix = token.slice(0, 8)
    // Other tests create keys meanwhile, so the new key need not head the table.
    const row = rows(keys).filter({ hasText: prefix })
    await expect(row.locator('td')).toHaveText([
      prefix,
      name,
      'triage',
      /^\d{4}-\d\d-\d\d, /,
      'Never',
      'Yes',
      'Revoke',
    ])

    await revoke(page, prefix)

    await expect(row.locator('td').nth(5)).toHaveText('No')
    await expect(row.getByRole('button')).toHaveCount(0)
    expect(await keyOf(request, token)).toBeNull()

    // The token is shown only until the user leaves the tab.
    await page.getByRole('tab', { name: 'Test Suites' }).click()
    await page.getByRole('tab', { name: 'API Keys' }).click()
    await expect(rows(keys).first()).toBeVisible()
    await expect(created).toBeHidden()
  })

  test('sorts the keys by when they were last used', async ({ page, signIn }) => {
    // The seeded keys have never been used, and the key signing in has.
    await signIn(page, 'admin')
    await page.goto('/admin')
    const keys = table(page, 'API keys')
    await expect(rows(keys).first()).toBeVisible()

    for (const [direction, sort] of [
      ['ascending', 'last_used_at'],
      ['descending', '-last_used_at'],
    ]) {
      await keys.getByRole('button', { name: 'Last Used' }).click()
      await expect(keys.getByRole('columnheader', { name: 'Last Used' })).toHaveAttribute(
        'aria-sort',
        direction,
      )
      await expect(page).toHaveURL(`/admin?sort=${sort}`)
      // Keys never used come last, whichever the direction.
      const lastUsed = await column(keys, 4)
      const firstNever = lastUsed.indexOf('Never')
      expect(firstNever).toBeGreaterThan(0)
      expect(lastUsed.slice(firstNever).every((value) => value === 'Never')).toBe(true)
    }
  })

  test('denies permission at once after revoking the key of its own token', async ({
    page,
    request,
    signIn,
  }) => {
    const token = await signIn(page, 'admin')
    await page.goto('/admin')
    await expect(rows(table(page, 'API keys')).first()).toBeVisible()

    await revoke(page, token.slice(0, 8))

    await expect(page.getByRole('main').getByRole('alert')).toHaveText(PERMISSION_DENIED)
    await page.getByRole('navigation').getByRole('button', { name: 'Settings' }).click()
    await expect(page.getByRole('dialog', { name: 'Settings' }).getByRole('status')).toContainText(
      'This token is not valid',
    )
    expect(await keyOf(request, token)).toBeNull()
  })
})

test.describe('the Test Suites tab', () => {
  test('shows the schema of a seeded suite to anyone', async ({ page }) => {
    await page.goto('/admin?tab=suites')
    await pickOption(page.getByRole('main'), 'Test suite', 'libcxx')

    await expect(page).toHaveURL('/admin?tab=suites&suite=libcxx')
    await expect(rows(table(page, 'Metrics')).first().locator('td')).toHaveText([
      'execution_time',
      'real',
      'Execution Time',
      'seconds (s)',
      'No',
    ])
    await expect(page.getByRole('button', { name: 'Delete This Suite' })).toBeDisabled()
  })

  test('downloads the schema of a suite of its own, and deletes the suite', async ({
    page,
    request,
    signIn,
    tokenFor,
  }, testInfo) => {
    await ownSuite(request, tokenFor, testInfo, [], async (suite) => {
      await signIn(page, 'manage')
      await page.goto(`/admin?tab=suites&suite=${suite}`)
      await expect(table(page, 'Metrics')).toBeVisible()

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: 'Download JSON' }).click(),
      ])
      expect(download.suggestedFilename()).toBe(`${suite}.json`)
      const downloaded = JSON.parse(readFileSync(await download.path(), 'utf8'))
      expect(downloaded).toEqual(await json(request, `/api/suites/${suite}`))

      await page.getByRole('button', { name: 'Delete This Suite' }).click()
      const prompt = page.getByRole('form', { name: 'Confirmation' })
      await prompt.getByRole('textbox').fill(suite)
      await prompt.getByRole('button', { name: 'Delete' }).click()

      await expect(page).toHaveURL('/admin?tab=suites')
      await expect(table(page, 'Metrics')).toBeHidden()
      expect((await request.get(`/api/suites/${suite}`)).status()).toBe(404)
    })
  })
})
