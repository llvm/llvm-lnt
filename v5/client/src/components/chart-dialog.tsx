import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import styles from './chart-dialog.module.css'

/**
 * Where a dialog opens: beside a place on the chart, in pixels in the chart's container, on its
 * left or its right, and centred on it, or starting at it for a place at the top of the plot.
 */
export interface Anchor {
  x: number
  y: number
  side: 'left' | 'right'
  align?: 'center' | 'start'
}

interface Props {
  /** The dialog's accessible name. */
  label: string
  /** What its header shows. */
  title: ReactNode
  at: Anchor
  /** What belongs with it, besides itself: a press on it is no press outside. */
  companion?: RefObject<Element | null>
  /** Close it: by the keyboard, its button, or a press outside it. */
  onClose(): void
  children: ReactNode
}

/**
 * A dialog beside a place on a chart -- a point (GR11), a regression's marker (GR15), a bar (CP3) --
 * which takes the focus and stays open as the pointer moves, so that its links can be followed,
 * until Escape, its close button, or a press outside it and its companion. It is not a React Aria
 * popover, which places itself again only on a resize, closes on a scroll or a blur, and, modal,
 * would take the press that opens another one's dialog. Its content lays itself out with the
 * classes of chart-dialog.module.css.
 *
 * It is placed in the chart's container, which has the `host` class of chart-dialog.module.css and
 * can be focused (`tabIndex={-1}`): closed from the keyboard or its button, the dialog gives the
 * focus back to it, rather than to the page; closed by a press elsewhere, it leaves the focus where
 * the press put it.
 */
export function ChartDialog({ label, title, at, companion, onClose, children }: Props) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => root.current?.focus(), [])
  useEffect(() => {
    // A press on another point closes this one before the click opens that one's.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (root.current?.contains(target) || companion?.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [onClose, companion])
  const closeToHost = () => {
    root.current?.parentElement?.focus({ preventScroll: true })
    onClose()
  }

  return (
    <div
      ref={root}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      className={styles.dialog}
      style={{
        left: at.x,
        top: at.y,
        transform:
          `translate(${at.side === 'right' ? '12px' : 'calc(-100% - 12px)'}, ` +
          `${at.align === 'start' ? '-12px' : '-50%'})`,
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') closeToHost()
      }}
    >
      <div className={styles.header}>
        <strong className={styles.title}>{title}</strong>
        <button
          type="button"
          className={styles.close}
          aria-label="Close"
          onClick={closeToHost}
        >
          ×
        </button>
      </div>
      {children}
    </div>
  )
}
