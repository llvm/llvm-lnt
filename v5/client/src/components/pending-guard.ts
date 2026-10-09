import type { MouseEvent } from 'react'

/**
 * The props of a form's submit button while a combobox of the form holds text that was not picked,
 * which the form must not be submitted with (AR2 "Commit pickers"): see `onPendingChange` on
 * `Combobox`. The form's submit handler refuses meanwhile too.
 *
 * The button is disabled through `aria-disabled` rather than `disabled`, and a click on it keeps
 * the focus in the combobox. Otherwise the click would leave the combobox first, which puts back
 * the text of its value, and so enable the button under the click, which would then submit.
 */
export function pendingGuard(pending: boolean) {
  if (!pending) return {}
  return {
    'aria-disabled': true,
    onMouseDown: (event: MouseEvent) => event.preventDefault(),
  } as const
}
