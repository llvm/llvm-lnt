/**
 * The Commit Detail page (DT3).
 *
 * Reading tests use the seeded libcxx suite (tools/synthetic.ts). Tests that write use a suite of
 * their own (see own-suite.ts).
 */

import type { APIRequestContext, Page } from '@playwright/test'
import type { components } from '../client/src/api/schema.d.ts'
import { EXPERIMENT, HARDENED, LINUX, MACOS, TAG, uuidFor } from '../tools/synthetic.ts'
import { expect, json, test } from './fixtures.ts'
import { ownSuite, type OwnRun } from './own-suite.ts'
import { column, rows, table } from './tables.ts'

type Schemas = components['schemas']

/** The seeded commit tagged `TAG`, measured once on each tracked machine. */
async function taggedCommit(request: APIRequestContext) {
  const commits = await json<Schemas['CommitCursorPage']>(
    request,
    `/api/suites/libcxx/commits?search=${TAG}`,
  )
  return commits.items.find((commit) => commit.tag === TAG)!
}

/** The page's link named `name`. */
function link(page: Page, name: string) {
  return page.getByRole('main').getByRole('link', { name, exact: true })
}

test('the Commits tab links to the page of each commit', async ({ page, request }) => {
  const commit = await taggedCommit(request)
  await page.goto(`/suites/libcxx?tab=commits&search=${TAG}`)

  const revision = commit.fields.svn_revision as string
  await table(page, 'Commits').getByRole('link', { name: revision }).click()

  await expect(page).toHaveURL(`/suites/libcxx/commits/${commit.value}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Commit: ${commit.value}`)
})

test('shows the commit, its neighbours and its runs, filtered by machine', async ({
  page,
  request,
}) => {
  const commit = await taggedCommit(request)
  const detail = await json<Schemas['CommitDetail']>(
    request,
    `/api/suites/libcxx/commits/${commit.value}`,
  )
  await page.goto(`/suites/libcxx/commits/${commit.value}`)

  const info = page.getByRole('group', { name: 'Commit', exact: true })
  await expect(info).toContainText(String(commit.ordinal))
  await expect(info).toContainText(TAG)
  await expect(info).toContainText('[libc++] Synthetic commit 20 of 40')
  await expect(link(page, '← Previous commit')).toHaveAttribute(
    'href',
    `/suites/libcxx/commits/${detail.previous!.value}`,
  )
  await expect(link(page, 'Next commit →')).toHaveAttribute(
    'href',
    `/suites/libcxx/commits/${detail.next!.value}`,
  )

  const runs = table(page, 'Runs')
  await expect(page.getByText('3 runs across 3 machines')).toBeVisible()
  expect(await column(runs, 0)).toEqual([LINUX, MACOS, HARDENED].sort())
  await page.getByRole('searchbox', { name: 'Filter machines' }).fill('linux')
  await expect(page.getByText('1 of 3 runs across 1 of 3 machines')).toBeVisible()
  await expect(rows(runs)).toHaveCount(1)
  await expect(page).toHaveURL(`/suites/libcxx/commits/${commit.value}?machine_filter=linux`)

  // The commit before this one on the machine is the previous one, at which it also has runs.
  const compare = rows(runs).first().getByRole('link', { name: 'Compare with previous' })
  await expect(compare).toHaveAttribute('href', /^\/compare\?/)
  const query = new URL((await compare.getAttribute('href'))!, 'http://x').searchParams
  expect(query.get('commit_a')).toBe(detail.previous!.value)
  expect(query.get('commit_b')).toBe(commit.value)
  expect(query.get('machine_a')).toBe(LINUX)
})

test('lists the regressions attributed to the commit', async ({ page, request }) => {
  const regression = await json<Schemas['RegressionDetail']>(
    request,
    `/api/suites/libcxx/regressions/${uuidFor('libcxx/regression/format')}`,
  )
  await page.goto(`/suites/libcxx/commits/${regression.commit}`)

  const regressions = table(page, 'Regressions')
  await expect(regressions).toContainText('std::format slowdown')
  const uuid = regressions.getByRole('link', { name: `${regression.uuid.slice(0, 8)}…` })
  await expect(uuid).toHaveAttribute('href', `/suites/libcxx/regressions/${regression.uuid}`)
})

test('has no neighbours, nor previous commits, for a commit with no ordinal', async ({ page }) => {
  await page.goto(`/suites/libcxx/commits/${EXPERIMENT}`)

  for (const name of ['← Previous commit', 'Next commit →']) {
    await expect(link(page, name)).toHaveAttribute('aria-disabled', 'true')
    await expect(link(page, name)).toHaveAttribute('title', 'This commit has no ordinal.')
  }
  const runs = table(page, 'Runs')
  const compare = rows(runs).first().getByRole('link', { name: 'Compare with previous' })
  await expect(compare).toHaveAttribute('title', 'This commit has no ordinal.')
})

test('cannot be changed without a token', async ({ page, request }) => {
  await page.goto(`/suites/libcxx/commits/${(await taggedCommit(request)).value}`)

  await expect(page.getByRole('button', { name: 'Edit Ordinal' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Edit Tag' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Delete commit' })).toBeDisabled()
})

/** Commits `c1` to `c3`, ordered, with a run of the machine `m1` each. */
const RUNS: OwnRun[] = [1, 2, 3].map((ordinal) => ({
  machine: 'm1',
  commit: `c${ordinal}`,
  ordinal,
  tests: [{ name: 'bench' }],
}))

test('its ordinal and tag are edited by a holder of manage scope', async ({
  page,
  request,
  tokenFor,
  signIn,
}, testInfo) => {
  await ownSuite(request, tokenFor, testInfo, RUNS, async (suite) => {
    await signIn(page, 'manage')
    await page.goto(`/suites/${suite}/commits/c2`)
    const info = page.getByRole('group', { name: 'Commit', exact: true })

    const tag = page.getByRole('textbox', { name: 'Tag' })
    await page.getByRole('button', { name: 'Edit Tag' }).click()
    await tag.fill(' release-1 ')
    await tag.press('Enter')
    await expect(info).toContainText('release-1')

    // An ordinal another commit holds is refused, and the editor stays open.
    await page.getByRole('button', { name: 'Edit Ordinal' }).click()
    const ordinal = page.getByRole('textbox', { name: 'Ordinal' })
    await ordinal.fill('3')
    await ordinal.press('Enter')
    await expect(page.getByRole('alert')).toContainText('already held by another commit')
    await expect(ordinal).toHaveValue('3')

    // Past the last commit, this one has none after it.
    await ordinal.fill('10')
    await ordinal.press('Enter')
    await expect(page.getByRole('textbox', { name: 'Ordinal' })).toHaveCount(0)
    await expect(link(page, 'Next commit →')).toHaveAttribute('aria-disabled', 'true')
    await expect(link(page, '← Previous commit')).toHaveAttribute(
      'href',
      `/suites/${suite}/commits/c3`,
    )

    const stored = await json<Schemas['CommitDetail']>(request, `/api/suites/${suite}/commits/c2`)
    expect([stored.ordinal, stored.tag]).toEqual([10, 'release-1'])

    // Emptied, the tag is cleared.
    await page.getByRole('button', { name: 'Edit Tag' }).click()
    await tag.fill('')
    await tag.press('Enter')
    await expect(tag).toHaveCount(0)
    await expect(info).not.toContainText('release-1')
    const cleared = await json<Schemas['CommitDetail']>(request, `/api/suites/${suite}/commits/c2`)
    expect(cleared.tag).toBeNull()
  })
})

test('deleting a commit shows the commits left, and keeps its regressions without it', async ({
  page,
  request,
  tokenFor,
  signIn,
}, testInfo) => {
  await ownSuite(request, tokenFor, testInfo, RUNS, async (suite) => {
    const token = await signIn(page, 'manage')
    const created = await request.post(`/api/suites/${suite}/regressions`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { title: 'At c2', commit: 'c2' },
    })
    expect(created.status(), await created.text()).toBe(201)
    const { uuid } = (await created.json()) as Schemas['RegressionDetail']
    await page.goto(`/suites/${suite}/commits/c2`)

    await page.getByRole('button', { name: 'Delete commit' }).click()
    await page.getByLabel(/to confirm/).fill('c2')
    await page.getByRole('button', { name: 'Delete', exact: true }).click()

    await expect(page).toHaveURL(`/suites/${suite}?tab=commits`)
    const commits = table(page, 'Commits')
    await expect(rows(commits)).toHaveCount(2)
    await expect(commits).not.toContainText('c2')
    expect((await request.get(`/api/suites/${suite}/commits/c2`)).status()).toBe(404)
    const regression = await json<Schemas['RegressionDetail']>(
      request,
      `/api/suites/${suite}/regressions/${uuid}`,
    )
    expect([regression.title, regression.commit]).toEqual(['At c2', null])
  })
})
