import type { SuiteSchema } from '../../api/suites'
import { DataTable, type Column } from '../../components/data-table'
import { MISSING, yesNo } from '../../format'
import { formatUnit, type Metric } from '../../schema'
import styles from './admin.module.css'

type CommitField = SuiteSchema['commit_fields'][number]
type MachineField = SuiteSchema['machine_fields'][number]

/**
 * The columns every list starts with. An entry is shown by its name, with its display name apart,
 * `--` when it has none, rather than repeating the name (AD2).
 */
const ENTRY_COLUMNS: Column<Metric | CommitField | MachineField>[] = [
  { id: 'name', header: 'Name', looks: ['nowrap'], cell: (entry) => entry.name },
  { id: 'type', header: 'Type', cell: (entry) => entry.type },
  { id: 'display-name', header: 'Display Name', cell: (entry) => entry.display_name ?? MISSING },
]

const METRIC_COLUMNS: Column<Metric>[] = [
  ...ENTRY_COLUMNS,
  { id: 'unit', header: 'Unit', cell: (metric) => formatUnit(metric) ?? MISSING },
  {
    id: 'bigger-is-better',
    header: 'Bigger is Better',
    cell: (metric) => yesNo(metric.bigger_is_better),
  },
]

const COMMIT_FIELD_COLUMNS: Column<CommitField>[] = [
  ...ENTRY_COLUMNS,
  { id: 'searchable', header: 'Searchable', cell: (field) => yesNo(field.searchable) },
  { id: 'display', header: 'Display', cell: (field) => yesNo(field.display) },
]

const MACHINE_FIELD_COLUMNS: Column<MachineField>[] = [
  ...ENTRY_COLUMNS,
  { id: 'searchable', header: 'Searchable', cell: (field) => yesNo(field.searchable) },
]

const nameOf = (entry: { name: string }) => entry.name

/** A schema's three lists, each with exactly the presentation keys it accepts (D4, AD2). */
export function SchemaTables({ schema }: { schema: SuiteSchema }) {
  return (
    <>
      <h2 className={styles.heading}>Metrics</h2>
      <DataTable
        label="Metrics"
        columns={METRIC_COLUMNS}
        rows={schema.metrics}
        rowKey={nameOf}
        empty="No metrics."
      />
      <h2 className={styles.heading}>Commit Fields</h2>
      <DataTable
        label="Commit fields"
        columns={COMMIT_FIELD_COLUMNS}
        rows={schema.commit_fields}
        rowKey={nameOf}
        empty="No commit fields."
      />
      <h2 className={styles.heading}>Machine Fields</h2>
      <DataTable
        label="Machine fields"
        columns={MACHINE_FIELD_COLUMNS}
        rows={schema.machine_fields}
        rowKey={nameOf}
        empty="No machine fields."
      />
    </>
  )
}
