/** A query result, as far as its failure goes. */
interface Fetched {
  error: Error | null
  refetch: () => unknown
}

/** Why some of several queries failed, if any did, and how to fetch again those that failed. */
export interface Failures {
  /** The error of the first query that failed, or null if none did. */
  error: Error | null
  retry(): void
}

/** The failures among `results`, the results of several queries shown together. */
export function failuresOf(results: readonly Fetched[]): Failures {
  const failed = results.filter((result) => result.error !== null)
  return {
    error: failed[0]?.error ?? null,
    retry: () => failed.forEach((result) => void result.refetch()),
  }
}
