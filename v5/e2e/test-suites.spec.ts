/**
 * The Test Suites page (TS1-TS4), against the seeded libcxx suite.
 *
 * Other tests may add to the seeded suites, so these look for what the seed holds rather than
 * assuming that it is all there is.
 */

import { EXPERIMENT, HARDENED, MACOS, TAG, UNTRACKED } from '../tools/synthetic.ts'
import { expect, test } from './fixtures.ts'
import { column, rows, settled, table } from './tables.ts'

/** The accessible name of the Runs tab's search. */
const RUNS_SEARCH = 'Search runs by machine, commit or UUID'

test('the Test Suites link selects the first suite, in place of /suites', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('navigation').getByRole('link', { name: 'Test Suites', exact: true }).click()

  // The first suite may be another test's, which it may delete at any time, so this looks at
  // nothing read from inside the suite.
  await expect(page).toHaveURL(/\/suites\/[^/?]+$/)
  const first = page.getByRole('navigation', { name: 'Test suites' }).getByRole('link').first()
  await expect(first).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true')

  await page.goBack()
  await expect(page).toHaveURL('/')
})

test('picking a suite shows its runs', async ({ page }) => {
  await page.goto('/suites/nts')
  const picker = page.getByRole('navigation', { name: 'Test suites' })

  await picker.getByRole('link', { name: 'libcxx', exact: true }).click()

  await expect(page).toHaveURL('/suites/libcxx')
  await expect(picker.getByRole('link', { name: 'libcxx', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(page.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true')
  await expect(rows(table(page, 'Runs'))).toHaveCount(25)
})

test('an unknown suite is reported, alongside the picker', async ({ page }) => {
  await page.goto('/suites/nope')

  await expect(page.getByRole('alert')).toHaveText("Test suite 'nope' not found.")
  await expect(page.getByRole('navigation', { name: 'Test suites' })).toBeVisible()
})

test.describe('the Runs tab', () => {
  test('shows each run with its commit by display value, and pages', async ({ page }) => {
    await page.goto('/suites/libcxx')
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
    await expect(page).toHaveURL('/suites/libcxx')

    await page.getByRole('button', { name: /Previous/ }).click()
    await expect.poll(() => column(runs, 0)).toEqual(first)
    await expect(page.getByRole('button', { name: /Previous/ })).toBeDisabled()
  })

  test('links to the run, machine and commit pages', async ({ page }) => {
    await page.goto('/suites/libcxx')
    const row = rows(table(page, 'Runs')).first()
    const links = row.getByRole('link')
    await expect(links).toHaveCount(3)

    await expect(links.nth(0)).toHaveAttribute('href', /^\/suites\/libcxx\/runs\/[0-9a-f-]{36}$/)
    await expect(links.nth(1)).toHaveAttribute('href', /^\/suites\/libcxx\/machines\/[^/]+$/)
    await expect(links.nth(2)).toHaveAttribute('href', /^\/suites\/libcxx\/commits\/[^/]+$/)
    const uuid = (await links.nth(0).getAttribute('href'))!.split('/').at(-1)
    await links.nth(0).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Run: ${uuid}`)
  })

  test('searches on the machine', async ({ page }) => {
    await page.goto('/suites/libcxx')
    await expect(rows(table(page, 'Runs'))).toHaveCount(25)

    await page.getByRole('searchbox', { name: RUNS_SEARCH }).fill('hardenedfast')

    await expect(page).toHaveURL('/suites/libcxx?search=hardenedfast')
    const runs = table(page, 'Runs')
    await settled(runs)
    await expect.poll(async () => new Set(await column(runs, 1))).toEqual(new Set([HARDENED]))
  })

  test("searches on the commit: its tag, or its display field's value", async ({ page }) => {
    await page.goto('/suites/libcxx')
    const runs = table(page, 'Runs')
    await expect(rows(runs)).toHaveCount(25)
    const search = page.getByRole('searchbox', { name: RUNS_SEARCH })

    await search.fill(TAG)
    await expect(page).toHaveURL(`/suites/libcxx?search=${TAG}`)
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
    await expect(page).toHaveURL(`/suites/libcxx?search=${revision}`)
    await settled(runs)
    await expect.poll(() => column(runs, 0)).toEqual(byTag)
    expect(new Set(await column(runs, 2))).toEqual(new Set([tagged]))
  })

  test('searches on a prefix of the UUID, as the table shortens it', async ({ page }) => {
    await page.goto('/suites/libcxx')
    const runs = table(page, 'Runs')
    await expect(rows(runs)).toHaveCount(25)
    const shown = (await column(runs, 0))[7]
    const prefix = shown.replace('…', '')
    expect(prefix).toMatch(/^[0-9a-f]{8}$/)

    await page.getByRole('searchbox', { name: RUNS_SEARCH }).fill(prefix)

    await expect(page).toHaveURL(`/suites/libcxx?search=${prefix}`)
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
    await page.goto('/suites/libcxx?tab=machines')
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
    const listed = await request.get('/api/suites/libcxx/machines')
    expect(listed.status()).toBe(200)
    await expect(rows(machines)).toHaveCount((await listed.json()).items.length)
    await expect(page.getByRole('navigation', { name: /pagination/ })).toHaveCount(0)
  })

  test('a deep link restores the tab and the search', async ({ page }) => {
    await page.goto('/suites/libcxx?tab=machines&search=hardenedfast')

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
    await page.goto('/suites/libcxx?tab=commits')
    const commits = table(page, 'Commits')
    await expect(rows(commits)).toHaveCount(25)

    const search = page.getByRole('searchbox', { name: 'Search commits' })
    await search.fill('experiment')
    await expect(page).toHaveURL('/suites/libcxx?tab=commits&search=experiment')
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
    await expect(tagged.locator('td')).toHaveText([
      /^r\d+$/,
      /^\d+$/,
      TAG,
      /^\[libc\+\+\] Synthetic commit \d+ of \d+$/,
    ])
  })

  test('pages through the commits, most recently seen first', async ({ page }) => {
    await page.goto('/suites/libcxx?tab=commits')
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
  await page.goto('/suites/nts')
  await page.getByRole('link', { name: 'libcxx', exact: true }).click()
  await expect(page).toHaveURL('/suites/libcxx')

  await page.getByRole('tab', { name: 'Machines' }).click()
  await page.getByRole('searchbox', { name: 'Search machines' }).fill('macos')
  await expect(page).toHaveURL('/suites/libcxx?tab=machines&search=macos')
  await page.getByRole('tab', { name: 'Commits' }).click()
  await expect(page).toHaveURL('/suites/libcxx?tab=commits')

  await page.goBack()
  await expect(page).toHaveURL('/suites/nts')
})
