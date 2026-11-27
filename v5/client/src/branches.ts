/**
 * Picking one of a suite's branches (AR25), as the Graph (GR1) and the Dashboard's cards (DA2) do:
 * the branch shown, and the dropdown that picks it.
 */

import type { BranchName } from './api/commits'
import type { Option } from './components/select'

/**
 * The suite's default branch (AR25), given its `branches` and its schema's `default_branch`,
 * `named`: that one, if the list holds it, and otherwise the list's first entry, which is null, the
 * commits without a branch, if they are listed at all. An empty list, of a suite without commits
 * with an ordinal, leaves nothing to show, which the commits without a branch stand for.
 */
export function defaultBranch(branches: readonly BranchName[], named: string | null): BranchName {
  return shownBranch(branches, named ?? undefined, branches[0] ?? null)
}

/**
 * The branch shown, given the suite's `branches`, its default branch `fallback`, and the branch
 * asked for, `named`, if any: that one, if the list holds it, and otherwise the default.
 */
export function shownBranch(
  branches: readonly BranchName[],
  named: BranchName | undefined,
  fallback: BranchName,
): BranchName {
  return named !== undefined && branches.includes(named) ? named : fallback
}

/** Whether `branches` holds a named branch, which a branch dropdown is there to pick. */
export function hasNamedBranch(branches: readonly BranchName[]): boolean {
  return branches.some((name) => name !== null)
}

/** A branch dropdown's value for a branch: its name, or empty for the commits without one. */
export const branchKey = (branch: BranchName) => branch ?? ''

/** The branch of a value of a branch dropdown (see `branchKey`). */
export const branchOfKey = (key: string): BranchName => key || null

/** How a branch dropdown names a branch: "No branch" for null. */
export const branchOptionLabel = (branch: BranchName) => branch ?? 'No branch'

/**
 * A branch dropdown's options, for `branches` in their order: "No branch" for null. The schema's
 * `default_branch`, `named`, is marked as the default, if the list holds it (AR25).
 */
export function branchOptions(
  branches: readonly BranchName[],
  named: string | null,
): Option<string>[] {
  return branches.map((name) => ({
    value: branchKey(name),
    label: branchOptionLabel(name),
    ...(name !== null && name === named && { note: 'default' }),
  }))
}
