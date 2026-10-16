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
const RUNS = [{ machine: 'm1', commit: 'c1', ordinal: 1, tests: [{ name: 'bench', samples: [{}] }] }]

test('the Machines tab links to the page of each machine, whose trail leads back', async ({
  page,
}) => {
  await page.goto('/suites/libcxx?tab=machines')
  await table(page, 'Machines').getByRole('link', { name: MACOS, exact: true }).click()

  await expect(page).toHaveURL(`/suites/libcxx/machines/${MACOS}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Machine: ${MACOS}`)
  await expect(rows(table(page, 'Run history'))).toHaveCount(25)

  const trail = page.getByRole('navigation', { name: 'Breadcrumb' })
  await trail.getByRole('link', { name: 'Machines', exact: true }).click()
  await expect(page).toHaveURL('/suites/libcxx?tab=machines')
  await expect(page.getByRole('tab', { name: 'Machines' })).toHaveAttribute('aria-selected', 'true')
})

test('shows the machine and its active regressions, and links to all of them', async ({
  page,
}) => {
  await page.goto(`/suites/libcxx/machines/${MACOS}`)

  await expect(page.getByRole('group', { name: 'Machine', exact: true })).toContainText('Apple M4')
  await expect(page.getByRole('checkbox', { name: 'Tracked' })).toBeChecked()
  // Detected and active ones only: not the fixed filesystem::path one, nor the false positive.
  const regressions = table(page, 'Active regressions')
  await expect(regressions).toContainText('std::format slowdown')
  for (const state of await column(regressions, 2)) expect(['detected', 'active']).toContain(state)
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

test('its deletion after inactivity is edited by a holder of manage scope', async ({
  page,
  request,
  tokenFor,
  signIn,
}, testInfo) => {
  await ownSuite(request, tokenFor, testInfo, RUNS, async (suite) => {
    await signIn(page, 'manage')
    await page.goto(`/suites/${suite}/machines/m1`)
    const info = page.getByRole('group', { name: 'Machine', exact: true })
    const days = page.getByRole('textbox', { name: 'Delete after inactivity' })

    await page.getByRole('button', { name: 'Edit Delete after inactivity' }).click()
    await days.fill('30')
    await days.press('Enter')
    await expect(days).toHaveCount(0)
    await expect(info).toContainText('30 days')
    const stored = await json<Schemas['Machine']>(request, `/api/suites/${suite}/machines/m1`)
    expect(stored.delete_after_inactive_days).toBe(30)

    // Emptied, it is cleared.
    await page.getByRole('button', { name: 'Edit Delete after inactivity' }).click()
    await days.fill('')
    await days.press('Enter')
    await expect(days).toHaveCount(0)
    await expect(info).not.toContainText('30 days')
    const cleared = await json<Schemas['Machine']>(request, `/api/suites/${suite}/machines/m1`)
    expect(cleared.delete_after_inactive_days).toBeNull()
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

test('a machine deleted is not shown again when the history leads back to its page', async ({
  page,
  request,
  tokenFor,
  signIn,
}, testInfo) => {
  await ownSuite(request, tokenFor, testInfo, RUNS, async (suite) => {
    await signIn(page, 'manage')
    // The machine's page, its run's, then the machine's again. The Test Suites page is not visited,
    // so that its code is still to be loaded when the deletion leaves for it.
    await page.goto(`/suites/${suite}/machines/m1`)
    await table(page, 'Run history').getByRole('link').first().click()
    await page.getByRole('group', { name: 'Run' }).getByRole('link', { name: 'm1' }).click()
    await page.getByRole('button', { name: 'Delete Machine' }).click()
    await page.getByLabel(/to confirm/).fill('m1')
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.getByText('No machines yet.')).toBeVisible()

    // The machine is asked for again, but not answered until the page has been looked at.
    let answer = () => {}
    const answered = new Promise<void>((resolve) => (answer = resolve))
    let asked = () => {}
    const requested = new Promise<void>((resolve) => (asked = resolve))
    await page.route(`**/api/suites/${suite}/machines/m1`, async (route) => {
      asked()
      await answered
      await route.continue()
    })
    await page.goBack()
    await page.goBack()
    await expect(page).toHaveURL(`/suites/${suite}/machines/m1`)
    await requested

    await expect(page.getByRole('status')).toHaveText('Loading...')
    await expect(page.getByRole('group', { name: 'Machine' })).toHaveCount(0)
    answer()
    await expect(page.getByRole('alert')).toContainText("No machine named 'm1'")
  })
})
