import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter } from 'react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import { rootRoute, routes } from './app.tsx'
import { createQueryClient } from './api/query-client'
import { AuthProvider } from './auth/auth-provider'
import { createTokenStore } from './auth/credentials'
import { AppRouterProvider } from './router-provider'

const queryClient = createQueryClient()
const tokens = createTokenStore(queryClient)
const router = createBrowserRouter([rootRoute(routes)])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider tokens={tokens}>
        <AppRouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
)
