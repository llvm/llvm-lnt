/**
 * The Test Suites page (TS1-TS7), against the seeded projects and suites (see tools/seed.ts).
 *
 * Other tests may add to the seeded projects and suites, so these look for what the seed holds
 * rather than assuming that it is all there is. Tests that write change a suite of their own.
 */

import { readFileSync } from 'node:fs'
import type { Dialog } from '@playwright/test'
import type { components } from '../client/src/api/schema.d.ts'
import { suitePath } from '../client/src/paths.ts'
import { EXPERIMENT, HARDENED, MACOS, TAG, TAGGED_INFO, UNTRACKED } from '../tools/synthetic.ts'
import { expect, json, test } from './fixtures.ts'
import { ownSuite, withOwnSuite } from './own-suite.ts'
import { pickOption } from './select.ts'
import { column, rows, settled, table } from './tables.ts'

/** The accessible name of the Runs tab's search. */
const RUNS_SEARCH = 'Search runs by machine, commit or UUID'

test("the Test Suites link shows every project's suites, under the project", async ({ page }) => {
  await page.goto('/')
  await page.getByRole('navigation').getByRole('link', { name: 'Test Suites', exact: true }).click()

  await expect(page).toHaveURL('/projects')
  // Other tests add projects of their own, so this looks at the seeded ones alone.
  const picker = page.getByRole('navigation', { name: 'Test suites' })
  const libcxx = picker.getByRole('region', { name: 'libc++', exact: true })
  await expect(libcxx.getByRole('heading', { name: 'libc++' }).getByRole('link')).toHaveAttribute(
    'href',
    '/projects/libcxx',
  )
  // Each suite by its own label, in AR22's order.
  await expect(libcxx.getByRole('link').filter({ hasNotText: 'libc++' })).toHaveText([
    'header-sizes',
    'Microbenchmarks',
  ])
  await expect(
    picker.getByRole('region', { name: 'LLVM', exact: true }).getByRole('link'),
  ).toHaveText(['LLVM', 'nts'])
  await expect(picker.getByRole('region', { name: 'swift', exact: true })).toContainText(
    'No test suites.',
  )
  await expect(page.getByRole('link', { name: 'All projects' })).toHaveCount(0)
  await expect(page.getByRole('tab')).toHaveCount(0)

  await page.goBack()
  await expect(page).toHaveURL('/')
})

test("a project's page shows its suites alone, and leads back to every project", async ({
  page,
}) => {
  await page.goto('/projects')
  const picker = page.getByRole('navigation', { name: 'Test suites' })
  await picker.getByRole('link', { name: 'LLVM', exact: true }).click()

  await expect(page).toHaveURL('/projects/llvm')
  await expect(picker.getByRole('heading')).toHaveText(['LLVM'])
  await expect(picker.getByRole('link', { name: 'nts', exact: true })).toBeVisible()
  await expect(page.getByRole('tab')).toHaveCount(0)

  await page.getByRole('link', { name: 'All projects' }).click()
  await expect(page).toHaveURL('/projects')
  await expect(picker.getByRole('heading', { name: 'libc++' })).toBeVisible()
})

test('picking a suite shows its runs', async ({ page }) => {
  await page.goto('/projects/libcxx')
  const picker = page.getByRole('navigation', { name: 'Test suites' })

  await picker.getByRole('link', { name: 'Microbenchmarks', exact: true }).click()

  await expect(page).toHaveURL('/projects/libcxx/suites/benchmarks')
  await expect(picker.getByRole('link', { name: 'Microbenchmarks', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(page.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true')
  await expect(rows(table(page, 'Runs'))).toHaveCount(25)
})

test('an unknown suite or project is reported', async ({ page }) => {
  await page.goto('/projects/libcxx/suites/nope')

  await expect(page.getByRole('alert')).toHaveText("Test suite 'libcxx/nope' not found.")
  await expect(page.getByRole('navigation', { name: 'Test suites' })).toBeVisible()

  await page.goto('/projects/nope')
  await expect(page.getByRole('alert')).toHaveText("Project 'nope' not found.")
  await expect(page.getByRole('link', { name: 'All projects' })).toBeVisible()
})

test.describe('the Runs tab', () => {
  test('shows each run with its commit by display value, and pages', async ({ page }) => {
    await page.goto('/projects/libcxx/suites/benchmarks')
    const runs = table(page, 'Runs')
    await expect(rows(runs)).toHaveCount(25)

    // Every libcxx commit but the experiment has an `svn_revision`, its display value.
    const tag = TAG.replaceAll('.', '\\.')
    const display = new RegExp(`^(r\\d+( \\(${tag}\\))?|${EXPERIMENT})$`)
    for (const commit of await column(runs, 2)) expect(commit).toMatch(display)
    await expect(rows(runs).first().locator('td').first()).toHaveText(/^[0-9a-f]{8}…$/)
    await expect(rows(runs).first().locator('td').last()).toHaveText(
      /^\d{4}-\d\d-\d\d, \d{1,2}:\d\d:\d\d [AP]M$/,
    )

    const first = await column(runs, 0)
    await page.getByRole('button', { name: /Next/ }).click()
    await expect.poll(() => column(runs, 0)).not.toEqual(first)
    await settled(runs)
    const second = await column(runs, 0)
    expect(second.filter((uuid) => first.includes(uuid))).toEqual([])
    await expect(page).toHaveURL('/projects/libcxx/suites/benchmarks')

    await page.getByRole('button', { name: /Previous/ }).click()
    await expect.poll(() => column(runs, 0)).toEqual(first)
    await expect(page.getByRole('button', { name: /Previous/ })).toBeDisabled()
  })

  test('links to the run, machine and commit pages', async ({ page }) => {
    await page.goto('/projects/libcxx/suites/benchmarks')
    const row = rows(table(page, 'Runs')).first()
    const links = row.getByRole('link')
    await expect(links).toHaveCount(3)

    const suite = '^/projects/libcxx/suites/benchmarks'
    await expect(links.nth(0)).toHaveAttribute('href', new RegExp(`${suite}/runs/[0-9a-f-]{36}$`))
    await expect(links.nth(1)).toHaveAttribute('href', new RegExp(`${suite}/machines/[^/]+$`))
    await expect(links.nth(2)).toHaveAttribute('href', new RegExp(`${suite}/commits/[^/]+$`))
    const uuid = (await links.nth(0).getAttribute('href'))!.split('/').at(-1)
    await links.nth(0).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Run: ${uuid}`)
  })

  test('searches on the machine', async ({ page }) => {
    await page.goto('/projects/libcxx/suites/benchmarks')
    await expect(rows(table(page, 'Runs'))).toHaveCount(25)

    await page.getByRole('searchbox', { name: RUNS_SEARCH }).fill('hardenedfast')

    await expect(page).toHaveURL('/projects/libcxx/suites/benchmarks?search=hardenedfast')
    const runs = table(page, 'Runs')
    await settled(runs)
    await expect.poll(async () => new Set(await column(runs, 1))).toEqual(new Set([HARDENED]))
  })

  test("searches on the commit: its tag, or its display field's value", async ({ page }) => {
    await page.goto('/projects/libcxx/suites/benchmarks')
    const runs = table(page, 'Runs')
    await expect(rows(runs)).toHaveCount(25)
    const search = page.getByRole('searchbox', { name: RUNS_SEARCH })

    await search.fill(TAG)
    await expect(page).toHaveURL(`/projects/libcxx/suites/benchmarks?search=${TAG}`)
    await settled(runs)
    await expect.poll(async () => (await column(runs, 2)).length).toBeGreaterThan(0)
    const commits = new Set(await column(runs, 2))
    expect(commits.size).toBe(1)
    const [tagged] = commits
    expect(tagged).toMatch(new RegExp(`^r\\d+ \\(${TAG.replaceAll('.', '\\.')}\\)$`))
    const byTag = await column(runs, 0)

    // The revision is the commit's `svn_revision`, a searchable field.
    const revision = tagged.split(' ')[0]
    await search.fill(revision)
    await expect(page).toHaveURL(`/projects/libcxx/suites/benchmarks?search=${revision}`)
    await settled(runs)
    await expect.poll(() => column(runs, 0)).toEqual(byTag)
    expect(new Set(await column(runs, 2))).toEqual(new Set([tagged]))
  })

  test('searches on a prefix of the UUID, as the table shortens it', async ({ page }) => {
    await page.goto('/projects/libcxx/suites/benchmarks')
    const runs = table(page, 'Runs')
    await expect(rows(runs)).toHaveCount(25)
    const shown = (await column(runs, 0))[7]
    const prefix = shown.replace('…', '')
    expect(prefix).toMatch(/^[0-9a-f]{8}$/)

    await page.getByRole('searchbox', { name: RUNS_SEARCH }).fill(prefix)

    await expect(page).toHaveURL(`/projects/libcxx/suites/benchmarks?search=${prefix}`)
    await settled(runs)
    await expect.poll(() => column(runs, 0)).toContain(shown)
    for (const uuid of await column(runs, 0)) expect(uuid.startsWith(prefix)).toBe(true)
  })
})

test.describe('the Machines tab', () => {
  test('shows every machine with its listed fields, marking the untracked one', async ({
    page,
    request,
  }) => {
    await page.goto('/projects/libcxx/suites/benchmarks?tab=machines')
    const machines = table(page, 'Machines')

    // Not `test_suite_commit` nor `sdk`, which the seeded schema does not list.
    await expect(machines.getByRole('columnheader')).toHaveText([
      'Name',
      'hardware',
      'os',
      'compiler',
    ])
    const macos = rows(machines).filter({ has: page.getByRole('link', { name: MACOS }) })
    await expect(macos.locator('td')).toHaveText([
      MACOS,
      'Apple M4',
      'macOS 26.5 (25F71)',
      /^Apple clang version 21\.0\.0/,
    ])
    const untracked = rows(machines).filter({ has: page.getByRole('link', { name: UNTRACKED }) })
    await expect(untracked.getByText('untracked', { exact: true })).toHaveAttribute(
      'title',
      /Dashboard/,
    )
    await expect(macos.getByText('untracked', { exact: true })).toHaveCount(0)

    // Every machine of the suite, in one table with no pager (E2).
    const listed = await request.get('/api/projects/libcxx/suites/benchmarks/machines')
    expect(listed.status()).toBe(200)
    await expect(rows(machines)).toHaveCount((await listed.json()).items.length)
    await expect(page.getByRole('navigation', { name: /pagination/ })).toHaveCount(0)
  })

  test('a deep link restores the tab and the search', async ({ page }) => {
    await page.goto('/projects/libcxx/suites/benchmarks?tab=machines&search=hardenedfast')

    await expect(page.getByRole('tab', { name: 'Machines' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(page.getByRole('searchbox', { name: 'Search machines' })).toHaveValue(
      'hardenedfast',
    )
    await expect.poll(() => column(table(page, 'Machines'), 0)).toEqual([HARDENED])
  })
})

test.describe('the Commits tab', () => {
  test('shows display values without the tag, listed fields, and -- for what is missing', async ({
    page,
  }) => {
    await page.goto('/projects/libcxx/suites/benchmarks?tab=commits')
    const commits = table(page, 'Commits')
    await expect(rows(commits)).toHaveCount(25)

    const search = page.getByRole('searchbox', { name: 'Search commits' })
    await search.fill('experiment')
    await expect(page).toHaveURL('/projects/libcxx/suites/benchmarks?tab=commits&search=experiment')
    const experiment = rows(commits).filter({
      has: page.getByRole('link', { name: EXPERIMENT, exact: true }),
    })
    // Its `commit_info` is long, and is cut short, whole on hover and to assistive technology.
    const info = 'A/B experiment: a faster floating-point path for std::format'
    await expect(experiment.locator('td')).toHaveText([EXPERIMENT, '--', '--', /^A\/B /])
    const cut = experiment.locator('td').last().getByTitle(info)
    await expect(cut).toHaveText(/^A\/B .*…$/)
    await expect(cut).toHaveAttribute('aria-hidden', 'true')
    await expect(experiment.getByText(info, { exact: true })).toBeAttached()

    await search.fill(TAG)
    await settled(commits)
    const tagged = rows(commits).filter({ hasText: TAG }).first()
    await expect(tagged.locator('td')).toHaveText([/^r\d+$/, /^\d+$/, TAG, /./])
    // Its `commit_info`, whole, though the cell shows it cut short.
    await expect(tagged.getByText(TAGGED_INFO, { exact: true })).toBeAttached()
  })

  test('pages through the commits, most recently seen first', async ({ page }) => {
    await page.goto('/projects/libcxx/suites/benchmarks?tab=commits')
    const commits = table(page, 'Commits')
    await expect(rows(commits)).toHaveCount(25)
    const first = await column(commits, 0)

    await page.getByRole('button', { name: /Next/ }).click()

    await expect.poll(() => column(commits, 0)).not.toEqual(first)
    await settled(commits)
    const second = await column(commits, 0)
    expect(second.filter((commit) => first.includes(commit))).toEqual([])
  })
})

test('Back leaves the page rather than stepping through its settings', async ({ page }) => {
  await page.goto('/projects/libcxx/suites/header-sizes')
  await page.getByRole('link', { name: 'Microbenchmarks', exact: true }).click()
  await expect(page).toHaveURL('/projects/libcxx/suites/benchmarks')

  await page.getByRole('tab', { name: 'Machines' }).click()
  await page.getByRole('searchbox', { name: 'Search machines' }).fill('macos')
  await expect(page).toHaveURL('/projects/libcxx/suites/benchmarks?tab=machines&search=macos')
  await page.getByRole('tab', { name: 'Commits' }).click()
  await expect(page).toHaveURL('/projects/libcxx/suites/benchmarks?tab=commits')

  await page.goBack()
  await expect(page).toHaveURL('/projects/libcxx/suites/header-sizes')
})

test.describe('the Schema tab', () => {
  test('shows the schema of a seeded suite to anyone', async ({ page }) => {
    await page.goto('/projects/libcxx/suites/benchmarks')
    await page.getByRole('tab', { name: 'Schema' }).click()

    await expect(page).toHaveURL('/projects/libcxx/suites/benchmarks?tab=schema')
    await expect(rows(table(page, 'Metrics')).first().locator('td')).toHaveText([
      'execution_time',
      'real',
      'Execution Time',
      'seconds (s)',
      'No',
      'Yes',
    ])
    await expect(page.getByRole('group', { name: 'Repository' })).toHaveText(
      'Label' +
        'GitHub' +
        'Commit URL' +
        'https://github.com/llvm/llvm-project/commit/{commit}' +
        'Range URL' +
        'https://github.com/llvm/llvm-project/compare/{from}...{to}',
    )
    await expect(page.getByRole('button', { name: 'Delete This Suite' })).toBeDisabled()
  })

  test('lets a manage token restricted to a suite edit and delete it, and no other', async ({
    page,
    request,
    signIn,
    tokenFor,
  }, testInfo) => {
    await ownSuite(request, tokenFor, testInfo, [], async (suite) => {
      await signIn(page, 'manage', [suite])
      await page.goto(`${suitePath(suite)}?tab=schema`)
      await expect(page.getByRole('button', { name: 'Edit schema' })).toBeEnabled()
      await expect(page.getByRole('button', { name: 'Delete This Suite' })).toBeEnabled()

      await page.goto('/projects/libcxx/suites/benchmarks?tab=schema')
      await expect(table(page, 'Metrics')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Edit schema' })).toBeDisabled()
      await expect(page.getByRole('button', { name: 'Delete This Suite' })).toBeDisabled()
    })
  })

  test('downloads the schema of a suite of its own, and deletes the suite', async ({
    page,
    request,
    signIn,
    tokenFor,
  }, testInfo) => {
    await ownSuite(request, tokenFor, testInfo, [], async (suite) => {
      await signIn(page, 'manage')
      await page.goto(`${suitePath(suite)}?tab=schema`)
      await expect(table(page, 'Metrics')).toBeVisible()

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: 'Download JSON' }).click(),
      ])
      expect(download.suggestedFilename()).toBe(`${suite.suite}.json`)
      const downloaded = JSON.parse(readFileSync(await download.path(), 'utf8'))
      expect(downloaded).toEqual(await json(request, `/api${suitePath(suite)}`))

      await page.getByRole('button', { name: 'Delete This Suite' }).click()
      const prompt = page.getByRole('form', { name: 'Confirmation' })
      await prompt.getByRole('textbox').fill(suite.suite)
      await prompt.getByRole('button', { name: 'Delete' }).click()

      // The page leaves for the suites of the project, which has none left.
      await expect(page).toHaveURL(`/projects/${suite.project}`)
      const picker = page.getByRole('navigation', { name: 'Test suites' })
      await expect(picker.getByRole('region', { name: suite.project, exact: true })).toContainText(
        'No test suites.',
      )
      expect((await request.get(`/api${suitePath(suite)}`)).status()).toBe(404)
    })
  })

  test("edits a suite's schema, confirming a removal", async ({
    page,
    request,
    signIn,
    tokenFor,
  }, testInfo) => {
    const token = await tokenFor('manage')
    await withOwnSuite(request, token, testInfo, async (suite) => {
      const created = await request.post(`/api/projects/${suite.project}/suites`, {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          name: suite.suite,
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
      await page.goto(`${suitePath(suite)}?tab=schema`)

      await page.getByRole('button', { name: 'Edit schema' }).click()
      // Named by its full label (AR22).
      const editor = page.getByRole('region', { name: `Editing ${suite.project}/${suite.suite}` })
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
      await prompt.getByRole('textbox').fill(suite.suite)
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
        `/api${suitePath(suite)}`,
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

  test("edits a suite's display name and repository", async ({
    page,
    request,
    signIn,
    tokenFor,
  }, testInfo) => {
    const token = await tokenFor('manage')
    await withOwnSuite(request, token, testInfo, async (suite) => {
      const created = await request.post(`/api/projects/${suite.project}/suites`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { name: suite.suite, repository: { label: 'Forge' } },
      })
      expect(created.status(), await created.text()).toBe(201)
      await signIn(page, 'manage')
      await page.goto(`${suitePath(suite)}?tab=schema`)

      await page.getByRole('button', { name: 'Edit schema' }).click()
      const editor = page.getByRole('region', { name: `Editing ${suite.project}/${suite.suite}` })
      const save = editor.getByRole('button', { name: 'Save', exact: true })
      const commitUrl = editor.getByRole('textbox', { name: 'Commit URL' })
      // Refused while the host is not written out.
      await commitUrl.fill('https://{commit}.example.com/')
      await expect(commitUrl).toHaveAttribute('aria-invalid', 'true')
      await expect(save).toBeDisabled()
      await commitUrl.fill('https://git.example.com/commit/{commit}')
      await editor.getByRole('textbox', { name: 'Label' }).fill('')
      await editor.getByRole('textbox', { name: 'Display name', exact: true }).fill('Forge suite')
      await save.click()

      await expect(editor).toBeHidden()
      await expect(page.getByRole('group', { name: 'Suite' })).toHaveText(
        `Project${suite.project}Name${suite.suite}Display nameForge suite`,
      )
      // The suite's card is named by its display name (AR22).
      await expect(
        page.getByRole('navigation', { name: 'Test suites' }).getByRole('link', {
          name: 'Forge suite',
        }),
      ).toHaveAttribute('aria-current', 'page')
      await expect(page.getByRole('group', { name: 'Repository' })).toHaveText(
        'Label--Commit URLhttps://git.example.com/commit/{commit}Range URL--',
      )
      const schema = await json<components['schemas']['SuiteSchema']>(
        request,
        `/api${suitePath(suite)}`,
      )
      expect(schema.display_name).toBe('Forge suite')
      expect(schema.repository).toEqual({
        label: null,
        commit_url: 'https://git.example.com/commit/{commit}',
        range_url: null,
      })
    })
  })

  test('renames a suite of its own, then moves it to another project', async ({
    page,
    request,
    signIn,
    tokenFor,
  }, testInfo) => {
    const token = await tokenFor('manage')
    const headers = { Authorization: `Bearer ${token}` }
    await withOwnSuite(request, token, testInfo, async (suite) => {
      const created = await request.post(`/api/projects/${suite.project}/suites`, {
        headers,
        data: { name: suite.suite },
      })
      expect(created.status(), await created.text()).toBe(201)
      const other = `${suite.project}-q`
      const renamed = { project: suite.project, suite: 'renamed' }
      const moved = { project: other, suite: 'renamed' }
      expect((await request.post('/api/projects', { headers, data: { name: other } })).status()).toBe(
        201,
      )
      try {
        await signIn(page, 'manage')
        // From another page, for Back to have an entry of the SPA to go back to.
        await page.goto('/projects')
        await page.goto(`${suitePath(suite)}?tab=schema`)
        const move = page.getByRole('button', { name: 'Rename or move' })
        const panel = page.getByRole('form', { name: 'Rename or move' })
        const prompt = page.getByRole('form', { name: 'Confirmation' })

        await move.click()
        await panel.getByRole('textbox', { name: 'Name' }).fill('renamed')
        await panel.getByRole('button', { name: 'Save' }).click()
        await expect(prompt).toContainText(
          `Rename the test suite ${suite.project}/${suite.suite} to ${suite.project}/renamed?`,
        )
        await expect(prompt).toContainText('API keys are unaffected.')
        await prompt.getByRole('button', { name: 'OK' }).click()

        // The page of the new names takes the place of the old one in the history (AR16).
        await expect(page).toHaveURL(`${suitePath(renamed)}?tab=schema`)
        await expect(move).toBeFocused()
        await page.goBack()
        await expect(page).toHaveURL('/projects')
        await page.goto(`${suitePath(suite)}?tab=schema`)
        await expect(page.getByRole('alert')).toHaveText(
          `Test suite '${suite.project}/${suite.suite}' not found.`,
        )

        await page.goto(`${suitePath(renamed)}?tab=schema`)
        await move.click()
        await pickOption(panel, 'Project', other)
        await panel.getByRole('button', { name: 'Save' }).click()
        await expect(prompt).toContainText(
          `API keys listing the project '${suite.project}' as a whole will no longer cover the ` +
            `suite, those listing the project '${other}' as a whole will`,
        )
        await prompt.getByRole('button', { name: 'OK' }).click()

        await expect(page).toHaveURL(`${suitePath(moved)}?tab=schema`)
        await expect(move).toBeFocused()
        const picker = page.getByRole('navigation', { name: 'Test suites' })
        await expect(picker.getByRole('link', { name: 'renamed', exact: true })).toBeVisible()
        expect((await request.get(`/api${suitePath(moved)}`)).status()).toBe(200)
      } finally {
        await request.delete(`/api${suitePath(moved)}?confirm=true`, { headers })
        await request.delete(`/api${suitePath(renamed)}?confirm=true`, {
          headers,
        })
        await request.delete(`/api/projects/${other}`, { headers })
      }
    })
  })

  test('asks before the changes of the editor are lost by leaving it', async ({ page, signIn }) => {
    /** Accept or dismiss the next dialog; returns its type and message, for the test to check. */
    function answerNext(accept: boolean) {
      return new Promise<{ type: string; message: string }>((resolve) => {
        page.once('dialog', async (dialog) => {
          await (accept ? dialog.accept() : dialog.dismiss())
          resolve({ type: dialog.type(), message: dialog.message() })
        })
      })
    }
    const CONFIRM = { type: 'confirm', message: 'You have unsaved changes. Leave anyway?' }

    await signIn(page, 'manage')
    // From another suite, for Back to have an entry of the SPA to go back to.
    await page.goto('/projects/libcxx/suites/header-sizes')
    const picker = page.getByRole('navigation', { name: 'Test suites' })
    await picker.getByRole('link', { name: 'Microbenchmarks' }).click()
    await page.getByRole('tab', { name: 'Schema' }).click()
    await page.getByRole('button', { name: 'Edit schema' }).click()
    const editor = page.getByRole('region', { name: 'Editing libc++/Microbenchmarks' })
    const displayName = editor.getByRole('textbox', {
      name: 'Display name of metric execution_time',
    })
    await displayName.fill('Not saved')

    // Staying keeps the editor, with its changes. A tab asks once its click is done, and nothing
    // asks again until the user tries to leave again, wherever the pointer goes meanwhile.
    const stayed: string[] = []
    const stay = (dialog: Dialog) => {
      stayed.push(dialog.message())
      void dialog.dismiss()
    }
    page.on('dialog', stay)
    const runs = page.getByRole('tab', { name: 'Runs' })
    const machines = page.getByRole('tab', { name: 'Machines' })
    await runs.hover()
    await page.mouse.down()
    await machines.hover()
    await runs.hover()
    await page.mouse.up()
    await expect.poll(() => stayed).toEqual([CONFIRM.message])
    await machines.hover()
    await runs.hover()
    // A dialog that should not open has nothing to wait for.
    await page.waitForTimeout(1000)
    expect(stayed).toEqual([CONFIRM.message])
    page.off('dialog', stay)
    let asked = answerNext(false)
    await page.goBack()
    expect(await asked).toEqual(CONFIRM)
    await expect(page).toHaveURL('/projects/libcxx/suites/benchmarks?tab=schema')
    await expect(displayName).toHaveValue('Not saved')

    // Leaving discards them.
    asked = answerNext(true)
    await page.getByRole('tab', { name: 'Runs' }).click()
    expect(await asked).toEqual(CONFIRM)
    await expect(page).toHaveURL('/projects/libcxx/suites/benchmarks')
    await page.getByRole('tab', { name: 'Schema' }).click()
    await expect(editor).toBeHidden()
    await expect(rows(table(page, 'Metrics')).first().locator('td').nth(2)).toHaveText(
      'Execution Time',
    )

    // Reloading discards them too, once the browser has asked. (Not staying, which the unit tests
    // cover: Playwright loses track of the page once a reload is cancelled.)
    await page.getByRole('button', { name: 'Edit schema' }).click()
    await displayName.fill('Not saved')
    asked = answerNext(true)
    await page.reload()
    expect((await asked).type).toBe('beforeunload')
    await expect(editor).toBeHidden()
  })
})
