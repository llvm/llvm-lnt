/** Driving the `Select` component of the web UI (see client/src/components/select.tsx). */

import { expect, type Locator, type Page } from '@playwright/test'

/** The button of the select labelled `label`, which React Aria names `<value> <label>`. */
function selectButton(scope: Page | Locator, label: string): Locator {
  return scope.getByRole('button', { name: new RegExp(` ${label}$`) })
}

/**
 * Pick the option named `option` in the select labelled `label`. A select does not open while it
 * has no options, which may still be loading, so it is opened again until the option shows.
 */
export async function pickOption(scope: Page | Locator, label: string, option: string) {
  // The list is in a popover at the end of the document, outside `scope`.
  const page = 'page' in scope ? scope.page() : scope
  const listed = page.getByRole('option', { name: option, exact: true })
  await expect(async () => {
    if (!(await listed.isVisible())) await selectButton(scope, label).click()
    await expect(listed).toBeVisible({ timeout: 1000 })
  }).toPass()
  await listed.click()
}
