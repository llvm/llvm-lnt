/**
 * The Machine Detail page (DT1).
 *
 * Reading tests use the seeded libcxx suite. Tests that write use a suite of their own (see
 * own-suite.ts).
 */

import type { components } from '../client/src/api/schema.d.ts'
import { MACOS } from '../tools/synthetic.ts'
import { expect, json, test } from './fixtures.ts'
import { ownSuite } from './own-suite.ts'
import { column, rows, table } from './tables.ts'

type Schemas = components['schemas']

/** A machine `m1` with one run. */
const RUNS = [{ machine: 'm1', commit: 'c1', ordinal: 1, tests: [{ name: 'bench' }] }]

test('the Machines tab links to the page of each machine', async ({ page }) => {
  await page.goto('/suites/libcxx?tab=machines')
  await table(page, 'Machines').getByRole('link', { name: MACOS, exact: true }).click()

  await expect(page).toHaveURL(`/suites/libcxx/machines/${MACOS}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Machine: ${MACOS}`)
  await expect(rows(table(page, 'Run history'))).toHaveCount(25)
})

test('shows the machine and its active regressions, and links to all of them', async ({
  page,
}) => {
  await page.goto(`/suites/libcxx/machines/${MACOS}`)

  await expect(page.getByRole('group', { name: 'Machine', exact: true })).toContainText('Apple M4')
  await expect(page.getByRole('checkbox', { name: 'Tracked' })).toBeChecked()
  // Detected and active ones only: not the fixed filesystem::path one, nor the false positive.
  const regressions = table(page, 'Active regressions')
  await expect(rows(regressions).first()).toBeVisible()
  for (const state of await column(regressions, 1)) expect(['detected', 'active']).toContain(state)
  await expect(regressions).not.toContainText('filesystem::path')

  await page.getByRole('link', { name: 'Show all regressions' }).click()
  await expect(page).toHaveURL(`/suites/libcxx?tab=regressions&machine=${MACOS}`)
  await expect(table(page, 'Regressions')).toContainText('filesystem::path')
})

test('cannot be changed without a token', async ({ page }) => {
  await page.goto(`/suites/libcxx/machines/${MACOS}`)

  await expect(page.getByRole('checkbox', { name: 'Tracked' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Delete Machine' })).toBeDisabled()
})

test('its tracked flag is changed by a holder of manage scope', async ({
  page,
  request,
  tokenFor,
  signIn,
}, testInfo) => {
  await ownSuite(request, tokenFor, testInfo, RUNS, async (suite) => {
    await signIn(page, 'manage')
    await page.goto(`/suites/${suite}/machines/m1`)
    const tracked = page.getByRole('checkbox', { name: 'Tracked' })
    await expect(tracked).toBeEnabled()

    // The box shows the flag the API holds, and so changes once the API has answered.
    await tracked.click()

    await expect(tracked).not.toBeChecked()
    const stored = await json<Schemas['Machine']>(request, `/api/suites/${suite}/machines/m1`)
    expect(stored.tracked).toBe(false)
    await page.reload()
    await expect(tracked).not.toBeChecked()
  })
})

test('deleting the machine shows the machines left', async ({
  page,
  request,
  tokenFor,
  signIn,
}, testInfo) => {
  await ownSuite(request, tokenFor, testInfo, RUNS, async (suite) => {
    await signIn(page, 'manage')
    await page.goto(`/suites/${suite}/machines/m1`)

    await page.getByRole('button', { name: 'Delete Machine' }).click()
    await page.getByLabel(/to confirm/).fill('m1')
    await page.getByRole('button', { name: 'Delete', exact: true }).click()

    await expect(page).toHaveURL(`/suites/${suite}?tab=machines`)
    await expect(page.getByText('No machines yet.')).toBeVisible()
    expect((await request.get(`/api/suites/${suite}/machines/m1`)).status()).toBe(404)
  })
})
