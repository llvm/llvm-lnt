import type { ReactNode } from 'react'
import styles from './badge.module.css'

interface Props {
  /** What the badge means, said on hover. */
  help: string
  /**
   * A light background of the caller's, such as a heat scale's, in place of the grey, on which the
   * text is in the page's own color.
   */
  color?: string
  children: ReactNode
}

/** A small label marking what it follows, grey unless colored, which explains itself on hover. */
export function Badge({ help, color, children }: Props) {
  return (
    <span
      className={styles.badge}
      style={color === undefined ? undefined : { background: color, color: 'var(--lnt-fg)' }}
      title={help}
    >
      {children}
    </span>
  )
}
