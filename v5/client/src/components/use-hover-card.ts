import { useCallback, useEffect, useId, useRef, useState, type FocusEvent } from 'react'
import { useHover } from 'react-aria/useHover'
import { useInteractOutside } from 'react-aria/useInteractOutside'

// How long the pointer rests on a trigger before its card opens, and how long the card stays open
// once the pointer has left both: long enough to cross from the trigger to the card. Since a card
// closes before another can open, hovering never opens more than one card at a time, though a card
// that a ⓘ keeps open stays open beside the one hovering opens.
export const OPEN_DELAY_MS = 500
export const CLOSE_DELAY_MS = 300

const TABBABLE = 'a[href], button:not(:disabled), input:not(:disabled), [tabindex]'

/** What Tab can focus in `root`, in document order. */
function tabbables(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (element) => element.tabIndex >= 0,
  )
}

/**
 * The mechanics of a card about a trigger (AR21), a link or a ⓘ: it opens once the pointer has
 * rested on the trigger for `OPEN_DELAY_MS`, stays open while the pointer is on the trigger or the
 * card, and closes `CLOSE_DELAY_MS` after the pointer has left both, on Escape, wherever the focus
 * is, or when the trigger moves. Neither keyboard focus nor touch opens it: `useHover` ignores
 * touch, and the mouse events a browser emulates after one.
 *
 * A ⓘ also toggles its card when activated, kept open whatever the pointer does, and followed by it
 * in the order of Tab, until it closes as AR21 says.
 *
 * `triggerProps` go on the trigger, `toggleProps` too on a ⓘ, which is a button, and the result as
 * a whole to the card's `HoverCard`.
 */
export function useHoverCard<Trigger extends HTMLElement>() {
  const triggerRef = useRef<Trigger>(null)
  const popoverRef = useRef<HTMLElement>(null)
  const id = useId()
  const [isOpen, setOpen] = useState(false)
  // About to open: the pointer rests on the trigger.
  const [isPending, setPending] = useState(false)
  // `isOpen`, for the handlers, which an event can call from an earlier render.
  const open = useRef(false)
  // Kept open by its ⓘ.
  const kept = useRef(false)
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
  const keep = () => {
    cancel()
    show()
    kept.current = true
    // Not every browser focuses a button when it is clicked: focused, Tab leads into the card.
    triggerRef.current?.focus({ preventScroll: true })
  }

  // Every way of closing the card goes through here. The card never takes the focus, but it gets
  // it when clicked: it gives it back to the trigger, which its popover would otherwise give to
  // whatever had it when the card opened.
  const close = useCallback(() => {
    cancel()
    if (popoverRef.current?.contains(document.activeElement)) {
      triggerRef.current?.focus({ preventScroll: true })
    }
    open.current = false
    kept.current = false
    setOpen(false)
  }, [cancel])

  // The ⓘ and the card, which are one for what closes a kept card.
  const isInside = (element: Element) =>
    !!triggerRef.current?.contains(element) || !!popoverRef.current?.contains(element)

  useEffect(() => () => clearTimeout(timer.current), [])

  // It closes when its trigger moves, rather than be left behind, as when a box holding the trigger
  // moves (GR11): checked every frame, since what moves the trigger need not render it again. Its
  // popover also closes on a scroll of its own accord.
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

  // A press on the ⓘ is its own: it toggles the card. A press elsewhere is reported once over, when
  // it has already moved the focus where it goes, so that closing the card does not take it back.
  useInteractOutside({
    ref: popoverRef,
    isDisabled: !isOpen,
    onInteractOutside: (event) => {
      if (kept.current && !isInside(event.target as Element)) close()
    },
  })

  // A kept card comes right after its ⓘ in the order of Tab: Tab from the ⓘ leads into it, and out
  // of it, back to the ⓘ or on from it, rather than from whatever had the focus when the card
  // opened, as its popover would have it. In the capture phase of the window, so as to come before
  // the popover's own handling, at the document.
  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return
      const card = popoverRef.current
      const trigger = triggerRef.current
      const focused = document.activeElement
      if (!kept.current || !card || !trigger || !focused) return
      if (focused === trigger) {
        const first = tabbables(card).at(0)
        if (event.shiftKey || first === undefined) return
        event.preventDefault()
        first.focus()
        return
      }
      if (!card.contains(focused)) return
      // Out of the card only from its last element, or from its first one with Shift.
      const ahead = event.shiftKey
        ? Node.DOCUMENT_POSITION_PRECEDING
        : Node.DOCUMENT_POSITION_FOLLOWING
      if (tabbables(card).some((element) => focused.compareDocumentPosition(element) & ahead)) {
        return
      }
      event.stopPropagation()
      trigger.focus({ preventScroll: true })
      // Back to the ⓘ, or on to what follows it, where the browser moves the focus on from the ⓘ.
      if (event.shiftKey) event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [isOpen])

  // Once closed by Escape or its ⓘ, with the pointer on the trigger, the card opens again only once
  // the pointer has left the trigger and come back: `useHover` reports nothing until it has left.
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
      if (kept.current) return
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
      // The focus moving from the card to its trigger does not close it.
      shouldCloseOnInteractOutside: (element: Element) => !isInside(element),
    },
    /** What the card does as the pointer enters and leaves it. */
    cardHover: {
      onHoverStart: () => clearTimeout(timer.current),
      onHoverEnd: () => {
        if (!kept.current) schedule(close, CLOSE_DELAY_MS)
      },
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
    /** What a ⓘ does besides: toggle its card, kept open. */
    toggleProps: {
      onClick: () => (kept.current ? close() : keep()),
      'aria-expanded': isOpen,
      'aria-controls': isOpen ? id : undefined,
      // The focus moving to another element outside the card, rather than out of the window.
      onBlur: (event: FocusEvent) => {
        const to = event.relatedTarget
        if (kept.current && to !== null && !isInside(to)) close()
      },
    },
  }
}

export type HoverCardState = ReturnType<typeof useHoverCard>
