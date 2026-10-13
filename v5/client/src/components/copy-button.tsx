import { useEffect, useState, type ReactNode } from 'react'
import { VisuallyHidden } from 'react-aria-components'
import clsx from 'clsx'
import styles from './copy-button.module.css'

/** How long the outcome of a copy is shown in place of the button's label. */
export const FEEDBACK_MS = 2000

const COPIED = 'Copied.'
const FAILED = 'Could not copy.'

interface Props {
  /** What to copy. */
  text: string
  /** The button's label. */
  children: ReactNode
  /** The id of the element describing the button to assistive technology. */
  describedBy?: string
  /** Take the focus when shown. */
  autoFocus?: boolean
}

/**
 * A button copying `text` to the clipboard, saying briefly in place of its label whether that
 * worked, and to assistive technology through a live region. The button is as wide as the widest
 * of its label and its outcomes, so that showing one moves nothing around it.
 *
 * Copying can fail: a page served over plain HTTP from another host than `localhost` has no
 * clipboard, and the browser may refuse to write to it.
 */
export function CopyButton({ text, children, describedBy, autoFocus }: Props) {
  // An object, so that copying again while the outcome shows restarts its timer.
  const [outcome, setOutcome] = useState<{ message: typeof COPIED | typeof FAILED } | null>(null)
  useEffect(() => {
    if (outcome === null) return
    const timer = setTimeout(() => setOutcome(null), FEEDBACK_MS)
    return () => clearTimeout(timer)
  }, [outcome])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setOutcome({ message: COPIED })
    } catch {
      setOutcome({ message: FAILED })
    }
  }

  // Every label takes up the same cell, the ones not shown hidden, from assistive technology too,
  // but still sizing it.
  const shown = outcome?.message
  const part = (which: typeof shown, className?: string) =>
    shown === which
      ? { className: clsx(styles.part, className) }
      : { className: clsx(styles.part, styles.hidden, className), 'aria-hidden': true as const }
  return (
    <>
      <button
        type="button"
        className={styles.root}
        aria-describedby={describedBy}
        autoFocus={autoFocus}
        onClick={() => void copy()}
      >
        <span {...part(undefined)}>{children}</span>
        <span {...part(COPIED)}>{COPIED}</span>
        <span {...part(FAILED, styles.failed)}>{FAILED}</span>
      </button>
      <VisuallyHidden elementType="span" role="status">
        {shown}
      </VisuallyHidden>
    </>
  )
}
