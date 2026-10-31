import type { MouseEvent } from 'react'

/**
 * Whether `event` is a plain click: with the primary button and no modifier. Any other click is left
 * to the browser (AR2 "Routing"), as a link leaves it, to open in a new tab, say.
 */
export function isPlainClick(event: MouseEvent): boolean {
  return (
    event.button === 0 && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
  )
}
