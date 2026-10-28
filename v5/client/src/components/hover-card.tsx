import type { ReactNode } from 'react'
import { useHover } from 'react-aria/useHover'
import { Popover } from './popover'
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
 * the popover's child, since a non-modal popover drops the id and the role it is given.
 */
export function HoverCard(props: Props) {
  return props.card.isOpen ? <OpenHoverCard {...props} /> : null
}

function OpenHoverCard({ card, labelledBy, popoverClassName, className, children }: Props) {
  const { hoverProps } = useHover(card.cardHover)
  return (
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
        className={className}
        {...hoverProps}
      >
        {children}
      </div>
    </Popover>
  )
}
