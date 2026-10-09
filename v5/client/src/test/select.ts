/** Driving the `Select` component (components/select.tsx) in tests. */

import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

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
