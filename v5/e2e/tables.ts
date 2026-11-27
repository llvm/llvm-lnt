/**
 * Reading the tables of the web UI (see client/src/components/data-table.tsx), and its info boxes
 * (see client/src/components/info-box.tsx).
 */

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

/** The value of the row labelled `label` in the info box `box`. */
export function infoValue(box: Locator, label: string): Locator {
  return box
    .locator('div')
    .filter({ has: box.page().getByRole('term').getByText(label, { exact: true }) })
    .getByRole('definition')
}

/** Wait until `table` shows the rows asked for, rather than those it showed before. */
export async function settled(table: Locator) {
  await expect(table).toHaveAttribute('aria-busy', 'false')
}
