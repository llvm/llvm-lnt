import { useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { checkQueryKey, checkToken } from './credentials'
import type { TokenStore } from './token-store'
import { AuthContext, statusOf, type Auth } from './use-auth'

/**
 * Checks the token in `tokens` (see `createTokenStore`) whenever it changes, and provides the
 * outcome to `useAuth`. Rendered once, around the whole app, so that the check runs whether or not
 * anything shows it, and is shared by everything that does.
 */
export function AuthProvider({ tokens, children }: { tokens: TokenStore; children: ReactNode }) {
  const snapshot = useSyncExternalStore(tokens.subscribe, tokens.get)
  const { token } = snapshot
  const check = useQuery({
    queryKey: checkQueryKey(snapshot),
    queryFn: ({ signal }) => checkToken(token!, signal),
    enabled: token !== null,
    // Checked when the token changes or something asks for it again, never because time passed.
    staleTime: Infinity,
  })
  const { status, data, error } = check
  // A new object only when the outcome changes, so that a gated control re-renders only then.
  const auth = useMemo<Auth>(
    () => ({
      status: statusOf(token, { status, data, error }),
      setToken: tokens.set,
      clearToken: () => tokens.set(null),
      recheck: tokens.recheck,
    }),
    [token, status, data, error, tokens],
  )
  return <AuthContext value={auth}>{children}</AuthContext>
}
