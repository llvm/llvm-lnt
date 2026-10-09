import { Link } from 'react-router'
import type { Schemas } from '../api/client'
import type { SuiteSchema } from '../api/suites'
import { formatTimestamp } from '../format'
import { commitPath, machinePath, runPath } from '../paths'
import { displayValueOf, type Commit } from '../schema'
import type { Column } from './data-table'
import { uuidColumn } from './uuid-column'

type Run = Schemas['Run']

/**
 * The columns a table of runs picks from, so that every such table shows runs the same way: the
 * run, its machine and its commit, each linked to its own page, and when it was submitted.
 * `commits` resolves the commits' display values (see `fetchRunPage`).
 */
export function runColumns(schema: SuiteSchema, commits: Map<string, Commit>) {
  const suite = schema.name
  return {
    run: uuidColumn<Run>('run', 'Run', (uuid) => runPath(suite, uuid)),
    machine: {
      id: 'machine',
      header: 'Machine',
      cell: (run) => <Link to={machinePath(suite, run.machine)}>{run.machine}</Link>,
    },
    commit: {
      id: 'commit',
      header: 'Commit',
      cell: (run) => (
        <Link to={commitPath(suite, run.commit)}>
          {displayValueOf(run.commit, commits, schema)}
        </Link>
      ),
    },
    submitted: {
      id: 'submitted',
      header: 'Submitted',
      looks: ['nowrap'],
      cell: (run) => formatTimestamp(run.submitted_at),
    },
  } satisfies Record<string, Column<Run>>
}
