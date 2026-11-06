/** Helpers that drive the reorderable lists (see components/drag-reorder.tsx) in tests. */

import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { expect } from 'vitest'

/** Press `key`, with Shift if `shiftKey`, where the focus is. */
export function press(key: string, shiftKey = false) {
  const target = document.activeElement ?? document.body
  fireEvent.keyDown(target, { key, shiftKey })
  fireEvent.keyUp(target, { key, shiftKey })
}

/**
 * Drag the item whose grip is named `grip` from the keyboard, as AR24 has it done: Enter on the
 * grip, which picks the item up at its own place, then Tab (or Shift+Tab, if `backwards`) until the
 * place named `place` has the focus, as in `Before metric score`, then Enter; or Escape at once if
 * `place` is null. Returns the places that had the focus, in order: `Drag …` for the grip itself,
 * which the keyboard goes through once past the last place.
 */
export async function dragByKeyboard(grip: string, place: string | null, backwards = false) {
  act(() => screen.getByRole('button', { name: grip }).focus())
  act(() => press('Enter'))
  const focused = () => document.activeElement?.getAttribute('aria-label') ?? null
  // The item's own place takes the focus once the drop targets have rendered.
  const own = `Leave ${grip.replace(/^Drag /, '')} where it is`
  await waitFor(() => expect(focused()).toBe(own))
  const visited = [focused()]
  if (place === null) {
    act(() => press('Escape'))
    return visited
  }
  while (focused() !== place) {
    if (visited.length > 50) throw new Error(`No place named '${place}'.`)
    act(() => press('Tab', backwards))
    visited.push(focused())
  }
  act(() => press('Enter'))
  return visited
}
