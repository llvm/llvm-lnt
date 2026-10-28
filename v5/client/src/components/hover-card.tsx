import type { ReactNode } from 'react'
import { PopoverContext } from 'react-aria-components'
import { useHover } from 'react-aria/useHover'
import clsx from 'clsx'
import { useNestedOverlay } from './nested-overlays'
import { Popover } from './popover'
import styles from './hover-card.module.css'
import type { HoverCardState } from './use-hover-card'

interface Props {
  card: HoverCardState
  /** The id of what names the card. */
  labelledBy: string
  /** The class of the popover, which React Aria places, and limits the height of. */
  popoverClassName?: string
  className?: string
  children: ReactNode
}

/**
 * The card `card` opens, beside its link, while it is open: a non-modal popover, which neither
 * takes nor traps the focus, holding a group that the link refers to as its details. The group is
 * the popover's child, since a non-modal popover drops the id and the role it is given. Opened
 * inside a box floating over the page, it is part of that box (see `NestedOverlays`).
 */
export function HoverCard(props: Props) {
  return props.card.isOpen ? <OpenHoverCard {...props} /> : null
}

function OpenHoverCard({ card, labelledBy, popoverClassName, className, children }: Props) {
  const { hoverProps } = useHover(card.cardHover)
  useNestedOverlay(card.popoverProps.ref)
  return (
    // Not the popover of a React Aria component holding the link, such as a combobox's list, which
    // would otherwise pass it its own settings.
    <PopoverContext.Provider value={null}>
      <Popover
        {...card.popoverProps}
        isOpen
        isNonModal
        // Escape is the card's own (see `useHoverCard`), which does not consume it.
        isKeyboardDismissDisabled
        placement="bottom start"
        offset={4}
        className={popoverClassName}
      >
        <div
          id={card.id}
          role="group"
          aria-labelledby={labelledBy}
          // A click on its text gives it the focus, rather than drop the focus to the page, so that
          // the focus can return to the link when it closes.
          tabIndex={-1}
          className={clsx(styles.card, className)}
          {...hoverProps}
        >
          {children}
        </div>
      </Popover>
    </PopoverContext.Provider>
  )
}
