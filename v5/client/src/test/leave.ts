import { onTestFinished, vi } from 'vitest'

/**
 * Answer `answer` to the question asked before the user leaves a form with unsaved changes (AR19),
 * which jsdom cannot ask, until the test finishes. Returns the mock, to see whether it was asked,
 * or answer otherwise.
 */
export function answerLeaving(answer: boolean) {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(answer)
  onTestFinished(() => confirm.mockRestore())
  return confirm
}

/** Whether reloading or closing the browser tab now would have the browser ask first. */
export function unloadAsks(): boolean {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}
