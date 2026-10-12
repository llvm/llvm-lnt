import type { QueryClient } from '@tanstack/react-query'

/**
 * The roots of the query keys, so that a change can invalidate exactly the queries it affects:
 *
 * - `suites`: the list of test suites, with their schemas.
 * - `apiKeys`: the list of API keys (E11), which only an `admin` token can read.
 * - `suite(name)`: everything read from inside one suite, under `['suite', name, <what>, ...]`, so
 *   that a write to a suite can invalidate its data without touching any other query -- notably
 *   the token check (see auth/credentials.ts), which re-running would make gated controls flicker.
 */
export const queryKeys = {
  suites: ['suites'] as const,
  apiKeys: ['api-keys'] as const,
  suite: (name: string) => ['suite', name] as const,
  /** Everything read about the suite's machines: lists, whatever their filters, and details. */
  machines: (suite: string) => ['suite', suite, 'machines'] as const,
  /**
   * Everything read about the suite's commits: lists, whatever their filters, details, and the
   * lookups of a commit's resolution or of the one before it on a machine.
   */
  commits: (suite: string) => ['suite', suite, 'commits'] as const,
  /** Everything read about the suite's runs: lists, whatever their filters, and details. */
  runs: (suite: string) => ['suite', suite, 'runs'] as const,
  /** The names of the suite's tests, as listed for a machine and a metric. */
  tests: (suite: string) => ['suite', suite, 'tests'] as const,
  /** Everything read about the suite's regressions: lists, whatever their filters, and details. */
  regressions: (suite: string) => ['suite', suite, 'regressions'] as const,
  /** The suite's trends (E9), whatever their metric, machines and window. */
  trends: (suite: string) => ['suite', suite, 'trends'] as const,
}

/**
 * Forget what was read from inside `suite`, after a change that may affect any of it: a deletion
 * (AR16), or a change to the suite's schema. What no page shows is dropped rather than
 * marked stale, so that the page shown next does not show what was deleted or changed while it
 * fetches its data again. What a page shows is fetched again, unless `leaving` says that it is the
 * page about to leave the entity it deleted, which must not ask for the entity again, and drops
 * what it read once it has gone (see `forgetUnobserved`).
 */
export async function forgetSuite(
  queryClient: QueryClient,
  suite: string,
  { leaving }: { leaving: boolean },
): Promise<void> {
  const queryKey = queryKeys.suite(suite)
  queryClient.removeQueries({ queryKey, type: 'inactive' })
  await queryClient.invalidateQueries({ queryKey, refetchType: leaving ? 'none' : 'active' })
}

/**
 * Drop what was read from inside `suite` that nothing observes any more: what the page that deleted
 * an entity read, once it has gone (see `forgetSuite`). Unlike `type: 'inactive'`, this leaves alone
 * a query that a page reads only through disabled observers, which would be left holding a query
 * the cache no longer has.
 */
export function forgetUnobserved(queryClient: QueryClient, suite: string): void {
  queryClient.removeQueries({
    queryKey: queryKeys.suite(suite),
    predicate: (query) => query.getObserversCount() === 0,
  })
}
