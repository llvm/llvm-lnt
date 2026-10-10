import type { ReactNode } from 'react'
import clsx from 'clsx'
import tableStyles from './data-table.module.css'
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

interface InfoRowProps {
  label: ReactNode
  children: ReactNode
  /** Set the value in a fixed-width font, as a table sets an identifier (see `CellLook`). */
  mono?: boolean
}

export function InfoRow({ label, children, mono = false }: InfoRowProps) {
  return (
    <div className={styles.row}>
      <dt className={styles.label}>{label}</dt>
      <dd className={clsx(styles.value, mono && tableStyles.mono)}>{children}</dd>
    </div>
  )
}
