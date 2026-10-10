import { useQueries } from '@tanstack/react-query'
import { compareStrings } from '../format'
import { api, MAX_PAGE_SIZE, unwrap, type Schemas } from './client'
import type { CursorPage } from './use-cursor-pages'
import { queryKeys } from './keys'

/** The names of every test with a value for `metric` on `machine` (E5), however many pages. */
async function fetchTestNames(
  suite: string,
  machine: string,
  metric: string,
  signal: AbortSignal,
): Promise<string[]> {
  const names: string[] = []
  let cursor: string | null = null
  do {
    const page: CursorPage<Schemas['Test']> = await unwrap(
      api.GET('/api/suites/{testsuite}/tests', {
        params: {
          path: { testsuite: suite },
          query: { machine, metric, cursor, limit: MAX_PAGE_SIZE },
        },
        signal,
      }),
    )
    names.push(...page.items.map((test) => test.name))
    cursor = page.cursor.next
  } while (cursor !== null)
  return names
}

/** What is known of the tests of several machines (see `useTestNames`). */
export interface TestNames {
  /** The names of the tests listed so far, sorted. */
  names: string[]
  /** Whether every machine's tests are listed. */
  complete: boolean
  /** Why some machine's tests could not be listed, if they could not. */
  error: Error | null
  /** List again the tests that could not be. */
  retry(): void
}

/**
 * The names of the tests with a value for `metric` on any of `machines`, sorted by code point: the
 * union of one `GET tests?machine=...&metric=...` per machine, every page of it, each cached on its
 * own, so that adding a machine lists only its own tests. While some are being listed, those
 * already listed are kept.
 */
export function useTestNames(
  suite: string,
  machines: readonly string[],
  metric: string,
): TestNames {
  return useQueries({
    queries: machines.map((machine) => ({
      queryKey: [...queryKeys.tests(suite), { machine, metric }],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchTestNames(suite, machine, metric, signal),
    })),
    combine: combineNames,
  })
}

/**
 * The union of the machines' tests. A function of its own, so that it is only run again when a
 * result changes, and the names are the same array from one render to the next until then.
 */
function combineNames(
  results: { data?: string[]; error: Error | null; refetch: () => unknown }[],
): TestNames {
  const names = new Set(results.flatMap((result) => result.data ?? []))
  const failed = results.filter((result) => result.error !== null)
  return {
    names: [...names].sort(compareStrings),
    complete: results.every((result) => result.data !== undefined),
    error: failed[0]?.error ?? null,
    retry: () => failed.forEach((result) => void result.refetch()),
  }
}
