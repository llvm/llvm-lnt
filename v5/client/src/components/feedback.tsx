import type { ReactNode } from 'react'
import { ApiError, errorMessage } from '../api/client'
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
  /**
   * Offer to try again, with a button calling it, unless the API answered that what was asked for
   * does not exist: asking again would get the same answer.
   */
  onRetry?: () => void
}

/** A failure, as the user should see it (see `errorMessage`). */
export function ErrorMessage({ error, onRetry }: ErrorMessageProps) {
  const missing = error instanceof ApiError && error.status === 404
  return (
    <Alert>
      {errorMessage(error)}
      {onRetry && !missing && (
        <button type="button" className={styles.retry} onClick={onRetry}>
          Retry
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

interface LoadedProps {
  isPending: boolean
  /** Why the data could not be fetched, shown in place of `children`, with a way to try again. */
  error: Error | null
  onRetry(): void
  /** What shows the data, rendered once there is no failure and nothing pending. */
  children: ReactNode
}

/**
 * A section showing data it fetches: that it is loading, why it failed, or the data. A failure takes
 * the place of the data rather than leave up what was shown before (AR2 "Paginated tables").
 */
export function Loaded({ isPending, error, onRetry, children }: LoadedProps) {
  if (error) return <ErrorMessage error={error} onRetry={onRetry} />
  if (isPending) return <Loading />
  return children
}
