/**
 * The Compare page's ways to its sides' commits (CP1): each side's ⓘ, with the commit's card
 * (AR21), and the link to the changes between them in the repository (AR20).
 */

import type { Suite } from '../../api/suites'
import { usePickedCommit } from '../../components/commit-lookup'
import { CommitCardButton } from '../../components/commit-link'
import { InfoIcon } from '../../components/icons'
import {
  NEW_TAB,
  rangeUrl,
  repositoryLinkText,
  usableTemplate,
  type LinkedCommit,
} from '../../repository'
import type { Side } from './use-side'
import styles from './compare.module.css'

/** A side that has a commit, in a suite known to exist. */
interface Named {
  schema: Suite
  machine: string
  commit: string
}

/** `side`'s suite, machine and commit, if it has a commit, in a suite known to exist. */
function named({ schema, settings }: Side): Named | null {
  const { machine, commit } = settings
  return schema === undefined || commit === '' ? null : { schema, machine, commit }
}

/**
 * The side's commit as its picker knows it, whose filters are its machine (see `SideFields`): by its
 * display value, and with its values for its fields, once the picker has looked it up, and by its
 * commit string, and with no values, until then, so that a template naming fields waits (CP6).
 */
function useShownCommit({ schema, machine, commit }: Named) {
  const picked = usePickedCommit(schema, { machine }, commit)
  const linked: LinkedCommit = picked?.commit ?? { value: commit, fields: {} }
  return { text: picked?.text ?? commit, linked }
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
 * template of a range's URL that they can fill in.
 */
export function RangeLink({ a, b }: { a: Side; b: Side }) {
  const from = named(a)
  const to = named(b)
  if (from === null || to === null || a.settings.suite !== b.settings.suite) return null
  if (usableTemplate(from.schema, 'range_url') === null) return null
  return <NamedRangeLink from={from} to={to} />
}

function NamedRangeLink({ from, to }: { from: Named; to: Named }) {
  const shownFrom = useShownCommit(from)
  const shownTo = useShownCommit(to)
  const url = rangeUrl(from.schema, shownFrom.linked, shownTo.linked)
  return (
    url && (
      <p className={styles.range}>
        <a href={url} {...NEW_TAB}>
          {repositoryLinkText(from.schema.repository, 'Diff')}: {shownFrom.text} → {shownTo.text}
        </a>
      </p>
    )
  )
}
