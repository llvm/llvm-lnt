import { QueryClient } from '@tanstack/react-query'
import { ApiError } from './client'

/** How many times a failed query is retried before its error is shown. */
const MAX_RETRIES = 2

/**
 * Retry only what may succeed unchanged: no response at all, a server error, or I4's `retry`
 * (a concurrent schema change, which leaves nothing written). Any other 4xx will fail the same way
 * again, and a non-API error is a bug in the client that retrying cannot fix.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES || !(error instanceof ApiError)) return false
  return error.status === 0 || error.status >= 500 || error.code === 'retry'
}

/**
 * The client every page fetches through, with defaults chosen for LNT:
 *
 * - What the user is looking at changes only when they ask for something else, or reload. A query
 *   is not refetched on window focus or reconnection, which would redraw a chart or reorder a
 *   table underneath them, and refetch every page of a progressively loaded dataset.
 * - Data stays fresh for a minute, so that a page shown again within that time does not refetch
 *   it. Data that never changes (a run's samples, a profile) can set a longer `staleTime`; a
 *   mutation invalidates whatever it changes. How long unused data stays cached at all, so that
 *   going back renders it at once (GR7), is TanStack's `gcTime`, left at its default of five
 *   minutes for now.
 * - Mutations are never retried: a write that failed is reported rather than repeated.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        staleTime: 60_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
      mutations: { retry: false },
    },
  })
}
