import { Link } from 'react-router'
import type { Schemas } from '../api/client'
import type { MachineLabels } from '../api/machines'
import { refOf, type Suite, type SuiteRef } from '../api/suites'
import { formatTimestamp } from '../format'
import { machinePath, runPath } from '../paths'
import type { Commit } from '../schema'
import { ListedCommitLink } from './commit-link'
import type { Column } from './data-table'
import { uuidColumn } from './uuid-column'

type Run = Schemas['Run']

/**
 * The columns a table of runs picks from, so that every such table shows runs the same way: the
 * run and its commit, each linked to its own page, the commit with its card (AR21), and when it was
 * measured or submitted. `machineColumn` adds the machine.
 * `commits` resolves the commits' display values, and their cards' contents (see `fetchRunPage`).
 */
export function runColumns(schema: Suite, commits: Map<string, Commit>) {
  const suite = refOf(schema)
  return {
    run: uuidColumn<Run>('run', 'Run', (uuid) => runPath(suite, uuid)),
    commit: {
      id: 'commit',
      header: 'Commit',
      cell: (run) => (
        <ListedCommitLink schema={schema} value={run.commit} commit={commits.get(run.commit)} />
      ),
    },
    measured: {
      id: 'measured',
      header: 'Measured',
      looks: ['nowrap'],
      cell: (run) => formatTimestamp(run.measured_at),
    },
    submitted: {
      id: 'submitted',
      header: 'Submitted',
      looks: ['nowrap'],
      cell: (run) => formatTimestamp(run.submitted_at),
    },
  } satisfies Record<string, Column<Run>>
}

/** The column of a table of runs naming each run's machine by its label (AR23), linking to it. */
export function machineColumn(suite: SuiteRef, labelOfMachine: MachineLabels): Column<Run> {
  return {
    id: 'machine',
    header: 'Machine',
    cell: (run) => <Link to={machinePath(suite, run.machine)}>{labelOfMachine(run.machine)}</Link>,
  }
}
