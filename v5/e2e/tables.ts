/** Reading the tables of the web UI (see client/src/components/data-table.tsx). */

import type { Locator, Page } from '@playwright/test'
import { expect } from './fixtures.ts'

export function table(page: Page, name: string): Locator {
  return page.getByRole('table', { name })
}

/** The body rows of `table`. */
export function rows(table: Locator): Locator {
  return table.locator('tbody tr')
}

/** The text of each cell of the column `index` of `table`. */
export async function column(table: Locator, index: number): Promise<string[]> {
  return rows(table).locator(`td:nth-child(${index + 1})`).allTextContents()
}

/** Wait until `table` shows the rows asked for, rather than those it showed before. */
export async function settled(table: Locator) {
  await expect(table).toHaveAttribute('aria-busy', 'false')
}
