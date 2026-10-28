/** The cards of commit links (AR21). */

import type { Locator, Page } from '@playwright/test'
import { expect } from './fixtures.ts'

/** The card of `link`, which refers to it as its details while it is open. */
export async function cardOf(page: Page, link: Locator): Promise<Locator> {
  await expect(link).toHaveAttribute('aria-details', /.+/)
  return page.locator(`[id="${await link.getAttribute('aria-details')}"]`)
}
