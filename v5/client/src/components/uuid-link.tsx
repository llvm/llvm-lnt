import { Link } from 'react-router'
import { shortUuid } from '../format'
import styles from './uuid-link.module.css'

/** An entity's UUID, shortened as AR6 says, in full on hover, linking to the entity's page. */
export function UuidLink({ uuid, to }: { uuid: string; to: string }) {
  return (
    <Link to={to} title={uuid} className={styles.uuid}>
      {shortUuid(uuid)}
    </Link>
  )
}
