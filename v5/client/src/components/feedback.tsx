import { errorMessage } from '../api/client'
import './feedback.css'

/** A failure, as the user should see it (see `errorMessage`). */
export function ErrorMessage({ error }: { error: unknown }) {
  return (
    <div className="error-message" role="alert">
      {errorMessage(error)}
    </div>
  )
}

/** Something is on its way. */
export function Loading({ label = 'Loading...' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      {label}
    </div>
  )
}
