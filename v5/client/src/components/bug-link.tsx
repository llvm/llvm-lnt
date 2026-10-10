import clsx from 'clsx'
import { MISSING } from '../format'
import styles from './bug-link.module.css'

interface Props {
  bug: string | null
  /** Cut a long one short, showing it whole on hover, as a table cell does. */
  truncate?: boolean
}

/**
 * A regression's bug (AR2): a link opening in a new tab when it is a web URL, and plain text
 * otherwise, since the API stores whatever string it is given, and a link must not run a
 * `javascript:` one.
 */
export function BugLink({ bug, truncate = false }: Props) {
  if (bug === null) return MISSING
  const className = clsx(truncate && styles.truncated)
  if (!/^https?:\/\//i.test(bug)) return <span className={className}>{bug}</span>
  return (
    <a
      className={className}
      href={bug}
      target="_blank"
      rel="noopener noreferrer"
      title={truncate ? bug : undefined}
    >
      {bug}
    </a>
  )
}
