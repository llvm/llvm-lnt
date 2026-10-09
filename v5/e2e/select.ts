/** Driving the `Select` component of the web UI (see client/src/components/select.tsx). */

import type { Locator, Page } from '@playwright/test'

/** The button of the select labelled `label`, which React Aria names `<value> <label>`. */
function selectButton(scope: Page | Locator, label: string): Locator {
  return scope.getByRole('button', { name: new RegExp(` ${label}$`) })
}

/** Pick the option named `option` in the select labelled `label`. */
export async function pickOption(scope: Page | Locator, label: string, option: string) {
  await selectButton(scope, label).click()
  // The list is in a popover at the end of the document, outside `scope`.
  const page = 'page' in scope ? scope.page() : scope
  await page.getByRole('option', { name: option, exact: true }).click()
}
