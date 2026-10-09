import type { ReactNode } from 'react'
import { useSuites, type SuiteSchema } from '../api/suites'
import { Alert, ErrorMessage, Loading } from './feedback'

interface Props {
  /** The suite named by the page's URL. */
  suite: string
  /** The page's content, once it has the suite's schema. */
  children(schema: SuiteSchema): ReactNode
}

/**
 * What a page scoped to one suite shows until it has the suite's schema: that it is loading, that
 * it failed, or that there is no such suite. Then the page itself.
 */
export function WithSchema({ suite, children }: Props) {
  const suites = useSuites()
  if (suites.isPending) return <Loading label="Loading test suites..." />
  if (suites.isError) {
    return <ErrorMessage error={suites.error} onRetry={() => void suites.refetch()} />
  }
  const schema = suites.data.find((entry) => entry.name === suite)
  if (schema === undefined) return <Alert>Test suite '{suite}' not found.</Alert>
  return children(schema)
}
