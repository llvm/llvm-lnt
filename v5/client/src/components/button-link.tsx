import type { ReactNode } from 'react'
import { Link } from 'react-router'
import styles from './button-link.module.css'

/**
 * A link that looks like a button: an action leading to another page, in a row of actions. It is
 * an ordinary SPA link, so that a modified click opens it in a new tab (AR2).
 */
export function ButtonLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className={styles.button}>
      {children}
    </Link>
  )
}
