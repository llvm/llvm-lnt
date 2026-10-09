import type { ReactNode } from 'react'
import { errorMessage } from '../api/client'
import styles from './feedback.module.css'

/** Something went wrong, in the page's own words. */
export function Alert({ children }: { children: ReactNode }) {
  return (
    <div className={styles.error} role="alert">
      {children}
    </div>
  )
}

interface ErrorMessageProps {
  error: unknown
  /** Offer to try again, with a button calling it. */
  onRetry?: () => void
  /** Trying again is under way. */
  retrying?: boolean
}

/** A failure, as the user should see it (see `errorMessage`). */
export function ErrorMessage({ error, onRetry, retrying = false }: ErrorMessageProps) {
  return (
    <Alert>
      {errorMessage(error)}
      {onRetry && (
        <button type="button" className={styles.retry} onClick={onRetry} disabled={retrying}>
          {retrying ? 'Retrying...' : 'Retry'}
        </button>
      )}
    </Alert>
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
