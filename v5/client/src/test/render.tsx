import { createContext, useContext, type ReactElement, type ReactNode } from 'react'
import { render } from '@testing-library/react'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { createMemoryRouter, type RouteObject } from 'react-router'
import { rootRoute } from '../app'
import { createQueryClient } from '../api/query-client'
import { AuthProvider } from '../auth/auth-provider'
import { createTokenStore } from '../auth/credentials'
import { AppRouterProvider } from '../router-provider'

interface Options {
  /** The URL the router starts at. */
  url?: string
}

/** What the wrapper of `providers` is given to render, for the route rendering it. */
const Content = createContext<ReactNode>(null)

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
 * `signIn`). The router has `routes`, or else renders what the wrapper is given at every URL.
 */
export function providers({ url = '/', routes }: Options & { routes?: RouteObject[] } = {}) {
  const queryClient = createTestQueryClient()
  const tokens = createTokenStore(queryClient)
  function ContentRoute() {
    return useContext(Content)
  }
  const router = createMemoryRouter(
    [rootRoute(routes ?? [{ path: '*', element: <ContentRoute /> }])],
    { initialEntries: [url] },
  )
  function Providers({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <AuthProvider tokens={tokens}>
          <Content.Provider value={children}>
            <AppRouterProvider router={router} />
          </Content.Provider>
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

/** Render a router with `routes` under `providers`. */
export function renderRoutes(routes: RouteObject[], options: Options = {}) {
  const { wrapper, queryClient } = providers({ ...options, routes })
  return { ...render(<></>, { wrapper }), queryClient }
}
