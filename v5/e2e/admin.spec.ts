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
import { ownSuite, withOwnSuiteName } from './own-suite.ts'
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
    // Using the token records its last use, so this must come after checking the row says 'Never'.
    expect(await keyOf(request, token)).toBe(name)

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
      'Yes',
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

  test('creates a suite in the editor, starting from a seeded suite', async ({
    page,
    request,
    signIn,
    tokenFor,
  }, testInfo) => {
    await withOwnSuiteName(request, await tokenFor('manage'), testInfo, async (suite) => {
      await signIn(page, 'manage')
      await page.goto('/admin?tab=suites')
      await page.getByRole('button', { name: 'New suite' }).click()
      const editor = page.getByRole('region', { name: 'New suite' })
      await editor.getByRole('textbox', { name: 'Suite name' }).fill(suite)
      await pickOption(editor, 'Start from', 'libcxx')
      await editor.getByRole('button', { name: '+ Add machine field' }).click()
      await editor
        .getByRole('textbox', { name: /^Name of machine field \d+$/ })
        .last()
        .fill('kernel')
      await editor.getByRole('button', { name: 'Create', exact: true }).click()

      await expect(page).toHaveURL(`/admin?tab=suites&suite=${suite}`)
      await expect(rows(table(page, 'Machine fields')).last().locator('td')).toHaveText([
        'kernel',
        'text',
        '--',
        'No',
      ])
      const libcxx = await json<components['schemas']['SuiteSchema']>(request, '/api/suites/libcxx')
      const created = await json<components['schemas']['SuiteSchema']>(
        request,
        `/api/suites/${suite}`,
      )
      expect(created).toEqual({
        ...libcxx,
        name: suite,
        machine_fields: [
          ...libcxx.machine_fields,
          { name: 'kernel', type: 'text', display_name: null, searchable: false },
        ],
      })
    })
  })

  test('creates a suite from a schema document', async ({
    page,
    request,
    signIn,
    tokenFor,
  }, testInfo) => {
    await withOwnSuiteName(request, await tokenFor('manage'), testInfo, async (suite) => {
      await signIn(page, 'manage')
      await page.goto('/admin?tab=suites')
      await page.getByRole('button', { name: 'New suite' }).click()
      const editor = page.getByRole('region', { name: 'New suite' })
      await editor.getByRole('button', { name: 'Import JSON' }).click()
      await editor
        .getByRole('textbox', { name: /^Schema document/ })
        .fill(JSON.stringify({ name: suite, metrics: [{ name: 'size', type: 'integer' }] }))
      await editor.getByRole('button', { name: 'Create from JSON' }).click()

      await expect(page).toHaveURL(`/admin?tab=suites&suite=${suite}`)
      await expect(rows(table(page, 'Metrics')).locator('td')).toHaveText([
        'size',
        'integer',
        '--',
        '--',
        'No',
        'No',
      ])
    })
  })

  test("edits a suite's schema, confirming a removal", async ({
    page,
    request,
    signIn,
    tokenFor,
  }, testInfo) => {
    const token = await tokenFor('manage')
    await withOwnSuiteName(request, token, testInfo, async (suite) => {
      const created = await request.post('/api/suites', {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          name: suite,
          metrics: [
            { name: 'execution_time', type: 'real' },
            { name: 'compile_time', type: 'real' },
          ],
          commit_fields: [
            { name: 'sha', type: 'text', display: true },
            { name: 'short_sha', type: 'text' },
          ],
        },
      })
      expect(created.status(), await created.text()).toBe(201)
      await signIn(page, 'manage')
      await page.goto(`/admin?tab=suites&suite=${suite}`)

      await page.getByRole('button', { name: 'Edit schema' }).click()
      const editor = page.getByRole('region', { name: `Editing ${suite}` })
      await editor
        .getByRole('textbox', { name: 'Display name of metric execution_time' })
        .fill('Execution Time')
      await editor
        .getByRole('checkbox', { name: 'On the Dashboard of metric execution_time' })
        .check()
      // The display field moves from one commit field to another.
      await editor.getByRole('checkbox', { name: 'Display of commit field short_sha' }).check()
      await editor.getByRole('button', { name: 'Remove metric compile_time' }).click()
      await editor.getByRole('button', { name: '+ Add machine field' }).click()
      await editor
        .getByRole('textbox', { name: 'Name of machine field 1', exact: true })
        .fill('kernel')
      await editor.getByRole('button', { name: 'Save', exact: true }).first().click()
      const prompt = page.getByRole('form', { name: 'Confirmation' })
      await prompt.getByRole('textbox').fill(suite)
      await prompt.getByRole('button', { name: 'Save' }).click()

      await expect(editor).toBeHidden()
      await expect(rows(table(page, 'Metrics')).locator('td')).toHaveText([
        'execution_time',
        'real',
        'Execution Time',
        '--',
        'No',
        'Yes',
      ])
      const schema = await json<components['schemas']['SuiteSchema']>(
        request,
        `/api/suites/${suite}`,
      )
      expect(schema.metrics.map((metric) => [metric.name, metric.dashboard])).toEqual([
        ['execution_time', true],
      ])
      expect(schema.commit_fields.map((field) => [field.name, field.display])).toEqual([
        ['sha', false],
        ['short_sha', true],
      ])
      expect(schema.machine_fields.map((field) => field.name)).toEqual(['kernel'])
    })
  })

  test('creates a suite that takes runs, whose pages follow its schema once edited', async ({
    page,
    request,
    signIn,
    tokenFor,
  }, testInfo) => {
    const token = await tokenFor('manage')
    await withOwnSuiteName(request, token, testInfo, async (suite) => {
      await signIn(page, 'manage')
      await page.goto('/admin?tab=suites')
      await page.getByRole('button', { name: 'New suite' }).click()
      const creator = page.getByRole('region', { name: 'New suite' })
      await creator.getByRole('textbox', { name: 'Suite name' }).fill(suite)
      for (const metric of ['execution_time', 'compile_time']) {
        await creator.getByRole('button', { name: '+ Add metric' }).click()
        await creator.getByRole('textbox', { name: /^Name of metric \d+$/ }).last().fill(metric)
      }
      await creator.getByRole('button', { name: '+ Add machine field' }).click()
      await creator
        .getByRole('textbox', { name: 'Name of machine field 1', exact: true })
        .fill('hardware')
      await creator.getByRole('button', { name: 'Create', exact: true }).click()
      await expect(page).toHaveURL(`/admin?tab=suites&suite=${suite}`)

      const submitted = await request.post(`/api/suites/${suite}/runs`, {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          format_version: '5',
          machine: { name: 'm1', fields: { hardware: 'Apple M4' } },
          commit: { value: 'c1', ordinal: 1 },
          tests: [{ name: 'bench', samples: [{ execution_time: 1.5, compile_time: 0.25 }] }],
        },
      })
      expect(submitted.status(), await submitted.text()).toBe(201)
      const run = ((await submitted.json()) as components['schemas']['RunDetail']).uuid

      // The pages of the suite, visited before its schema changes, and again after, without the
      // page being loaded again.
      await page.goto(`/suites/${suite}/runs/${run}`)
      await page.evaluate(() => Object.assign(window, { notReloaded: true }))
      await pickOption(page, 'Metric', 'compile_time')
      await expect(table(page, 'Samples').locator('td').nth(1)).toHaveText('0.25')
      await page.getByRole('main').getByRole('link', { name: 'm1', exact: true }).click()
      const machine = page.getByRole('group', { name: 'Machine', exact: true })
      await expect(machine).toContainText('Apple M4')
      await expect(machine).not.toContainText('kernel')

      await page.getByRole('navigation').getByRole('link', { name: 'Admin' }).click()
      await page.getByRole('tab', { name: 'Test Suites' }).click()
      await pickOption(page.getByRole('main'), 'Test suite', suite)
      await page.getByRole('button', { name: 'Edit schema' }).click()
      const editor = page.getByRole('region', { name: `Editing ${suite}` })
      await editor
        .getByRole('textbox', { name: 'Display name of metric execution_time' })
        .fill('Execution Time')
      await editor.getByRole('button', { name: 'Remove metric compile_time' }).click()
      await editor.getByRole('button', { name: '+ Add machine field' }).click()
      await editor
        .getByRole('textbox', { name: 'Name of machine field 2', exact: true })
        .fill('kernel')
      await editor.getByRole('button', { name: 'Save', exact: true }).first().click()
      const prompt = page.getByRole('form', { name: 'Confirmation' })
      await prompt.getByRole('textbox').fill(suite)
      await prompt.getByRole('button', { name: 'Save' }).click()
      await expect(editor).toBeHidden()

      // The machine has the new field, without a value yet, and keeps the value it had.
      await page.goBack()
      await expect(machine).toContainText('kernel')
      await expect(machine).toContainText('Apple M4')

      // The run no longer offers the metric removed, whose selection is dropped, and names the
      // other one as the schema now does.
      await page.goBack()
      await expect(page).toHaveURL(`/suites/${suite}/runs/${run}`)
      const metric = page.getByRole('button', { name: / Metric$/ })
      await expect(metric).toHaveText(/Execution Time/)
      await metric.click()
      await expect(page.getByRole('option')).toHaveText(['Execution Time'])
      await page.keyboard.press('Escape')
      await expect(table(page, 'Samples').getByRole('columnheader').nth(1)).toHaveText(
        'Execution Time',
      )
      await expect(table(page, 'Samples').locator('td').nth(1)).toHaveText('1.5')

      expect(await page.evaluate(() => 'notReloaded' in window)).toBe(true)
    })
  })
})
