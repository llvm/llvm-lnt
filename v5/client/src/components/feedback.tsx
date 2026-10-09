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

/** A failure, as the user should see it (see `errorMessage`). */
export function ErrorMessage({ error }: { error: unknown }) {
  return <Alert>{errorMessage(error)}</Alert>
}

/** Something is on its way. */
export function Loading({ label = 'Loading...' }: { label?: string }) {
  return (
    <div className={styles.loading} role="status">
      {label}
    </div>
  )
}
