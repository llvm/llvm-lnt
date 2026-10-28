import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useHover } from 'react-aria/useHover'

// How long the pointer rests on a link before its card opens, and how long the card stays open once
// the pointer has left both: long enough to cross from the link to the card. Since a card closes
// before another can open, there is never more than one card open at a time.
export const OPEN_DELAY_MS = 500
export const CLOSE_DELAY_MS = 300

/**
 * The hover mechanics of a card about a link (AR21): it opens once the pointer has rested on the
 * link for `OPEN_DELAY_MS`, stays open while the pointer is on the link or the card, and closes
 * `CLOSE_DELAY_MS` after the pointer has left both, or on Escape, wherever the focus is. Neither
 * keyboard focus nor touch opens it: `useHover` ignores touch, and the mouse events a browser
 * emulates after one.
 *
 * `triggerProps` go on the link, and the result as a whole to the card's `HoverCard`.
 */
export function useHoverCard<Trigger extends HTMLElement>() {
  const triggerRef = useRef<Trigger>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const [isOpen, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const onTrigger = useRef(false)
  // Closed by Escape with the pointer on the link: not to open again until it has left the link.
  const dismissed = useRef(false)

  const cancel = useCallback(() => clearTimeout(timer.current), [])
  const schedule = (action: () => void, delay: number) => {
    cancel()
    timer.current = setTimeout(action, delay)
  }

  // Every way of closing the card goes through here. The card never takes the focus, but it gets
  // it when clicked: it gives it back to the link, which its popover would otherwise give to
  // whatever had it when the card opened.
  const close = useCallback(() => {
    cancel()
    if (cardRef.current?.contains(document.activeElement)) {
      triggerRef.current?.focus({ preventScroll: true })
    }
    setOpen(false)
  }, [cancel])

  useEffect(() => cancel, [cancel])

  useEffect(() => {
    if (!isOpen) return
    // In the bubble phase, and without consuming the key: whatever else Escape is for still gets it.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      dismissed.current = onTrigger.current
      close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isOpen, close])

  const { hoverProps } = useHover({
    onHoverStart: () => {
      onTrigger.current = true
      if (dismissed.current) return
      if (isOpen) cancel()
      else schedule(() => setOpen(true), OPEN_DELAY_MS)
    },
    onHoverEnd: () => {
      onTrigger.current = false
      dismissed.current = false
      if (isOpen) schedule(close, CLOSE_DELAY_MS)
      else cancel()
    },
  })

  return {
    isOpen,
    id,
    /** For the card's popover, which closes through `close`. */
    popoverProps: { triggerRef, onOpenChange: (open: boolean) => !open && close() },
    /** For the card's own root element. */
    cardProps: { ref: cardRef, id },
    /** What the card does as the pointer enters and leaves it. */
    cardHover: { onHoverStart: cancel, onHoverEnd: () => schedule(close, CLOSE_DELAY_MS) },
    triggerProps: {
      ref: triggerRef,
      ...hoverProps,
      // Following the link is not waiting for its card.
      onPointerDown: () => {
        if (!isOpen) cancel()
      },
      // Its details (structured, with links), rather than a description, read as plain text.
      'aria-details': isOpen ? id : undefined,
    },
  }
}

export type HoverCardState = ReturnType<typeof useHoverCard>
