/**
 * Smoke tests of the stack as a whole: routing, serving, and what sits outside the SPA.
 */

import { expect, REAL_RUN, test } from './fixtures.ts'

/**
 * Where `/projects` goes on to (TS1): the first project's first suite, or the project's own page
 * when it has none, as a project of another test may have.
 */
const A_PROJECT = /^[^?]*\/projects\/[^/?]+(\/suites\/[^/?]+)?$/

test.describe('routing', () => {
  for (const [url, heading] of [
    // A project without suites, whose page does not go on to a suite's (TS1).
    ['/projects/swift', 'Projects'],
    ['/projects/libcxx/suites/benchmarks', 'Projects'],
    [`/projects/libcxx/suites/benchmarks/runs/${REAL_RUN}`, `Run: ${REAL_RUN}`],
    ['/graph?project=libcxx&suite=benchmarks', 'Graph'],
  ]) {
    test(`a deep link to ${url} survives a hard refresh`, async ({ page }) => {
      await page.goto(url)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading)

      await page.reload()
      await expect(page).toHaveURL(url)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading)
    })
  }

  test('a deep link to /projects goes on to the first project', async ({ page }) => {
    await page.goto('/projects')
    await expect(page).toHaveURL(A_PROJECT)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Projects')
  })

  test('the navbar navigates without reloading the page', async ({ page }) => {
    await page.goto('/')
    // A full page load would start from a fresh document, without this.
    await page.evaluate(() => (document.documentElement.dataset.loadedOnce = 'yes'))

    const navbar = page.getByRole('navigation').first()
    // Projects after the suite-agnostic pages, whose links it would pre-fill with the suite it
    // lands on (AR4).
    for (const [link, url, heading] of [
      ['Graph', '/graph', 'Graph'],
      ['Compare', '/compare', 'Compare'],
      ['Profiles', '/profiles', 'Profiles'],
      ['Admin', '/admin', 'Admin'],
      ['Projects', A_PROJECT, 'Projects'],
      ['LNT', '/', 'Dashboard'],
    ]) {
      await navbar.getByRole('link', { name: link, exact: true }).click()
      await expect(page).toHaveURL(url)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading)
    }
    expect(await page.evaluate(() => document.documentElement.dataset.loadedOnce)).toBe('yes')
  })

  test('the navbar passes the suite of a suite-scoped page on (AR4)', async ({ page }) => {
    await page.goto('/projects/libcxx/suites/benchmarks')
    await page.getByRole('navigation').getByRole('link', { name: 'Graph', exact: true }).click()
    await expect(page).toHaveURL('/graph?project=libcxx&suite=benchmarks')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Graph')
  })

  test('the API link opens the API documentation in a new tab', async ({ page, context }) => {
    await page.goto('/')
    const opened = context.waitForEvent('page')
    await page.getByRole('navigation').getByRole('link', { name: 'API', exact: true }).click()
    const docs = await opened

    await expect(docs).toHaveURL('/api/docs')
    await expect(docs).toHaveTitle(/LNT v5/)
    await expect(page).toHaveURL('/')
  })
})

test('an unknown API path is a JSON 404 rather than the client', async ({ request }) => {
  for (const url of ['/api/nope', '/api/projects/libcxx/suites/benchmarks/nope']) {
    const response = await request.get(url)
    expect(response.status()).toBe(404)
    expect(response.headers()['content-type']).toContain('application/json')
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } })
  }
})

test('tokenFor gives a token of the scope asked for', async ({ request, tokenFor }) => {
  const token = await tokenFor('triage')

  const response = await request.get('/api/auth', { headers: { Authorization: `Bearer ${token}` } })
  expect(await response.json()).toMatchObject({ key: { scope: 'triage' } })
})
