import { useEffect, useRef, type ReactNode } from 'react'
import styles from './graph.module.css'

/** Where a dialog opens: beside a place on the chart, in pixels in the chart's container. */
export interface Anchor {
  x: number
  y: number
  side: 'left' | 'right'
}

interface Props {
  /** The dialog's accessible name. */
  label: string
  /** What its header shows. */
  title: ReactNode
  at: Anchor
  /** Close it: by the keyboard or its button (`returnFocus`), or by a press outside it. */
  onClose(returnFocus?: boolean): void
  children: ReactNode
}

/**
 * A dialog beside a place on the chart -- a point (GR11), a regression's marker (GR15) -- which
 * takes the focus and stays open as the pointer moves, so that its links can be followed, until
 * Escape, its close button, or a press outside it. It is not a React Aria popover, which places
 * itself again only on a resize, closes on a scroll or a blur, and, modal, would take the press
 * that opens another one's dialog.
 */
export function ChartDialog({ label, title, at, onClose, children }: Props) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => root.current?.focus(), [])
  useEffect(() => {
    // A press on another point closes this one before the click opens that one's.
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [onClose])

  return (
    <div
      ref={root}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      className={styles.details}
      style={{
        left: at.x,
        top: at.y,
        transform: `translate(${at.side === 'right' ? '12px' : 'calc(-100% - 12px)'}, -50%)`,
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose(true)
      }}
    >
      <div className={styles.detailsHeader}>
        <strong className={styles.detailsTitle}>{title}</strong>
        <button
          type="button"
          className={styles.remove}
          aria-label="Close"
          onClick={() => onClose(true)}
        >
          ×
        </button>
      </div>
      {children}
    </div>
  )
}
