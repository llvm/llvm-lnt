import { HttpResponse } from 'msw'
import type { Schemas } from '../api/client'
import { TOKEN_STORAGE_KEY } from '../auth/storage-key'
import type { ApiKey } from '../auth/credentials'
import type { Scope } from '../auth/scope'
import { errorResponse, mockApi } from './mock-api'
import { server } from './server'

/** A token of the right shape (I5). Which one does not matter, since the API is mocked. */
export const TOKEN = 'a'.repeat(64)

export function apiKey(scope: Scope, overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    prefix: TOKEN.slice(0, 8),
    name: `${scope}-key`,
    scope,
    created_at: '2026-08-11T13:04:23Z',
    last_used_at: null,
    is_active: true,
    ...overrides,
  }
}

/**
 * Act as a user holding a key of `scope`: store `TOKEN` as the app does, before rendering, and
 * have `GET /api/auth` accept it. Returns the headers the check was sent with, one per check.
 */
export function signIn(scope: Scope): string[] {
  localStorage.setItem(TOKEN_STORAGE_KEY, TOKEN)
  return mockAuth(() => HttpResponse.json({ key: apiKey(scope) }))
}

type AuthResponse = HttpResponse<Schemas['Authentication'] | Schemas['ErrorEnvelope']>

/** Answer every `GET /api/auth` with `respond`, recording the header each was sent with. */
export function mockAuth(respond: () => AuthResponse | Promise<AuthResponse>): string[] {
  const headers: string[] = []
  server.use(
    mockApi('get', '/api/auth', ({ request }) => {
      headers.push(request.headers.get('Authorization') ?? '')
      return respond()
    }),
  )
  return headers
}

/** The API's answer to a token it does not accept. */
export function unknownToken() {
  return errorResponse(401, 'unauthorized', 'This API key is unknown or has been revoked.')
}

/**
 * What the browser does in this tab when another one changes `localStorage`: change it, and
 * dispatch a `storage` event. A null `key` clears all of it, as `localStorage.clear()` would.
 */
export function changeInAnotherTab(key: string | null, value: string | null) {
  if (key === null) localStorage.clear()
  else if (value === null) localStorage.removeItem(key)
  else localStorage.setItem(key, value)
  window.dispatchEvent(new StorageEvent('storage', { key, newValue: value, storageArea: localStorage }))
}
