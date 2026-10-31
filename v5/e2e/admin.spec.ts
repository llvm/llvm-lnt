/**
 * The Admin page's API Keys tab (AD1), Projects tab (AD3) and Test Suites tab (AD2).
 *
 * Tests that write change what they create: a key of their own to revoke, and a project or a suite
 * of their own to change and delete. The seeded projects and suites and the harness's admin key are
 * left alone.
 */

import type { APIRequestContext, Page } from '@playwright/test'
import type { components } from '../client/src/api/schema.d.ts'
import { PERMISSION_DENIED } from '../client/src/api/permission-denied.ts'
import { suitePath } from '../client/src/paths.ts'
import { BENCHMARKS, expect, json, NTS, test } from './fixtures.ts'
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
      'All',
      /^\d{4}-\d\d-\d\d, /,
      'Never',
      'Yes',
      'Revoke',
    ])
    // Using the token records its last use, so this must come after checking the row says 'Never'.
    expect((await keyOf(request, token))?.name).toBe(name)

    await revoke(page, prefix)

    await expect(row.locator('td').nth(6)).toHaveText('No')
    await expect(row.getByRole('button')).toHaveCount(0)
    expect(await keyOf(request, token)).toBeNull()

    // The token is shown only until the user leaves the tab.
    await page.getByRole('tab', { name: 'Test Suites' }).click()
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
    await page.getByRole('option', { name: 'libc++', exact: true }).click()
    // The project's suites are then checked, and stay so.
    const benchmarks = page.getByRole('option', { name: /^libc\+\+\/Microbenchmarks: Covered/ })
    await expect(benchmarks).toHaveAttribute('aria-selected', 'true')
    await benchmarks.click()
    await expect(benchmarks).toHaveAttribute('aria-selected', 'true')
    // Each suite by its full label (AR22).
    await page.getByRole('option', { name: 'LLVM/nts', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(covers).toHaveText(/libc\+\+ \(all\), LLVM\/nts/)
    await expect(covers).toBeFocused()
    await form.getByRole('button', { name: 'Create key' }).click()

    const created = page.getByRole('region', { name: 'Created key' })
    const token = (await created.locator('code').textContent()) ?? ''
    const row = rows(keys).filter({ hasText: token.slice(0, 8) })
    await expect(row.locator('td').nth(3)).toHaveText('libc++ (all), LLVM/nts')
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
      // Keys never used come last, whichever the direction.
      const lastUsed = await column(keys, 5)
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
  test('creates a suite in the project a manage token covers in full, and only there', async ({
    page,
    request,
    signIn,
    tokenFor,
  }, testInfo) => {
    await withOwnSuite(request, await tokenFor('manage'), testInfo, async (suite) => {
      await signIn(page, 'manage', [{ project: suite.project, suite: null }])
      await page.goto('/admin?tab=suites')
      await page.getByRole('button', { name: 'New suite' }).click()
      const editor = page.getByRole('region', { name: 'New suite' })

      // The other projects are refused, saying why (AD2, TS7).
      await selectButton(editor, 'Project').click()
      await expect(page.getByRole('option', { name: /^libc\+\+/ })).toContainText(
        "Needs an API token with the 'manage' scope covering project 'libc++' in full.",
      )
      await page.keyboard.press('Escape')
      await pickOption(editor, 'Project', suite.project)
      await editor.getByRole('textbox', { name: 'Suite name' }).fill(suite.suite)
      await editor.getByRole('button', { name: 'Create', exact: true }).click()

      await expect(page).toHaveURL(`${suitePath(suite)}?tab=schema`)
    })
  })

  test('creates no suite with a manage token restricted to a suite', async ({ page, signIn }) => {
    await signIn(page, 'manage', [BENCHMARKS])
    await page.goto('/admin?tab=suites')

    // A suite is created in a project, which the token would have to cover in full (AD2).
    const newSuite = page.getByRole('button', { name: 'New suite' })
    await expect(newSuite).toBeDisabled()
    await expect(newSuite).toHaveAttribute(
      'title',
      /^Needs an API token with the 'manage' scope covering a project in full\./,
    )
  })

  test('creates a suite in the editor, starting from a seeded suite', async ({
    page,
    request,
    signIn,
    tokenFor,
  }, testInfo) => {
    await withOwnSuite(request, await tokenFor('manage'), testInfo, async (suite) => {
      await signIn(page, 'manage')
      await page.goto('/admin?tab=suites')
      await page.getByRole('button', { name: 'New suite' }).click()
      const editor = page.getByRole('region', { name: 'New suite' })
      await pickOption(editor, 'Project', suite.project)
      await editor.getByRole('textbox', { name: 'Suite name' }).fill(suite.suite)
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
      await page.goto('/admin?tab=suites')
      await page.getByRole('button', { name: 'New suite' }).click()
      const editor = page.getByRole('region', { name: 'New suite' })
      // The document goes to the project picked, which comes first.
      await expect(editor.getByRole('button', { name: 'Import JSON' })).toBeDisabled()
      await pickOption(editor, 'Project', suite.project)
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
      await page.goto('/admin?tab=suites')
      await page.getByRole('button', { name: 'New suite' }).click()
      const creator = page.getByRole('region', { name: 'New suite' })
      await pickOption(creator, 'Project', suite.project)
      await creator.getByRole('textbox', { name: 'Suite name' }).fill(suite.suite)
      for (const metric of ['execution_time', 'compile_time']) {
        await creator.getByRole('button', { name: '+ Add metric' }).click()
        await creator.getByRole('textbox', { name: /^Name of metric \d+$/ }).last().fill(metric)
      }
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
      await expect(machines.getByRole('columnheader')).toHaveText(['Name'])
      await machines.getByRole('link', { name: 'm1', exact: true }).click()
      await table(page, 'Run history').getByRole('link').first().click()
      await expect(page).toHaveURL(`${suitePath(suite)}/runs/${run}`)
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
      const editor = page.getByRole('region', { name: `Editing ${suite.project}/${suite.suite}` })
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
      const metric = page.getByRole('button', { name: / Metric$/ })
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
      await expect(machines.getByRole('columnheader')).toHaveText(['Name', 'hardware'])
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
        `${name}Edit`,
        `${name} labelEdit`,
        '0',
        'Delete',
      ])
      await expect(form.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('')

      await page.getByRole('button', { name: `Edit Display name of ${name}` }).click()
      await page.getByRole('textbox', { name: `Display name of ${name}` }).fill('E2E project')
      await page.keyboard.press('Enter')
      await expect(row(name).locator('td').nth(1)).toHaveText('E2E projectEdit')

      await page.getByRole('button', { name: `Edit Name of ${name}` }).click()
      await page.getByRole('textbox', { name: `Name of ${name}` }).fill(renamed)
      await page.keyboard.press('Enter')
      const prompt = page.getByRole('form', { name: 'Confirmation' })
      await expect(prompt).toContainText(
        `Every URL, bookmark and bot that uses the name ${name} for any of the project's suites`,
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

      // Its suites, of which it has none, on the Test Suites page (TS1).
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

  test('lets a token covering a project in full change its display name, and nothing else', async ({
    page,
    request,
    signIn,
    tokenFor,
  }, testInfo) => {
    await withOwnSuite(request, await tokenFor('manage'), testInfo, async ({ project }) => {
      await signIn(page, 'manage', [{ project, suite: null }])
      await page.goto('/admin?tab=projects')

      const instanceWide = /^Needs an instance-wide API token with the 'manage' scope\./
      const create = page.getByRole('button', { name: 'Create project' })
      await expect(create).toBeDisabled()
      await expect(create).toHaveAttribute('title', instanceWide)
      for (const control of [`Edit Name of ${project}`, `Delete project ${project}`]) {
        const button = page.getByRole('button', { name: control })
        await expect(button).toBeDisabled()
        await expect(button).toHaveAttribute('title', instanceWide)
      }
      await expect(page.getByRole('button', { name: 'Edit Display name of libcxx' })).toBeDisabled()

      await page.getByRole('button', { name: `Edit Display name of ${project}` }).click()
      await page.getByRole('textbox', { name: `Display name of ${project}` }).fill('Own project')
      await page.keyboard.press('Enter')
      await expect(
        page.getByRole('link', { name: '0 suites of Own project', exact: true }),
      ).toBeVisible()
      const path = `/api/projects/${project}`
      const shown = await json<components['schemas']['Project']>(request, path)
      expect(shown.display_name).toBe('Own project')
    })
  })
})
