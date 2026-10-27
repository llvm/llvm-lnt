/** The Compare page's links into the repository its sides' commits come from (CP1, AR20). */

import type { SuiteSchema } from '../../api/suites'
import { usePickedCommitText } from '../../components/commit-lookup'
import { CommitRepositoryLink } from '../../components/repository-link'
import { NEW_TAB, rangeLinkText, rangeUrl } from '../../repository'
import type { Side } from './use-side'
import styles from './compare.module.css'

/** A side that has a commit, in a suite known to exist. */
interface Named {
  schema: SuiteSchema
  machine: string
  commit: string
}

/** `side`'s suite, machine and commit, if it has a commit, in a suite known to exist. */
function named({ schema, settings }: Side): Named | null {
  const { machine, commit } = settings
  return schema === undefined || commit === '' ? null : { schema, machine, commit }
}

/** The side's commit as its picker shows it, whose filters are its machine (see `SideFields`). */
function useShownCommit({ schema, machine, commit }: Named): string {
  return usePickedCommitText(schema, { machine }, commit)
}

/** "View on {label}" for the side's commit, once it has one, beside its picker's label (CP1). */
export function SideCommitLink({ side }: { side: Side }) {
  const target = named(side)
  return target && <NamedCommitLink target={target} />
}

function NamedCommitLink({ target }: { target: Named }) {
  // Named after its commit, since each side has such a link.
  const shown = useShownCommit(target)
  return (
    <CommitRepositoryLink
      repository={target.schema.repository}
      commit={target.commit}
      name={shown}
    />
  )
}

/**
 * "View changes on {label}" from side A's commit to side B's, always in that order, even when B's
 * is the older, below the sides (CP1): while both have a commit in the same suite, which has a
 * template of a range's URL.
 */
export function RangeLink({ a, b }: { a: Side; b: Side }) {
  const from = named(a)
  const to = named(b)
  if (from === null || to === null || a.settings.suite !== b.settings.suite) return null
  const url = rangeUrl(from.schema.repository, from.commit, to.commit)
  return url && <NamedRangeLink from={from} to={to} url={url} />
}

function NamedRangeLink({ from, to, url }: { from: Named; to: Named; url: string }) {
  const shownFrom = useShownCommit(from)
  const shownTo = useShownCommit(to)
  return (
    <p className={styles.range}>
      <a href={url} {...NEW_TAB}>
        {rangeLinkText(from.schema.repository)}: {shownFrom} → {shownTo}
      </a>
    </p>
  )
}
