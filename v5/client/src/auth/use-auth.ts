import { createContext, useContext } from 'react'
import type { FetchStatus, QueryStatus } from '@tanstack/react-query'
import { ApiError } from '../api/client'
import { UnsendableTokenError, type ApiKey } from './credentials'

/** What the latest check says about the token (AR2). */
export type TokenStatus =
  | { state: 'none' }
  | { state: 'checking' }
  | { state: 'valid'; key: ApiKey }
  /** The API refused the token with a 401 (unknown, malformed or revoked), or it cannot be sent. */
  | { state: 'invalid' }
  /** The check itself failed, so the token may or may not be valid. */
  | { state: 'failed'; error: unknown }

export interface Auth {
  status: TokenStatus
  /** Store the token, and check it, even if it is the one already stored. */
  setToken(token: string): void
  clearToken(): void
  /** Check the token again. */
  recheck(): void
}

/** The parts of the check's query result that decide the status. */
interface Check {
  status: QueryStatus
  fetchStatus: FetchStatus
  data: ApiKey | undefined
  error: Error | null
}

export function statusOf(token: string | null, check: Check): TokenStatus {
  if (token === null) return { state: 'none' }
  if (check.fetchStatus === 'fetching' || check.status === 'pending') return { state: 'checking' }
  if (check.status === 'success') return { state: 'valid', key: check.data! }
  if (check.error instanceof UnsendableTokenError) return { state: 'invalid' }
  if (check.error instanceof ApiError && check.error.status === 401) return { state: 'invalid' }
  return { state: 'failed', error: check.error }
}

/** `AuthProvider` provides it. */
export const AuthContext = createContext<Auth | null>(null)

/** The token, what its check says about it, and how to change it. */
export function useAuth(): Auth {
  const auth = useContext(AuthContext)
  if (auth === null) throw new Error('useAuth must be used inside an AuthProvider')
  return auth
}
