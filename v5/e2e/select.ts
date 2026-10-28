/** Helpers that drive the `Select` and `Combobox` components (see client/src/components/). */

import { expect, type Locator, type Page } from '@playwright/test'

/** The button of the select labelled `label`, which React Aria names `<value> <label>`. */
export function selectButton(scope: Page | Locator, label: string): Locator {
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

/**
 * Type `text` into the combobox `input`, which opens its list: tests type into comboboxes with this.
 *
 * A combobox's list closes when the page scrolls (AR14), and focusing an input out of view scrolls
 * the page to it. `fill` focuses and types at once, before the browser reports that scroll in its
 * next rendering update, which would close the list just opened. So the input is focused first, and
 * typed into once that update is over. This relies on the page scrolling at once rather than
 * smoothly, and on scroll events being dispatched before the update's animation frame callbacks.
 */
export async function typeInto(input: Locator, text: string) {
  await expect(input).toBeEnabled()
  await input.focus()
  await input.page().evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
  await input.fill(text)
}

/**
 * Click `suggestion` in a combobox's open list, without scrolling, which would close the list
 * (AR14): Playwright otherwise scrolls an element into view before clicking it, and does so even
 * when it is in view once a first attempt found it still moving, as the list does while it opens.
 * The list shows beside its input, which is in view once typed into.
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
