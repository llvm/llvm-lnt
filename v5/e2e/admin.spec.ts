/**
 * The Admin page's API Keys tab (AD1) and Projects tab (AD3), where suites are created (TS7).
 *
 * Tests that write change what they create: a key of their own to revoke, and a project or a suite
 * of their own to change and delete. The seeded projects and suites and the harness's admin key are
 * left alone.
 */

import type { APIRequestContext, Page } from '@playwright/test'
import type { components } from '../client/src/api/schema.d.ts'
import { suitePath } from '../client/src/paths.ts'
import { adminToken, BENCHMARKS, expect, json, NTS, test } from './fixtures.ts'
import { ownName, withOwnSuite } from './own-suite.ts'
import { pickOption, pickSuite, selectButton } from './select.ts'
import { column, rows, table } from './tables.ts'

/** The key that `token` belongs to, or null if the API does not accept it. */
async function keyOf(request: APIRequestContext, token: string) {
  const response = await request.get('/api/auth', { headers: { Authorization: `Bearer ${token}` } })
  if (response.status() === 401) return null
  expect(response.status(), await response.text()).toBe(200)
  return ((await response.json()) as components['schemas']['Authentication']).key
}

/** Revoke the key `prefix` from its row of the keys table. */
async function revoke(page: Page, prefix: string) {
  await table(page, 'API keys').getByRole('button', { name: `Revoke key ${prefix}` }).click()
  const prompt = page.getByRole('form', { name: 'Confirmation' })
  await prompt.getByRole('button', { name: 'Revoke' }).click()
  await expect(prompt).toBeHidden()
}

test.describe('the API Keys tab', () => {
  test('says that it needs an admin token without a token', async ({ page }) => {
    await page.goto('/admin')
    await expect(page.getByRole('main').getByRole('alert')).toHaveText(
      "Permission denied. Needs an API token with the 'admin' scope. Set one in Settings.",
    )
  })

  test('says that it needs an admin token to a manage token', async ({ page, signIn }) => {
    await signIn(page, 'manage')
    await page.goto('/admin')
    await expect(page.getByRole('main').getByRole('alert')).toHaveText(
      "Permission denied. Needs an API token with the 'admin' scope. The token in Settings has " +
        "the 'manage' scope.",
    )
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
      'All',
      /^\d{4}-\d\d-\d\d, /,
      'Never',
      'Yes',
      'EditRevoke',
    ])
    // Using the token records its last use, so this must come after checking the row says 'Never'.
    expect((await keyOf(request, token))?.name).toBe(name)

    await revoke(page, prefix)

    await expect(row.locator('td').nth(6)).toHaveText('No')
    await expect(row.getByRole('button')).toHaveCount(0)
    expect(await keyOf(request, token)).toBeNull()

    // The token is shown only until the user leaves the tab.
    await page.getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('tab', { name: 'API Keys' }).click()
    await expect(rows(keys).first()).toBeVisible()
    await expect(created).toBeHidden()
  })

  test('creates a key restricted to a whole project and a suite', async ({
    page,
    request,
    signIn,
  }, testInfo) => {
    await signIn(page, 'admin')
    await page.goto('/admin')
    const keys = table(page, 'API keys')
    await expect(rows(keys).first()).toBeVisible()

    const name = `e2e-restricted-${testInfo.testId}`
    const form = page.getByRole('form', { name: 'Create API Key' })
    await form.getByLabel('Name').fill(name)
    await pickOption(form, 'Scope', 'submit')
    await form.getByRole('radio', { name: 'Only these:' }).check()
    // The tree stays open while its boxes are checked.
    const covers = selectButton(form, 'Projects and suites to restrict to')
    await expect(covers).toHaveText(/Select projects or suites/)
    await covers.click()
    // Every project, those without suites included, saying so (AD1).
    await expect(page.getByRole('option', { name: 'swift (no suites)', exact: true })).toBeVisible()
    const libcxx = page.getByRole('option', { name: 'libc++', exact: true })
    await libcxx.click()
    // Its suites are then listed as covered, without a checkbox, and cannot be focused or checked.
    await expect(libcxx).toHaveAttribute('aria-selected', 'true')
    const benchmarks = page.getByRole('option', {
      name: 'libc++ › Microbenchmarks, covered by libc++',
    })
    await expect(benchmarks.getByRole('checkbox', { includeHidden: true })).toBeHidden()
    await benchmarks.click({ force: true })
    await expect(benchmarks).not.toBeFocused()
    await expect(benchmarks).toHaveAttribute('aria-selected', 'false')
    await expect(covers).toHaveText(/^libc\+\+ \(all\)/)
    // Each suite by its full label (AR22).
    await page.getByRole('option', { name: 'LLVM › nts', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(covers).toHaveText(/libc\+\+ \(all\), LLVM › nts/)
    await expect(covers).toBeFocused()
    await form.getByRole('button', { name: 'Create key' }).click()

    const created = page.getByRole('region', { name: 'Created key' })
    const token = (await created.locator('code').textContent()) ?? ''
    const row = rows(keys).filter({ hasText: token.slice(0, 8) })
    await expect(row.locator('td').nth(3)).toHaveText('libc++ (all), LLVM › nts')
    expect(await keyOf(request, token)).toMatchObject({
      name,
      scope: 'submit',
      restricted_to: [{ project: 'libcxx', suite: null }, NTS],
    })
  })

  test('shows a key whose entries were all deleted as covering nothing', async ({
    page,
    request,
    signIn,
    tokenFor,
  }, testInfo) => {
    const manage = await tokenFor('manage')
    let token = ''
    await withOwnSuite(request, manage, testInfo, async (suite) => {
      const created = await request.post(`/api/projects/${suite.project}/suites`, {
        headers: { Authorization: `Bearer ${manage}` },
        data: { name: suite.suite, metrics: [] },
      })
      expect(created.status(), await created.text()).toBe(201)
      token = await tokenFor('submit', [suite])
    })

    // Deleting the suite removed it from the key (I5).
    await signIn(page, 'admin')
    await page.goto('/admin')
    const row = rows(table(page, 'API keys')).filter({ hasText: token.slice(0, 8) })
    const covers = row.locator('td').nth(3)
    await expect(covers).toHaveText('Nothing')
    await expect(covers.getByText('Nothing')).toHaveAttribute('title', /has been deleted/)
    expect(await keyOf(request, token)).toMatchObject({ restricted_to: [] })
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
      // Keys never used come last among the active keys, which come first (other tests revoke
      // keys), whichever the direction.
      const activeColumn = await column(keys, 6)
      const activeCount = activeColumn.lastIndexOf('Yes') + 1
      expect(activeColumn.slice(activeCount).every((value) => value === 'No')).toBe(true)
      const lastUsed = (await column(keys, 5)).slice(0, activeCount)
      const firstNever = lastUsed.indexOf('Never')
      expect(firstNever).toBeGreaterThan(0)
      expect(lastUsed.slice(firstNever).every((value) => value === 'Never')).toBe(true)
    }
  })

  test("changes a key's scope and what it covers, once confirmed", async ({
    page,
    request,
    signIn,
  }, testInfo) => {
    const name = `e2e-changed-${testInfo.testId}`
    const response = await request.post('/api/admin/api-keys', {
      headers: { Authorization: `Bearer ${adminToken()}` },
      data: { name, scope: 'triage' },
    })
    expect(response.status(), await response.text()).toBe(201)
    const { token } = (await response.json()) as components['schemas']['ApiKeyCreated']
    const prefix = token.slice(0, 8)
    await signIn(page, 'admin')
    await page.goto('/admin')
    const row = rows(table(page, 'API keys')).filter({ hasText: prefix })

    const edit = row.getByRole('button', { name: `Edit key ${prefix}` })
    await edit.click()
    const form = page.getByRole('form', { name: `Edit key ${prefix} · ${name}` })
    await expect(form.getByLabel('Name')).toBeFocused()
    // The row of a key both edited and whose revocation is confirmed shows the latter's red.
    await row.getByRole('button', { name: `Revoke key ${prefix}` }).click()
    const danger = await page.evaluate(() => {
      const probe = document.body.appendChild(document.createElement('div'))
      probe.style.background = 'var(--lnt-danger-bg)'
      const color = getComputedStyle(probe).backgroundColor
      probe.remove()
      return color
    })
    await expect(row).toHaveCSS('background-color', danger)
    const revocation = page.getByRole('form', { name: 'Confirmation' })
    await revocation.getByRole('button', { name: 'Cancel' }).click()
    await pickOption(form, 'Scope', 'manage')
    await form.getByRole('radio', { name: 'Only these:' }).check()
    await selectButton(form, 'Projects and suites to restrict to').click()
    await page.getByRole('option', { name: 'libc++', exact: true }).click()
    await page.getByRole('option', { name: 'LLVM › nts', exact: true }).click()
    await page.keyboard.press('Escape')
    await form.getByRole('button', { name: 'Save' }).click()

    const prompt = page.getByRole('form', { name: 'Confirmation' })
    await expect(prompt).toContainText('Scope: triage → manage')
    await expect(prompt).toContainText('Covers: All → libc++ (all), LLVM › nts')
    await prompt.getByRole('button', { name: 'Save' }).click()

    await expect(form).toBeHidden()
    await expect(row.locator('td').nth(2)).toHaveText('manage')
    await expect(row.locator('td').nth(3)).toHaveText('libc++ (all), LLVM › nts')
    await expect(edit).toBeFocused()
    // The token is the same, and grants what the key now does.
    expect(await keyOf(request, token)).toMatchObject({
      name,
      scope: 'manage',
      restricted_to: [{ project: 'libcxx', suite: null }, NTS],
    })
  })

  test('denies permission at once after taking admin away from its own token', async ({
    page,
    request,
    signIn,
  }) => {
    const token = await signIn(page, 'admin')
    const prefix = token.slice(0, 8)
    await page.goto('/admin')

    await table(page, 'API keys').getByRole('button', { name: `Edit key ${prefix}` }).click()
    const form = page.getByRole('form', { name: new RegExp(`^Edit key ${prefix}`) })
    await pickOption(form, 'Scope', 'manage')
    await form.getByRole('button', { name: 'Save' }).click()
    const prompt = page.getByRole('form', { name: 'Confirmation' })
    await expect(prompt).toContainText('this tab will no longer be available')
    await prompt.getByRole('button', { name: 'Save' }).click()

    await expect(page.getByRole('main').getByRole('alert')).toHaveText(
      "Permission denied. Needs an API token with the 'admin' scope. The token in Settings has " +
        "the 'manage' scope.",
    )
    expect(await keyOf(request, token)).toMatchObject({ scope: 'manage' })
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

    await expect(page.getByRole('main').getByRole('alert')).toHaveText(
      "Permission denied. Needs an API token with the 'admin' scope. The token in Settings is not " +
        'valid.',
    )
    await page.getByRole('navigation').getByRole('button', { name: 'Settings' }).click()
    await expect(page.getByRole('dialog', { name: 'Settings' }).getByRole('status')).toContainText(
      'This token is not valid',
    )
    expect(await keyOf(request, token)).toBeNull()
  })
})

/** Open the schema editor creating a suite in the project `project`, from its row (AD3, TS7). */
async function newSuite(page: Page, project: string) {
  await page.goto('/admin?tab=projects')
  await page.getByRole('button', { name: `New suite in ${project}` }).click()
  return page.getByRole('region', { name: `New suite in ${project}` })
}

test.describe("the Projects tab's suite creation", () => {
  test('creates a suite in a project a manage token covers in full, and only there', async ({
    page,
    request,
    signIn,
    tokenFor,
  }, testInfo) => {
    await withOwnSuite(request, await tokenFor('manage'), testInfo, async (suite) => {
      await signIn(page, 'manage', [{ project: suite.project, suite: null }, BENCHMARKS])
      await page.goto('/admin?tab=projects')

      // Not in the other projects, even one with a suite the token covers (AD3).
      const libcxx = page.getByRole('button', { name: 'New suite in libc++' })
      await expect(libcxx).toBeDisabled()
      await expect(libcxx).toHaveAttribute(
        'title',
        /^Needs an API token with the 'manage' scope covering project 'libc\+\+' in full\./,
      )
      const editor = await newSuite(page, suite.project)
      await editor.getByRole('textbox', { name: 'Name', exact: true }).fill(suite.suite)
      await editor.getByRole('button', { name: 'Create', exact: true }).click()

      await expect(page).toHaveURL(`${suitePath(suite)}?tab=schema`)
    })
  })

  test('creates a suite in the editor, starting from a seeded suite', async ({
    page,
    request,
    signIn,
    tokenFor,
  }, testInfo) => {
    await withOwnSuite(request, await tokenFor('manage'), testInfo, async (suite) => {
      await signIn(page, 'manage')
      const editor = await newSuite(page, suite.project)
      await editor.getByRole('textbox', { name: 'Name', exact: true }).fill(suite.suite)
      await editor.getByRole('textbox', { name: 'Display name', exact: true }).fill(' E2E suite ')
      await pickSuite(editor, 'Start from', 'libc++', 'Microbenchmarks')
      await editor.getByRole('button', { name: '+ Add machine field' }).click()
      await editor
        .getByRole('textbox', { name: /^Name of machine field \d+$/ })
        .last()
        .fill('kernel')
      await editor.getByRole('button', { name: 'Create', exact: true }).click()

      await expect(page).toHaveURL(`${suitePath(suite)}?tab=schema`)
      await expect(page.getByRole('group', { name: 'Suite' })).toHaveText(
        `Project${suite.project}Name${suite.suite}Display nameE2E suite`,
      )
      await expect(rows(table(page, 'Machine fields')).last().locator('td')).toHaveText([
        'kernel',
        'text',
        '--',
        'No',
        'No',
      ])
      const libcxx = await json<components['schemas']['SuiteSchema']>(
        request,
        '/api/projects/libcxx/suites/benchmarks',
      )
      const created = await json<components['schemas']['SuiteSchema']>(
        request,
        `/api${suitePath(suite)}`,
      )
      expect(created).toEqual({
        ...libcxx,
        name: suite.suite,
        display_name: 'E2E suite',
        machine_fields: [
          ...libcxx.machine_fields,
          { name: 'kernel', type: 'text', display_name: null, searchable: false, listed: false },
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
    await withOwnSuite(request, await tokenFor('manage'), testInfo, async (suite) => {
      await signIn(page, 'manage')
      const editor = await newSuite(page, suite.project)
      await editor.getByRole('button', { name: 'Import JSON' }).click()
      await editor
        .getByRole('textbox', { name: /^Schema document/ })
        .fill(JSON.stringify({ name: suite.suite, metrics: [{ name: 'size', type: 'integer' }] }))
      await editor.getByRole('button', { name: 'Create from JSON' }).click()

      await expect(page).toHaveURL(`${suitePath(suite)}?tab=schema`)
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

  test('creates a suite that takes runs, whose pages follow its schema once edited', async ({
    page,
    request,
    signIn,
    tokenFor,
  }, testInfo) => {
    const token = await tokenFor('manage')
    await withOwnSuite(request, token, testInfo, async (suite) => {
      await signIn(page, 'manage')
      const creator = await newSuite(page, suite.project)
      await creator.getByRole('textbox', { name: 'Name', exact: true }).fill(suite.suite)
      for (const metric of ['compile_time', 'execution_time']) {
        await creator.getByRole('button', { name: '+ Add metric' }).click()
        await creator.getByRole('textbox', { name: /^Name of metric \d+$/ }).last().fill(metric)
      }
      await creator
        .getByRole('button', { name: 'Drag metric execution_time' })
        .dragTo(creator.getByRole('button', { name: 'Drag metric compile_time' }))
      await creator.getByRole('button', { name: '+ Add machine field' }).click()
      await creator
        .getByRole('textbox', { name: 'Name of machine field 1', exact: true })
        .fill('hardware')
      await creator.getByRole('button', { name: 'Create', exact: true }).click()
      await expect(page).toHaveURL(`${suitePath(suite)}?tab=schema`)

      const submitted = await request.post(`/api${suitePath(suite)}/runs`, {
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
      // page being loaded again. No field is listed yet.
      await page.goto(`${suitePath(suite)}?tab=machines`)
      await page.evaluate(() => Object.assign(window, { notReloaded: true }))
      const machines = table(page, 'Machines')
      await expect(machines.getByRole('columnheader')).toHaveText(['Machine'])
      await machines.getByRole('link', { name: 'm1', exact: true }).click()
      await table(page, 'Run history').getByRole('link').first().click()
      await expect(page).toHaveURL(`${suitePath(suite)}/runs/${run}`)
      // In the order the suite was created with, the first one selected.
      const metric = page.getByRole('button', { name: / Metric$/ })
      await expect(metric).toHaveText(/execution_time/)
      await metric.click()
      await expect(page.getByRole('option')).toHaveText(['execution_time', 'compile_time'])
      await page.keyboard.press('Escape')
      await pickOption(page, 'Metric', 'compile_time')
      await expect(table(page, 'Samples').locator('td').nth(1)).toHaveText('0.25')
      await page.getByRole('main').getByRole('link', { name: 'm1', exact: true }).click()
      const machine = page.getByRole('group', { name: 'Machine', exact: true })
      await expect(machine).toContainText('Apple M4')
      await expect(machine).not.toContainText('kernel')

      // The project, then the suite, each by its name, which is its label.
      const trail = page.getByRole('navigation', { name: 'Breadcrumb' })
      await expect(trail.getByRole('link', { name: suite.project, exact: true })).toHaveAttribute(
        'href',
        `/projects/${suite.project}`,
      )
      const suiteLink = trail.getByRole('link', { name: suite.suite, exact: true })
      await suiteLink.click()
      await page.getByRole('tab', { name: 'Schema' }).click()
      await page.getByRole('button', { name: 'Edit schema' }).click()
      const editor = page.getByRole('region', { name: `Editing ${suite.project} › ${suite.suite}` })
      await editor
        .getByRole('textbox', { name: 'Display name of metric execution_time' })
        .fill('Execution Time')
      await editor.getByRole('checkbox', { name: 'Listed of machine field hardware' }).check()
      await editor.getByRole('button', { name: 'Remove metric compile_time' }).click()
      await editor.getByRole('button', { name: '+ Add machine field' }).click()
      await editor
        .getByRole('textbox', { name: 'Name of machine field 2', exact: true })
        .fill('kernel')
      await editor.getByRole('button', { name: 'Save', exact: true }).first().click()
      const prompt = page.getByRole('form', { name: 'Confirmation' })
      await prompt.getByRole('textbox').fill(suite.suite)
      await prompt.getByRole('button', { name: 'Save' }).click()
      await expect(editor).toBeHidden()

      // The machine has the new field, without a value yet, and keeps the value it had.
      await page.goBack()
      await expect(page).toHaveURL(new RegExp(`${suitePath(suite)}/machines/m1$`))
      await expect(machine).toContainText('kernel')
      await expect(machine).toContainText('Apple M4')

      // The run no longer offers the metric removed, whose selection is dropped, and names the
      // other one as the schema now does.
      await page.goBack()
      await expect(page).toHaveURL(`${suitePath(suite)}/runs/${run}`)
      await expect(metric).toHaveText(/Execution Time/)
      await metric.click()
      await expect(page.getByRole('option')).toHaveText(['Execution Time'])
      await page.keyboard.press('Escape')
      await expect(table(page, 'Samples').getByRole('columnheader').nth(1)).toHaveText(
        'Execution Time',
      )
      await expect(table(page, 'Samples').locator('td').nth(1)).toHaveText('1.5')

      // The Machines tab shows the field now listed in a column of its own.
      await suiteLink.click()
      await page.getByRole('tab', { name: 'Machines' }).click()
      await expect(machines.getByRole('columnheader')).toHaveText(['Machine', 'hardware'])
      await expect(rows(machines).locator('td')).toHaveText(['m1', 'Apple M4'])

      expect(await page.evaluate(() => 'notReloaded' in window)).toBe(true)
    })
  })
})

test.describe('the Projects tab', () => {
  test('creates a project, changes its display name, renames it and deletes it', async ({
    page,
    request,
    signIn,
    tokenFor,
  }, testInfo) => {
    const base = ownName(testInfo, 62)
    const [name, renamed] = [`${base}-a`, `${base}-b`]
    const headers = { Authorization: `Bearer ${await tokenFor('manage')}` }
    try {
      await signIn(page, 'manage')
      await page.goto('/admin?tab=projects')
      const projects = table(page, 'Projects')
      // A project with suites cannot be deleted (AD3).
      const libcxx = page.getByRole('button', { name: 'Delete project libcxx' })
      await expect(libcxx).toBeDisabled()
      await expect(libcxx).toHaveAttribute(
        'title',
        "The project 'libc++' still has test suites: delete or move them first.",
      )

      const form = page.getByRole('form', { name: 'New project' })
      await form.getByRole('textbox', { name: 'Name', exact: true }).fill(name)
      await form.getByRole('textbox', { name: 'Display name' }).fill(`${name} label`)
      await form.getByRole('button', { name: 'Create project' }).click()
      const row = (project: string) =>
        rows(projects).filter({
          has: page.getByRole('button', { name: `Delete project ${project}` }),
        })
      await expect(row(name).locator('td')).toHaveText([
        '⠿',
        `${name}Edit`,
        `${name} labelEdit`,
        '0+',
        'Delete',
      ])
      await expect(form.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('')

      await page.getByRole('button', { name: `Edit Display name of ${name}` }).click()
      await page.getByRole('textbox', { name: `Display name of ${name}` }).fill('E2E project')
      await page.keyboard.press('Enter')
      await expect(row(name).locator('td').nth(2)).toHaveText('E2E projectEdit')

      await page.getByRole('button', { name: `Edit Name of ${name}` }).click()
      await page.getByRole('textbox', { name: `Name of ${name}` }).fill(renamed)
      await page.keyboard.press('Enter')
      const prompt = page.getByRole('form', { name: 'Confirmation' })
      // By its names, rather than its labels (AR22).
      await expect(prompt).toContainText(
        `Rename the project ${name} to ${renamed}? Every URL, bookmark and bot that uses the ` +
          `name ${name} for any of the project's suites`,
      )
      await prompt.getByRole('button', { name: 'OK' }).click()
      await expect(row(renamed)).toHaveCount(1)
      await expect(row(name)).toHaveCount(0)
      expect((await request.get(`/api/projects/${name}`)).status()).toBe(404)
      const shown = await json<components['schemas']['Project']>(
        request,
        `/api/projects/${renamed}`,
      )
      expect(shown).toMatchObject({ name: renamed, display_name: 'E2E project', suites: [] })

      // Its suites, of which it has none, on the Projects page (TS1).
      await row(renamed).getByRole('link', { name: '0 suites of E2E project' }).click()
      await expect(page).toHaveURL(`/projects/${renamed}`)
      await expect(page.getByRole('main')).toContainText('No test suites.')
      await page.goBack()

      await page.getByRole('button', { name: `Delete project ${renamed}` }).click()
      await expect(prompt).toContainText('API keys listing the project will lose it')
      await prompt.getByRole('button', { name: 'Delete' }).click()
      await expect(row(renamed)).toHaveCount(0)
      expect((await request.get(`/api/projects/${renamed}`)).status()).toBe(404)
    } finally {
      await request.delete(`/api/projects/${name}`, { headers })
      await request.delete(`/api/projects/${renamed}`, { headers })
    }
  })

  test('drags a project before another, saving the new order on the drop', async ({
    page,
    request,
    signIn,
    tokenFor,
  }, testInfo) => {
    const base = ownName(testInfo, 62)
    // Created in this order, which puts `second` after `first` (D7).
    const [first, second] = [`${base}-a`, `${base}-b`]
    const headers = { Authorization: `Bearer ${await tokenFor('manage')}` }
    for (const name of [first, second]) {
      const created = await request.post('/api/projects', { headers, data: { name } })
      expect(created.status(), await created.text()).toBe(201)
    }
    // The names of the projects, in the API's order, and whether `second` is just before `first`.
    const listed = async () =>
      (await json<components['schemas']['ProjectList']>(request, '/api/projects')).items.map(
        (project) => project.name,
      )
    const justBefore = (names: string[]) => names.indexOf(second) === names.indexOf(first) - 1
    try {
      await signIn(page, 'manage')
      await page.goto('/admin?tab=projects')
      const projects = table(page, 'Projects')
      const grip = (name: string) => page.getByRole('button', { name: `Drag project ${name}` })
      await expect(grip(second)).toBeEnabled()

      // Dropped on `first`, from after it, `second` goes just before it, whatever is between them,
      // and the other projects keep their places. Each drop sends every project the page lists, so
      // one that another test creates or deletes meanwhile has the API refuse it with a 400, after
      // which the page lists them again (AR24): the drop is then tried again.
      while (!justBefore(await listed())) {
        // Until the save before is done, no grip can drag (AR24).
        await expect(grip(second)).not.toHaveAttribute('aria-disabled', 'true')
        const saved = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/projects' &&
            response.request().method() === 'PATCH',
        )
        await grip(second).dragTo(grip(first))
        expect([200, 400]).toContain((await saved).status())
      }

      await expect(grip(second)).toBeFocused()
      const shown = async () =>
        (await column(projects, 1)).map((name) => name.replace(/Edit$/, ''))
      await expect.poll(async () => justBefore(await shown())).toBe(true)
    } finally {
      await request.delete(`/api/projects/${first}`, { headers })
      await request.delete(`/api/projects/${second}`, { headers })
    }
  })

  test('lets a token covering a project in full change it and delete it, but create none', async ({
    page,
    request,
    signIn,
    tokenFor,
  }, testInfo) => {
    const base = ownName(testInfo, 62)
    const [name, renamed] = [`${base}-a`, `${base}-b`]
    const headers = { Authorization: `Bearer ${await tokenFor('manage')}` }
    const created = await request.post('/api/projects', { headers, data: { name } })
    expect(created.status(), await created.text()).toBe(201)
    try {
      await signIn(page, 'manage', [{ project: name, suite: null }])
      await page.goto('/admin?tab=projects')

      const create = page.getByRole('button', { name: 'Create project' })
      await expect(create).toBeDisabled()
      await expect(create).toHaveAttribute(
        'title',
        /^Needs an instance-wide API token with the 'manage' scope\./,
      )
      // Dragging a project, even its own, needs an instance-wide token (AD3).
      const grip = page.getByRole('button', { name: `Drag project ${name}` })
      await expect(grip).toHaveAttribute('aria-disabled', 'true')
      await expect(grip).toHaveAccessibleDescription(
        /^Needs an instance-wide API token with the 'manage' scope\./,
      )
      const libcxx =
        /^Needs an API token with the 'manage' scope covering project 'libc\+\+' in full\./
      for (const control of [
        'Edit Name of libcxx',
        'Edit Display name of libcxx',
        'Delete project libcxx',
      ]) {
        const button = page.getByRole('button', { name: control })
        await expect(button).toBeDisabled()
        await expect(button).toHaveAttribute('title', libcxx)
      }

      await page.getByRole('button', { name: `Edit Display name of ${name}` }).click()
      await page.getByRole('textbox', { name: `Display name of ${name}` }).fill('Own project')
      await page.keyboard.press('Enter')
      await expect(
        page.getByRole('link', { name: '0 suites of Own project', exact: true }),
      ).toBeVisible()

      // The token follows the project to its new name (I5), so it can still change it.
      const prompt = page.getByRole('form', { name: 'Confirmation' })
      await page.getByRole('button', { name: `Edit Name of ${name}` }).click()
      await page.getByRole('textbox', { name: `Name of ${name}` }).fill(renamed)
      await page.keyboard.press('Enter')
      await prompt.getByRole('button', { name: 'OK' }).click()
      await expect(page.getByRole('button', { name: `Edit Name of ${renamed}` })).toBeEnabled()
      expect((await request.get(`/api/projects/${name}`)).status()).toBe(404)

      await page.getByRole('button', { name: `Delete project ${renamed}` }).click()
      await prompt.getByRole('button', { name: 'Delete' }).click()
      await expect(page.getByRole('button', { name: `Delete project ${renamed}` })).toHaveCount(0)
      expect((await request.get(`/api/projects/${renamed}`)).status()).toBe(404)
    } finally {
      await request.delete(`/api/projects/${name}`, { headers })
      await request.delete(`/api/projects/${renamed}`, { headers })
    }
  })
})
