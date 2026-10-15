/** Helpers that drive the `Select` and `Combobox` components (see components/) in tests. */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect } from 'vitest'

/**
 * The button of the `Select` labelled `label`, inside `container`. It shows the select's value, and
 * React Aria names it by both, as `<value> <label>`.
 */
export function selectButton(label: string, container: HTMLElement = document.body) {
  return within(container).getByRole('button', { name: new RegExp(` ${label}$`) })
}

/** Pick the option named `option` in the `Select` labelled `label`, as a mouse user does. */
export async function pickOption(label: string, option: string, container?: HTMLElement) {
  const user = userEvent.setup()
  await user.click(selectButton(label, container))
  await user.click(await screen.findByRole('option', { name: option }))
}

/**
 * Pick `name` in the combobox labelled `label`, typing it over the text the input holds, which is
 * never emptied meanwhile: that would clear the combobox's value (AR14). The suggestion is found by
 * `option`, its accessible name: `name` unless it shows more, such as a badge.
 */
export async function pick(
  label: string,
  name: string,
  container: HTMLElement = document.body,
  option: string | RegExp = name,
) {
  const user = userEvent.setup()
  const input = await within(container).findByRole('combobox', { name: label })
  await waitFor(() => expect(input).toBeEnabled())
  await user.tripleClick(input)
  await user.keyboard(name)
  await user.click(await screen.findByRole('option', { name: option }))
}
