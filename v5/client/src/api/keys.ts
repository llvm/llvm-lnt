import type { QueryClient } from '@tanstack/react-query'

/**
 * The roots of the query keys, so that a change can invalidate exactly the queries it affects:
 *
 * - `suites`: the list of test suites, with their schemas.
 * - `suite(name)`: everything read from inside one suite, under `['suite', name, <what>, ...]`, so
 *   that a write to a suite can invalidate its data without touching any other query -- notably
 *   the token check (see auth/credentials.ts), which re-running would make gated controls flicker.
 */
export const queryKeys = {
  suites: ['suites'] as const,
  suite: (name: string) => ['suite', name] as const,
  /** Everything read about the suite's machines: lists, whatever their filters, and details. */
  machines: (suite: string) => ['suite', suite, 'machines'] as const,
  /** Everything read about the suite's runs: lists, whatever their filters, and details. */
  runs: (suite: string) => ['suite', suite, 'runs'] as const,
  /** Every list of the suite's regressions, whatever its filters. */
  regressions: (suite: string) => ['suite', suite, 'regressions'] as const,
}

/**
 * Forget what was read from inside `suite`, after a deletion that may change any of it (AR2
 * "Deletions"). What no page shows is dropped rather than marked stale, so that the page shown
 * next does not list the deleted entity while it fetches its data again. What a page shows is
 * fetched again, unless `leaving` says that it is the page about to leave the entity it deleted,
 * which must not ask for the entity again, nor go on fetching it.
 */
export async function forgetSuite(
  queryClient: QueryClient,
  suite: string,
  { leaving }: { leaving: boolean },
): Promise<void> {
  const queryKey = queryKeys.suite(suite)
  if (leaving) await queryClient.cancelQueries({ queryKey })
  queryClient.removeQueries({ queryKey, type: 'inactive' })
  await queryClient.invalidateQueries({ queryKey, refetchType: leaving ? 'none' : 'active' })
}
