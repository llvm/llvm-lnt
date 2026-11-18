/**
 * Picking one of a suite's branches (E3), as the Graph (GR1) and the Dashboard's cards (DA2) do:
 * the branch shown, and the dropdown that picks it.
 */

import type { BranchName } from './api/commits'
import type { Option } from './components/select'

/**
 * The branch shown, given the suite's `branches` and the one `named` (GR1): that one, if the list
 * holds it, and otherwise the list's first entry, which is null, the commits without a branch, if
 * they are listed at all. An empty list, of a suite without commits with an ordinal, leaves nothing
 * to show, which the commits without a branch stand for.
 */
export function plottedBranch(branches: readonly BranchName[], named: BranchName): BranchName {
  return branches.includes(named) ? named : (branches[0] ?? null)
}

/** Whether `branches` holds a named branch, which a branch dropdown is there to pick. */
export function hasNamedBranch(branches: readonly BranchName[]): boolean {
  return branches.some((name) => name !== null)
}

/** A branch dropdown's value for a branch: its name, or empty for the commits without one. */
export const branchKey = (branch: BranchName) => branch ?? ''

/** The branch of a value of a branch dropdown (see `branchKey`). */
export const branchOfKey = (key: string): BranchName => key || null

/** A branch dropdown's options, for `branches` in their order: "No branch" for null. */
export function branchOptions(branches: readonly BranchName[]): Option<string>[] {
  return branches.map((name) => ({ value: branchKey(name), label: name ?? 'No branch' }))
}
