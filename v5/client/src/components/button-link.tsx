import type { ReactNode } from 'react'
import { Link } from 'react-router'
import styles from './button-link.module.css'

interface Props {
  /** Where the link leads, or null while it leads nowhere. */
  to: string | null
  /** Shown on hover: where the link leads, or why it leads nowhere. */
  title?: string
  children: ReactNode
}

/**
 * A link that looks like a button: an action leading to another page, in a row of actions. While
 * it leads somewhere, it is an ordinary SPA link, so that a modified click opens it in a new tab
 * (AR2). Otherwise it is no link at all, but text shown as disabled, saying why on hover (AR2
 * "Disabled links"), which can still be focused, and gives assistive technology the reason too.
 */
export function ButtonLink({ to, title, children }: Props) {
  if (to !== null) {
    return (
      <Link to={to} className={styles.button} title={title}>
        {children}
      </Link>
    )
  }
  return (
    <DisabledLink className={styles.button} title={title}>
      {children}
    </DisabledLink>
  )
}

interface DisabledLinkProps {
  /** Why the link leads nowhere, shown on hover and given to assistive technology. */
  title: string | undefined
  className?: string
  children: ReactNode
}

/**
 * A link that leads nowhere for now (AR2 "Disabled links"): text shown as disabled, which no click
 * follows, which can still be focused, and which says why on hover. Its look is its owner's, a
 * button's or a plain link's.
 */
export function DisabledLink({ title, className = styles.plain, children }: DisabledLinkProps) {
  return (
    <span role="link" aria-disabled="true" tabIndex={0} className={className} title={title}>
      {children}
    </span>
  )
}
