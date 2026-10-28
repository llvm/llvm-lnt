/**
 * The Compare page's ways to its sides' commits (CP1): each side's ⓘ, with the commit's card
 * (AR21), and the link to the changes between them in the repository (AR20).
 */

import type { SuiteSchema } from '../../api/suites'
import { usePickedCommit, usePickedCommitText } from '../../components/commit-lookup'
import { CommitCardButton } from '../../components/commit-link'
import { InfoIcon } from '../../components/icons'
import { NEW_TAB, rangeUrl, repositoryLinkText } from '../../repository'
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

/**
 * ⓘ, which gives the side's commit card, once the side names a commit, beside its picker's label
 * (CP1). Its name and its card show the commit as the picker knows it (see `usePickedCommit`).
 */
export function SideCommitCard({ side }: { side: Side }) {
  const target = named(side)
  return target && <NamedCommitCard target={target} />
}

function NamedCommitCard({ target }: { target: Named }) {
  const { schema, machine, commit } = target
  const picked = usePickedCommit(schema, { machine }, commit)
  return (
    <CommitCardButton
      schema={schema}
      value={commit}
      commit={picked?.commit}
      // Named after its commit, since each side has one.
      aria-label={`Commit ${picked?.text ?? commit}`}
      className={styles.commitCard}
    >
      <InfoIcon />
    </CommitCardButton>
  )
}

/**
 * "Diff on {label}" from side A's commit to side B's, always in that order, even when B's
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
        {repositoryLinkText(from.schema.repository, 'Diff')}: {shownFrom} → {shownTo}
      </a>
    </p>
  )
}
