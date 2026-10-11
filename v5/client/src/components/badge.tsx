import type { ReactNode } from 'react'
import styles from './badge.module.css'

/** A small grey label marking what it follows, which explains itself on hover. */
export function Badge({ help, children }: { help: string; children: ReactNode }) {
  return (
    <span className={styles.badge} title={help}>
      {children}
    </span>
  )
}
