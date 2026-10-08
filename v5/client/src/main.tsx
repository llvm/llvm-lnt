import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './app.tsx'
import { createQueryClient } from './api/query-client'
import { UrlStateProvider } from './url-state-provider'

const queryClient = createQueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <UrlStateProvider>
          <App />
        </UrlStateProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
