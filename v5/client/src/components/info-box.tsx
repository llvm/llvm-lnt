import type { ReactNode } from 'react'
import styles from './info-box.module.css'

/**
 * The box at the top of a detail page, listing what the entity is: one `InfoRow` per attribute,
 * label on the left and value on the right.
 */
export function InfoBox({ label, children }: { label: string; children: ReactNode }) {
  return (
    // A group, for its name to reach assistive technology: a list of definitions has no role.
    <dl className={styles.box} role="group" aria-label={label}>
      {children}
    </dl>
  )
}

export function InfoRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <dt className={styles.label}>{label}</dt>
      <dd className={styles.value}>{children}</dd>
    </div>
  )
}
