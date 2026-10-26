import { useRouteError } from 'react-router'

/**
 * The error boundary of the root route, which gives what a route threw back to React, rather than
 * show the router's own error page: so that an error no boundary of the app catches unmounts the
 * app, as it would without a router, and fails a test loudly.
 */
export function RethrowError(): never {
  throw useRouteError()
}
