import type { ReactElement, ReactNode } from 'react'
import { render } from '@testing-library/react'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { createQueryClient } from '../api/query-client'
import { AuthProvider } from '../auth/auth-provider'
import { createTokenStore } from '../auth/credentials'
import { UrlStateProvider } from '../url-state-provider'

interface Options {
  /** The URL the router starts at. */
  url?: string
}

/**
 * A query client of the test's own, so that no cache carries over from one test to the next. It
 * has the app's defaults, except that it does not retry, so that a failing request is reported at
 * once.
 */
function createTestQueryClient(): QueryClient {
  const queryClient = createQueryClient()
  const defaults = queryClient.getDefaultOptions()
  queryClient.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: false } })
  return queryClient
}

/**
 * A wrapper providing what the app does, for `renderHook`: a router, a fresh query client, and a
 * token store connected to the API client, which starts with the token in `localStorage` (see
 * `signIn`).
 */
export function providers({ url = '/' }: Options = {}) {
  const queryClient = createTestQueryClient()
  const tokens = createTokenStore(queryClient)
  function Providers({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <AuthProvider tokens={tokens}>
          <MemoryRouter initialEntries={[url]}>
            <UrlStateProvider>{children}</UrlStateProvider>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>
    )
  }
  return { wrapper: Providers, queryClient }
}

/** Render `ui` under `providers`. */
export function renderWithProviders(ui: ReactElement, options: Options = {}) {
  const { wrapper, queryClient } = providers(options)
  return { ...render(ui, { wrapper }), queryClient }
}
