import { Link } from 'react-router'
import { useResolvedCommit } from '../api/commits'
import type { SuiteSchema } from '../api/suites'
import { commitPath } from '../paths'
import { commitDisplayValue, type Commit } from '../schema'
import { CommitCard } from './commit-card'
import { useHoverCard } from './use-hover-card'

interface Props {
  schema: SuiteSchema
  /** The commit string. */
  value: string
}

/**
 * A link to the page of the commit `value`, shown by its display value (AR6) once it is resolved,
 * and by `value` until then, or if it cannot be, with the commit's card (AR21). Each link resolves
 * its commit on its own, so a list of commits resolves them in one batch instead, and shows them
 * with `ListedCommitLink`.
 */
export function CommitLink({ schema, value }: Props) {
  const commit = useResolvedCommit(schema.name, value)
  // Not resolved yet, or not resolvable: the card asks for it again, with the same query.
  return <ListedCommitLink schema={schema} value={value} commit={commit.data ?? undefined} />
}

interface ListedProps extends Props {
  /** The commit, as the page loaded it, unless it could not, or it was deleted since. */
  commit: Commit | undefined
  /** Whether the display value ends with the commit's tag, as it does unless the page shows it. */
  withTag?: boolean
}

/**
 * A link to the page of the commit `value`, shown by its display value (AR6) as `commit` gives it,
 * and by `value` without it, with the commit's card (AR21): what a list that loaded its commits
 * shows each of them as. Without `commit`, the card fetches the commit once shown.
 */
export function ListedCommitLink({ schema, value, commit, withTag = true }: ListedProps) {
  const card = useHoverCard<HTMLAnchorElement>()
  return (
    <>
      <Link to={commitPath(schema.name, value)} {...card.triggerProps}>
        {commit ? commitDisplayValue(commit, schema, { withTag }) : value}
      </Link>
      {/* Beside the link rather than in it, which a click in the card would otherwise follow. */}
      <CommitCard card={card} schema={schema} value={value} commit={commit} />
    </>
  )
}
