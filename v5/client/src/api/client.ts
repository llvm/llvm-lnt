/**
 * The typed client for the v5 REST API.
 *
 * Calls go through `openapi-fetch`, typed by the generated `schema.d.ts`, and are passed through
 * `unwrap`, which returns the response body or throws an `ApiError`:
 *
 *     const suites = await unwrap(api.GET('/api/suites', { signal }))
 *
 * There are two clients. `api` never sends the stored token, because every `read` endpoint can be
 * used without it (I5) and a stale or revoked token would turn those into 401s. `authedApi` sends
 * the token from `setCredentials`, and is for the requests that need more than `read` scope. The
 * check of a token (AR2) passes it to `api` explicitly, since it is not accepted yet.
 */

import createClient, { type Middleware } from 'openapi-fetch'
import type { components, paths } from './schema'

export type Schemas = components['schemas']

/** What the API reports a 401 or a 403 as, wherever it is shown (AR2). */
export const PERMISSION_DENIED =
  'Permission denied. Set an API token with the required scope in Settings.'

/**
 * A failed API call.
 *
 * `code` and `message` come from the API's error envelope (I4) when the response carries one. A
 * failure without one -- no response at all, or a response the API did not produce, such as a
 * proxy's 502 or the transport-level 413 -- has a `code` of null and a message written here.
 */
export class ApiError extends Error {
  /** The HTTP status, or 0 when no response arrived. */
  readonly status: number
  /** The API's machine-readable error code, to branch on. */
  readonly code: string | null

  constructor(status: number, code: string | null, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }

  /** Whether the token is missing, invalid or lacks the scope the request needs. */
  get isPermissionDenied(): boolean {
    return this.status === 401 || this.status === 403
  }
}

/** What to tell the user about a failure (AR2): the API's message, unless permission was denied. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.isPermissionDenied ? PERMISSION_DENIED : error.message
  if (error instanceof Error && error.message) return error.message
  return 'Something went wrong.'
}

function isEnvelope(body: unknown): body is Schemas['ErrorEnvelope'] {
  const error = (body as Partial<Schemas['ErrorEnvelope']> | null)?.error
  return typeof error?.code === 'string' && typeof error.message === 'string'
}

function errorFromResponse(status: number, body: unknown): ApiError {
  if (isEnvelope(body)) return new ApiError(status, body.error.code, body.error.message)
  if (status === 413) return new ApiError(status, null, 'The request is too large for the server.')
  return new ApiError(status, null, `The server answered with an unexpected HTTP ${status}.`)
}

/** The body of a successful response, or the `ApiError` its failure amounts to. */
export async function unwrap<Data>(
  request: Promise<{ data?: Data; error?: unknown; response: Response }>,
): Promise<Data> {
  const { data, error, response } = await request
  if (!response.ok) throw errorFromResponse(response.status, error)
  return data as Data
}

/** What `authedApi` authenticates with. The auth module provides it (see auth/credentials.ts). */
export interface Credentials {
  /** The token to send, or null to send none. */
  token(): string | null
  /** A request sent with `token` got a 401: its key may have been revoked since it was checked. */
  rejected(token: string): void
}

/** What `authedApi` has until the auth module provides better: no token at all. */
export const NO_CREDENTIALS: Credentials = { token: () => null, rejected: () => {} }

let credentials = NO_CREDENTIALS

export function setCredentials(source: Credentials): void {
  credentials = source
}

const sendToken: Middleware = {
  onRequest({ request }) {
    const token = credentials.token()
    if (token) request.headers.set('Authorization', `Bearer ${token}`)
    return request
  },
  onResponse({ request, response }) {
    const sent = request.headers.get('Authorization')?.replace(/^Bearer /, '')
    if (response.status === 401 && sent) credentials.rejected(sent)
    return response
  },
}

/**
 * A request that got no response. An abort is passed through as it is, so that whoever aborted
 * it -- TanStack Query cancelling a query nobody uses any more -- recognizes it.
 */
const reportNetworkFailure: Middleware = {
  onError({ request, error }) {
    if (request.signal.aborted) return error instanceof Error ? error : undefined
    return new ApiError(0, null, 'Could not reach the server.')
  },
}

function makeClient(...middleware: Middleware[]) {
  const client = createClient<paths>({
    // Paths in the document already start with `/api`, and the API is served by the same origin
    // as the client. Absolute, because `Request` rejects relative URLs outside a browser.
    baseUrl: globalThis.location.origin,
    // Looked up on every call rather than captured now, so that whatever replaces `fetch` later
    // -- a test's mock server -- is used.
    fetch: (request) => globalThis.fetch(request),
  })
  client.use(...middleware, reportNetworkFailure)
  return client
}

/** For every request that `read` scope allows, which never needs a token. */
export const api = makeClient()

/** For the requests that need more than `read` scope, and for checking a token. */
export const authedApi = makeClient(sendToken)
