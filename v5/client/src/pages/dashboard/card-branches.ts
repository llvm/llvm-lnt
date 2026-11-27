/**
 * The branches the Dashboard's cards show, as the URL keeps them (DA1): one `branch` per card that
 * shows another branch than its default, spelled `{project}/{suite}/{metric}/{branch}`. Names have
 * no `/` (see D4, D7 and I1), whereas a branch may, so the branch is everything after the third. It
 * is empty for the commits without a branch, since a branch name never is (see E3).
 */

import type { BranchName } from '../../api/commits'
import { fullName, suiteRef, type SuiteRef } from '../../api/suite-ref'
import { branchKey, branchOfKey } from '../../branches'
import type { Param } from '../../url-state'

/** The branch a card shows: that of the card of `suite`'s `metric`. */
export interface CardBranch {
  suite: SuiteRef
  metric: string
  branch: BranchName
}

/** An entry of the URL, or null if malformed. */
function parse(entry: string): CardBranch | null {
  const [project, suite, metric, ...rest] = entry.split('/')
  if (rest.length === 0 || [project, suite, metric].some((part) => !part)) return null
  return { suite: suiteRef(project, suite), metric, branch: branchOfKey(rest.join('/')) }
}

/** Whether `entry` is the branch of the card of `suite`'s `metric`. */
function isOfCard(entry: CardBranch, suite: SuiteRef, metric: string): boolean {
  return entry.suite === suite && entry.metric === metric
}

/**
 * The entries, repeated once per card (DA1): a malformed one is dropped, and of a card named twice,
 * only the first is kept.
 */
export function cardBranchParam(): Param<CardBranch[]> {
  return {
    default: [],
    parse: (values) => {
      const entries: CardBranch[] = []
      for (const entry of values.map(parse)) {
        if (entry && !entries.some((kept) => isOfCard(kept, entry.suite, entry.metric))) {
          entries.push(entry)
        }
      }
      return entries
    },
    serialize: (entries) =>
      entries.map(
        ({ suite, metric, branch }) => `${fullName(suite)}/${metric}/${branchKey(branch)}`,
      ),
  }
}

/** The branch `entries` name for the card of `suite`'s `metric`, or undefined if they name none. */
export function branchOfCard(
  entries: readonly CardBranch[],
  suite: SuiteRef,
  metric: string,
): BranchName | undefined {
  return entries.find((entry) => isOfCard(entry, suite, metric))?.branch
}

/** `entries`, with the card of `suite`'s `metric` showing `branch`, in place of its entry if any. */
export function withBranchOfCard(
  entries: readonly CardBranch[],
  suite: SuiteRef,
  metric: string,
  branch: BranchName,
): CardBranch[] {
  const entry = { suite, metric, branch }
  const index = entries.findIndex((kept) => isOfCard(kept, suite, metric))
  if (index === -1) return [...entries, entry]
  return [...entries.slice(0, index), entry, ...entries.slice(index + 1)]
}
