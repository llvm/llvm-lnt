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
 * rows of another page or search in place of the failure (AR2 "Paginated tables").
 */
export function shownData<Data>({
  data,
  isPlaceholderData,
  errorUpdateCount,
}: Placeheld<Data>): Data | undefined {
  return isPlaceholderData && errorUpdateCount > 0 ? undefined : data
}
