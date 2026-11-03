import { useEffect, type RefObject } from 'react'
import { useAuth } from '../auth/use-auth'

/** Whether the focus is nowhere: it went down with what had it, which has gone. */
export function focusLost(): boolean {
  return document.activeElement === null || document.activeElement === document.body
}

/**
 * While `pending`, give `target` the focus once the token, checked again after a rename or a move
 * (AR17), has settled: the check disables the gated controls meanwhile, `target` among them, so that
 * it could not take the focus before. Then call `onDone`. Only if the focus is nowhere, so that
 * wherever the user has put it since stays where it is. If the check leaves `target` disabled, as
 * when the token's key has been revoked meanwhile, `fallback` takes the focus instead.
 */
export function useFocusOnceChecked(
  pending: boolean,
  onDone: (() => void) | undefined,
  target: RefObject<HTMLButtonElement | null>,
  fallback: RefObject<HTMLElement | null>,
): void {
  const checking = useAuth().status.state === 'checking'
  useEffect(() => {
    if (!pending || checking) return
    onDone?.()
    if (!focusLost()) return
    const button = target.current
    if (button !== null && !button.disabled) button.focus()
    else fallback.current?.focus()
  }, [pending, checking, onDone, target, fallback])
}
