import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createBrowserRouter } from 'react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import { rootRoute, routes } from './app.tsx'
import { createQueryClient } from './api/query-client'
import { AuthProvider } from './auth/auth-provider'
import { createTokenStore } from './auth/credentials'

const queryClient = createQueryClient()
const tokens = createTokenStore(queryClient)
const router = createBrowserRouter([rootRoute(routes)])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider tokens={tokens}>
        {/* Without transitions, a control kept in the URL shows a change on the click that makes
            it, rather than once the navigation it triggers has rendered in the background. On the
            other hand, going to a page whose code has not loaded yet shows the loading fallback
            in place of the page left, rather than keep it up until the new one is ready. */}
        <RouterProvider router={router} useTransitions={false} />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
)
