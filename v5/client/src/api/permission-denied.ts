/**
 * What the API reports a 401 or a 403 as, wherever it is shown (AR2). It has a module of its own,
 * with no imports, so that the end-to-end tests can expect it without a copy of their own.
 */
export const PERMISSION_DENIED =
  'Permission denied. Set an API token with the required scope in Settings.'
