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
  /** Every list of the suite's regressions, whatever its filters. */
  regressions: (suite: string) => ['suite', suite, 'regressions'] as const,
}
