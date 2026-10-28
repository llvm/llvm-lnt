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
 * `CLOSE_DELAY_MS` after the pointer has left both, on Escape, wherever the focus is, or when the
 * link moves. Neither keyboard focus nor touch opens it: `useHover` ignores touch, and the mouse
 * events a browser emulates after one.
 *
 * `triggerProps` go on the link, and the result as a whole to the card's `HoverCard`.
 */
export function useHoverCard<Trigger extends HTMLElement>() {
  const triggerRef = useRef<Trigger>(null)
  const popoverRef = useRef<HTMLElement>(null)
  const id = useId()
  const [isOpen, setOpen] = useState(false)
  // About to open: the pointer rests on the link.
  const [isPending, setPending] = useState(false)
  // `isOpen`, for the hover handlers, which a pointer event can call from an earlier render.
  const open = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const cancel = useCallback(() => {
    clearTimeout(timer.current)
    setPending(false)
  }, [])
  const schedule = (action: () => void, delay: number) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(action, delay)
  }
  const show = () => {
    open.current = true
    setPending(false)
    setOpen(true)
  }

  // Every way of closing the card goes through here. The card never takes the focus, but it gets
  // it when clicked: it gives it back to the link, which its popover would otherwise give to
  // whatever had it when the card opened.
  const close = useCallback(() => {
    cancel()
    if (popoverRef.current?.contains(document.activeElement)) {
      triggerRef.current?.focus({ preventScroll: true })
    }
    open.current = false
    setOpen(false)
  }, [cancel])

  useEffect(() => () => clearTimeout(timer.current), [])

  // It closes when its link moves, rather than be left behind, as when a box holding the link moves
  // (GR11): checked every frame, since what moves the link need not render it again. Its popover
  // also closes on a scroll of its own accord.
  useEffect(() => {
    const trigger = triggerRef.current
    if (!isOpen || trigger === null) return
    const start = trigger.getBoundingClientRect()
    const check = () => {
      const now = trigger.getBoundingClientRect()
      if (Math.abs(now.left - start.left) > 1 || Math.abs(now.top - start.top) > 1) close()
      else frame = requestAnimationFrame(check)
    }
    let frame = requestAnimationFrame(check)
    return () => cancelAnimationFrame(frame)
  }, [isOpen, close])

  useEffect(() => {
    if (!isOpen && !isPending) return
    // In the bubble phase, and without consuming the key: whatever else Escape is for still gets it.
    // The popover leaves Escape alone (`isKeyboardDismissDisabled`), even with the focus inside.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isOpen, isPending, close])

  // Once closed by Escape, with the pointer on the link, the card opens again only once the pointer
  // has left the link and come back: `useHover` reports nothing until it has left.
  const { hoverProps } = useHover({
    onHoverStart: () => {
      if (open.current) {
        clearTimeout(timer.current)
      } else {
        setPending(true)
        schedule(show, OPEN_DELAY_MS)
      }
    },
    onHoverEnd: () => {
      if (open.current) schedule(close, CLOSE_DELAY_MS)
      else cancel()
    },
  })

  return {
    isOpen,
    id,
    /** For the card's popover, which closes through `close`. */
    popoverProps: {
      ref: popoverRef,
      triggerRef,
      onOpenChange: (isOpen: boolean) => !isOpen && close(),
    },
    /** What the card does as the pointer enters and leaves it. */
    cardHover: {
      onHoverStart: () => clearTimeout(timer.current),
      onHoverEnd: () => schedule(close, CLOSE_DELAY_MS),
    },
    triggerProps: {
      ref: triggerRef,
      ...hoverProps,
      // Following the link is not waiting for its card.
      onPointerDown: () => {
        if (!open.current) cancel()
      },
      // Its details (structured, with links), rather than a description, read as plain text.
      'aria-details': isOpen ? id : undefined,
    },
  }
}

export type HoverCardState = ReturnType<typeof useHoverCard>
