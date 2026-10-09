import type { ReactNode } from 'react'
import styles from './controls-panel.module.css'

/**
 * The box around a page's selection controls -- filters, searches, settings -- setting them apart
 * from its content (AR2 "Design consistency").
 */
export function ControlsPanel({ children }: { children: ReactNode }) {
  return <div className={styles.root}>{children}</div>
}
