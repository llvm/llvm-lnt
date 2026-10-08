/**
 * Smoke tests of the stack as a whole: routing, serving, and what sits outside the SPA.
 */

import { expect, test } from './fixtures.ts'

/** A real libcxx run (server/tests/data/libcxx/runs/r552558-linux-1.json). */
const RUN = '5f85edeb-a65b-4b2f-ab83-9152007dc703'

test.describe('routing', () => {
  for (const [url, heading] of [
    ['/suites/libcxx', 'Test Suites'],
    [`/suites/libcxx/runs/${RUN}`, 'Run Detail'],
    ['/graph?suite=libcxx', 'Graph'],
  ]) {
    test(`a deep link to ${url} survives a hard refresh`, async ({ page }) => {
      await page.goto(url)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading)

      await page.reload()
      await expect(page).toHaveURL(url)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading)
    })
  }

  test('the navbar navigates without reloading the page', async ({ page }) => {
    await page.goto('/')
    // A full page load would start from a fresh document, without this.
    await page.evaluate(() => (document.documentElement.dataset.loadedOnce = 'yes'))

    const navbar = page.getByRole('navigation')
    for (const [link, url, heading] of [
      ['Test Suites', '/suites', 'Test Suites'],
      ['Graph', '/graph', 'Graph'],
      ['Compare', '/compare', 'Compare'],
      ['Profiles', '/profiles', 'Profiles'],
      ['Admin', '/admin', 'Admin'],
      ['LNT', '/', 'Dashboard'],
    ]) {
      await navbar.getByRole('link', { name: link, exact: true }).click()
      await expect(page).toHaveURL(url)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading)
    }
    expect(await page.evaluate(() => document.documentElement.dataset.loadedOnce)).toBe('yes')
  })

  test('the navbar passes the suite of a suite-scoped page on (AR4)', async ({ page }) => {
    await page.goto('/suites/libcxx')
    await page.getByRole('navigation').getByRole('link', { name: 'Graph', exact: true }).click()
    await expect(page).toHaveURL('/graph?suite=libcxx')
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
  for (const url of ['/api/nope', '/api/suites/libcxx/nope']) {
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
