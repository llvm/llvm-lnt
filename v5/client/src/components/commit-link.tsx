import { Link } from 'react-router'
import { useResolvedCommit } from '../api/commits'
import type { SuiteSchema } from '../api/suites'
import { commitPath } from '../paths'
import { commitDisplayValue } from '../schema'

/**
 * A link to the page of the commit `value`, shown by its display value (AR2) once it is resolved,
 * and by `value` until then, or if it cannot be. Each link resolves its commit on its own, so a
 * list of commits resolves them in one batch instead (see `withCommits`).
 */
export function CommitLink({ schema, value }: { schema: SuiteSchema; value: string }) {
  const commit = useResolvedCommit(schema.name, value)
  return (
    <Link to={commitPath(schema.name, value)}>
      {commit.data ? commitDisplayValue(commit.data, schema) : value}
    </Link>
  )
}
