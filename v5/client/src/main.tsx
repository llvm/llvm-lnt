import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './app.tsx'
import { createQueryClient } from './api/query-client'
import { AuthProvider } from './auth/auth-provider'
import { createTokenStore } from './auth/credentials'
import { UrlStateProvider } from './url-state-provider'

const queryClient = createQueryClient()
const tokens = createTokenStore(queryClient)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider tokens={tokens}>
        <BrowserRouter>
          <UrlStateProvider>
            <App />
          </UrlStateProvider>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
)
