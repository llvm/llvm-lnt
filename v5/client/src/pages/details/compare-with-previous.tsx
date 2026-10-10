import type { ReactNode } from 'react'
import { errorMessage } from '../../api/client'
import { usePreviousCommit, type PreviousCommit } from '../../api/commits'
import type { SuiteSchema } from '../../api/suites'
import { ButtonLink } from '../../components/button-link'
import { comparePath } from '../../paths'
import { commitDisplayValue } from '../../schema'

interface Props {
  schema: SuiteSchema
  /** The run to compare, alone on side B, with its machine and its commit. */
  run: { uuid: string; machine: string; commit: string }
  /** The metric to compare. */
  metric: string | undefined
  children: ReactNode
}

/**
 * A link to the Compare page comparing `run` with every run of its machine at the commit before
 * (DT2 "Compare with previous commit"), disabled, saying why, while there is no such commit.
 */
export function CompareWithPrevious({ schema, run, metric, children }: Props) {
  const suite = schema.name
  const previous = usePreviousCommit(suite, run.commit, run.machine)
  const to =
    previous.state === 'found'
      ? comparePath(
          { suite, machine: run.machine, commit: previous.commit.value },
          { suite, machine: run.machine, commit: run.commit, runs: [run.uuid] },
          metric,
        )
      : null
  return (
    <ButtonLink to={to} title={title(previous, run.machine, schema)}>
      {children}
    </ButtonLink>
  )
}

/** Which commit the link compares with, or why it compares with none. */
function title(previous: PreviousCommit, machine: string, schema: SuiteSchema): string {
  switch (previous.state) {
    case 'pending':
      return 'Looking up the previous commit...'
    case 'failed':
      return `The previous commit could not be looked up: ${errorMessage(previous.error)}`
    case 'unordered':
      return 'This commit has no ordinal.'
    case 'none':
      return `${machine} has no runs at an earlier commit.`
    case 'found':
      return `Compare with ${commitDisplayValue(previous.commit, schema)}`
  }
}
