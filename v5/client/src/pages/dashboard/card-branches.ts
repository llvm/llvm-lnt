/**
 * The branches the Dashboard's cards show, as the URL keeps them (DA1): one `branch` per card that
 * shows another branch than its default, spelled `{project}/{suite}/{metric}/{branch}`. Names have
 * no `/` (see D4, D7 and I1), whereas a branch may, so the branch is everything after the third.
 */

import { fullName, suiteRef, type SuiteRef } from '../../api/suite-ref'
import type { Param } from '../../url-state'

/** The branch a card shows: that of the card of `suite`'s `metric`. */
export interface CardBranch {
  suite: SuiteRef
  metric: string
  branch: string
}

/** An entry of the URL, or null if malformed. */
function parse(entry: string): CardBranch | null {
  const [project, suite, metric, ...rest] = entry.split('/')
  const branch = rest.join('/')
  if ([project, suite, metric, branch].some((part) => !part)) return null
  return { suite: suiteRef(project, suite), metric, branch }
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
      entries.map(({ suite, metric, branch }) => `${fullName(suite)}/${metric}/${branch}`),
  }
}

/** The branch `entries` name for the card of `suite`'s `metric`, if any. */
export function branchOfCard(
  entries: readonly CardBranch[],
  suite: SuiteRef,
  metric: string,
): string | undefined {
  return entries.find((entry) => isOfCard(entry, suite, metric))?.branch
}

/**
 * `entries`, with the card of `suite`'s `metric` showing `branch`, in place of its entry if it has
 * one, or without its entry if `branch` is undefined, for its default.
 */
export function withBranchOfCard(
  entries: readonly CardBranch[],
  suite: SuiteRef,
  metric: string,
  branch: string | undefined,
): CardBranch[] {
  const entry = branch === undefined ? [] : [{ suite, metric, branch }]
  const index = entries.findIndex((kept) => isOfCard(kept, suite, metric))
  if (index === -1) return [...entries, ...entry]
  return [...entries.slice(0, index), ...entry, ...entries.slice(index + 1)]
}
