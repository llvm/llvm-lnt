import { Link } from 'react-router'
import clsx from 'clsx'
import { shortUuid } from '../format'
import styles from './uuid-link.module.css'

interface Props {
  uuid: string
  to: string
  /** What the UUID is shown after, such as `UUID`, if anything. */
  label?: string
  className?: string
}

/** An entity's UUID, shortened as AR6 says, in full on hover, linking to the entity's page. */
export function UuidLink({ uuid, to, label, className }: Props) {
  return (
    <Link to={to} title={uuid} className={clsx(styles.link, className)}>
      {label !== undefined && `${label} `}
      <span className={styles.uuid}>{shortUuid(uuid)}</span>
    </Link>
  )
}
