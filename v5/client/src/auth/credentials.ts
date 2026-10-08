/**
 * How the token reaches the API client: the check AR2 runs on it, and what `authedApi` sends.
 *
 * The SPA behaves as if no token were set until a check accepts it (AR2), so `authedApi` sends a
 * token only once its check has succeeded, and the check itself is the only request that carries
 * one that has not been accepted yet. A 401 on a request sent with an accepted token means that the
 * key has been revoked since, so the token is checked again, which reports it as no longer valid.
 */

import type { QueryClient } from '@tanstack/react-query'
import { api, setCredentials, unwrap, type Schemas } from '../api/client'
import { TokenStore, type TokenSnapshot } from './token-store'

export type ApiKey = Schemas['ApiKey']

/**
 * The query of one check. Every change to the token is a generation of its own, so that each is
 * checked afresh; the token itself stays out of the key, and so out of anything that shows keys.
 */
export function checkQueryKey({ generation }: TokenSnapshot) {
  return ['auth', generation] as const
}

/**
 * A token that cannot be sent in an HTTP header at all, such as one with a character outside
 * Latin-1. No server could accept it, so it is not valid, as much as one the server refuses.
 */
export class UnsendableTokenError extends Error {
  constructor() {
    super('The token contains characters that cannot be sent to the server.')
    this.name = 'UnsendableTokenError'
  }
}

/** The key `token` belongs to, from `GET /api/auth` (E12). A token it does not accept is a 401. */
export async function checkToken(token: string, signal?: AbortSignal): Promise<ApiKey> {
  const headers = new Headers()
  try {
    headers.set('Authorization', `Bearer ${token}`)
  } catch {
    throw new UnsendableTokenError()
  }
  const request = api.GET('/api/auth', { headers, signal })
  const { key } = await unwrap(request)
  // Only a request without credentials gets no key back, so the token never reached the server.
  if (key === null) throw new Error('The server received no token.')
  return key
}

/** The token, if its latest check succeeded. */
export function acceptedToken(tokens: TokenStore, queryClient: QueryClient): string | null {
  const snapshot = tokens.get()
  if (snapshot.token === null) return null
  // The status rather than the data, which a failed check leaves in place.
  const check = queryClient.getQueryState(checkQueryKey(snapshot))
  return check?.status === 'success' ? snapshot.token : null
}

/**
 * The app's token, with `authedApi` authenticating with it as checked through `queryClient`. Render
 * an `AuthProvider` with it, which runs the checks.
 */
export function createTokenStore(queryClient: QueryClient): TokenStore {
  const tokens = new TokenStore()
  setCredentials({
    token: () => acceptedToken(tokens, queryClient),
    // Only the accepted token is checked again: a refusal of one replaced since says nothing about
    // the current one. Several refusals at once start one check, which the others find under way,
    // the token being no longer accepted meanwhile.
    rejected: (sent) => {
      if (acceptedToken(tokens, queryClient) === sent) tokens.recheck()
    },
  })
  return tokens
}
