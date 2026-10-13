import type { ReactNode } from 'react'
import styles from './help-label.module.css'

/**
 * A label that explains itself on hover, with `help`. Not a `<label>`, which would also act on its
 * control when clicked for its help: the control refers to it with `aria-labelledby`, and is
 * described by the help with `aria-describedby`, since a title is not read reliably.
 */
export function HelpLabel({
  id,
  help,
  children,
}: {
  id: string
  help: string
  children: ReactNode
}) {
  return (
    <span id={id} className={styles.label} title={help}>
      {children}
    </span>
  )
}
