import type { ReactNode, Ref } from 'react'
import { errorMessage } from '../api/client'
import { failureShown, isMissing } from '../api/shown-data'
import styles from './feedback.module.css'

/**
 * Something went wrong, in the page's own words. With `tabIndex={-1}`, it can take the focus from
 * script, for when it replaces what had the focus.
 */
export function Alert({
  children,
  ref,
  tabIndex,
}: {
  children: ReactNode
  ref?: Ref<HTMLDivElement>
  tabIndex?: number
}) {
  return (
    <div ref={ref} className={styles.error} role="alert" tabIndex={tabIndex}>
      {children}
    </div>
  )
}

interface ErrorMessageProps {
  error: unknown
  /** What could not be done, said before why, where the page shows several failures. */
  context?: string
  /**
   * Offer to try again, with a button calling it, unless the API answered that what was asked for
   * does not exist: asking again would get the same answer.
   */
  onRetry?: () => void
}

/** A failure, as the user should see it (see `errorMessage`). */
export function ErrorMessage({ error, context, onRetry }: ErrorMessageProps) {
  const missing = isMissing(error)
  return (
    <Alert>
      {context !== undefined && `${context}: `}
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

interface LoadedProps<Data> {
  /**
   * The data of the query asked for, if it has any, or another query's, kept as a placeholder while
   * it loads, but not once it has failed (see `shownData`).
   */
  data: Data | undefined
  /** Why the data could not be fetched, shown with a way to try again (see `failureShown`). */
  error: Error | null
  onRetry(): void
  /** What shows the data. */
  children(data: Data): ReactNode
  /** What to say while the data loads, if not that it is loading. */
  label?: string
  /** What could not be loaded, said before why, as `ErrorMessage` does. */
  context?: string
}

/**
 * A section showing data it fetches: that it is loading, why it failed, or the data. A failure to
 * fetch again data already shown leaves it shown, unless the failure says that it no longer exists
 * (AR7).
 */
export function Loaded<Data>({ data, error, onRetry, children, label, context }: LoadedProps<Data>) {
  if (failureShown(data, error)) {
    return <ErrorMessage context={context} error={error} onRetry={onRetry} />
  }
  if (data === undefined) return <Loading label={label} />
  return children(data)
}
