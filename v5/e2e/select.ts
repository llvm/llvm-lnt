/** Helpers that drive the `Select` and `Combobox` components (see client/src/components/). */

import { expect, type Locator, type Page } from '@playwright/test'

/** The button of the select labelled `label`, which React Aria names `<value> <label>`. */
export function selectButton(scope: Page | Locator, label: string): Locator {
  return scope.getByRole('button', { name: new RegExp(` ${label}$`) })
}

/** Pick the option named `option` in the select labelled `label`, once it shows (see `openSelect`). */
export async function pickOption(scope: Page | Locator, label: string, option: string) {
  // The list is in a popover at the end of the document, outside `scope`.
  const page = 'page' in scope ? scope.page() : scope
  const listed = page.getByRole('option', { name: option, exact: true })
  await openSelect(scope, label, listed)
  await listed.click()
}

/**
 * Open the select labelled `label` until its list shows `shown`. A select does not open while it
 * has no options, which may still be loading, so it is opened again until `shown` shows.
 */
export async function openSelect(scope: Page | Locator, label: string, shown: Locator) {
  await expect(async () => {
    if (!(await shown.isVisible())) await selectButton(scope, label).click()
    await expect(shown).toBeVisible({ timeout: 1000 })
  }).toPass()
}

/** The group of options under the heading `heading` in an open select (AR22). */
export function optionGroup(page: Page, heading: string): Locator {
  return page.getByRole('group', { name: heading, exact: true })
}

/**
 * Pick the suite labelled `suite` under the heading `project` in the suite select labelled `label`
 * (AR22).
 */
export async function pickSuite(
  scope: Page | Locator,
  label: string,
  project: string,
  suite: string,
) {
  const page = 'page' in scope ? scope.page() : scope
  const listed = optionGroup(page, project).getByRole('option', { name: suite, exact: true })
  await openSelect(scope, label, listed)
  await listed.click()
}

/**
 * Type `text` into the combobox `input`, opening its list, as tests do for every combobox.
 *
 * A combobox's list closes when the page scrolls (AR14), and focusing an input out of view scrolls
 * the page to it. `fill` focuses and types at once, before the browser reports that scroll in its
 * next rendering update, which would close the list just opened. So the input is focused first, and
 * typed into once that update is over: the event loop dispatches its scroll events before its
 * animation frame callbacks. This relies on the page scrolling at once rather than smoothly.
 */
export async function typeInto(input: Locator, text: string) {
  await expect(input).toBeEnabled()
  await input.focus()
  await input.page().evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
  await input.fill(text)
}

/**
 * Click `suggestion` in a combobox's open list, without scrolling, which would close the list
 * (AR14). Playwright otherwise scrolls an element into view before clicking it, and on each retry
 * after a failed check, such as the list still moving as it opens, even an element already in
 * view. The list shows beside its input, which is in view once focused. Only for a suggestion the
 * list shows without being scrolled: one further down a long list is not scrolled to, and the
 * click times out.
 */
export async function clickSuggestion(suggestion: Locator) {
  await suggestion.click({ scroll: 'none' })
}

/**
 * Pick the suggestion named `option` in the combobox labelled `label`, after typing `text` to find
 * it. By default, `option` is `text`.
 */
export async function pickSuggestion(
  scope: Page | Locator,
  label: string,
  text: string,
  option = text,
) {
  const page = 'page' in scope ? scope.page() : scope
  await typeInto(scope.getByRole('combobox', { name: label }), text)
  await clickSuggestion(page.getByRole('option', { name: option, exact: true }))
}
