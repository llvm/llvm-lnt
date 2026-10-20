/** The parts of a query result that keeps the previous query's data as a placeholder. */
interface Placeheld<Data> {
  data: Data | undefined
  isPlaceholderData: boolean
  errorUpdateCount: number
}

/**
 * The data to show of a query using `keepPreviousData`: the previous query's while the one asked
 * for loads, so that a table changes page without flashing a loading state, but none while a query
 * that failed is tried again. TanStack shows the placeholder then too, which would bring back the
 * rows of another page or search in place of the failure (AR7).
 */
export function shownData<Data>({
  data,
  isPlaceholderData,
  errorUpdateCount,
}: Placeheld<Data>): Data | undefined {
  return isPlaceholderData && errorUpdateCount > 0 ? undefined : data
}

/** The parts of a query result that tell whether it is fetched again after a failure. */
interface Refetched {
  isError: boolean
  isFetching: boolean
}

/**
 * Whether a query whose data is shown is being fetched again after a failure: starting again after
 * a rejected cursor (I2), or tried again. That may recover from the failure, so the list is loading
 * rather than failing (AR7). TanStack keeps the failure until then, as `isError` and `error`, which
 * is what a list's own decisions should still go by, so that it does not load more meanwhile.
 *
 * The restart after a rejected cursor starts from an effect (see `useRestartOnRejectedCursor`), so
 * the render that sees the rejection still shows it, for a frame at most, and a screen reader may
 * announce the alert showing it.
 */
export function isRecovering({ isError, isFetching }: Refetched): boolean {
  return isError && isFetching
}
