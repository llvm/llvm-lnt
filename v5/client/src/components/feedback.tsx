import { errorMessage } from '../api/client'
import styles from './feedback.module.css'

/** A failure, as the user should see it (see `errorMessage`). */
export function ErrorMessage({ error }: { error: unknown }) {
  return (
    <div className={styles.error} role="alert">
      {errorMessage(error)}
    </div>
  )
}

/** Something is on its way. */
export function Loading({ label = 'Loading...' }: { label?: string }) {
  return (
    <div className={styles.loading} role="status">
      {label}
    </div>
  )
}
