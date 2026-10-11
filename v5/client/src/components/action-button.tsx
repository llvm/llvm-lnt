import { useId, type ButtonHTMLAttributes, type Ref } from 'react'
import { VisuallyHidden } from 'react-aria-components'

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled' | 'title'> {
  /**
   * Why the button cannot be used yet, if it cannot: it is disabled, saying why on hover and to
   * assistive technology (as AR2 has disabled controls do).
   */
  reason?: string
  /**
   * What the button does is under way: it ignores clicks, but is not disabled, which would lose
   * the focus (as InlineEdit's buttons do while saving).
   */
  busy?: boolean
  ref?: Ref<HTMLButtonElement>
}

/** A button that says why it is disabled, and that keeps the focus while its action runs. */
export function ActionButton({ reason, busy = false, onClick, ...props }: Props) {
  const reasonId = useId()
  return (
    <>
      <button
        type="button"
        {...props}
        disabled={reason !== undefined}
        aria-disabled={busy || undefined}
        title={reason}
        aria-describedby={reason === undefined ? undefined : reasonId}
        onClick={(event) => {
          // A submit button submits nothing either.
          if (busy) event.preventDefault()
          else onClick?.(event)
        }}
      />
      {reason !== undefined && <VisuallyHidden id={reasonId}>{reason}</VisuallyHidden>}
    </>
  )
}
