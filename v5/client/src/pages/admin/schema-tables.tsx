import type { SuiteSchema } from '../../api/suites'
import { DataTable, type Column } from '../../components/data-table'
import { MISSING, yesNo } from '../../format'
import { formatUnit, type Metric } from '../../schema'
import { KEY_HEADERS, LIST_INFO, type ListName } from './schema-lists'
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
  {
    id: 'display-name',
    header: KEY_HEADERS.display_name.header,
    cell: (entry) => entry.display_name ?? MISSING,
  },
]

const METRIC_COLUMNS: Column<Metric>[] = [
  ...ENTRY_COLUMNS,
  { id: 'unit', header: KEY_HEADERS.unit.header, cell: (metric) => formatUnit(metric) ?? MISSING },
  {
    id: 'bigger-is-better',
    header: KEY_HEADERS.bigger_is_better.header,
    cell: (metric) => yesNo(metric.bigger_is_better),
  },
]

const SEARCHABLE_COLUMN: Column<CommitField | MachineField> = {
  id: 'searchable',
  header: KEY_HEADERS.searchable.header,
  cell: (field) => yesNo(field.searchable),
}

const COMMIT_FIELD_COLUMNS: Column<CommitField>[] = [
  ...ENTRY_COLUMNS,
  SEARCHABLE_COLUMN,
  { id: 'display', header: KEY_HEADERS.display.header, cell: (field) => yesNo(field.display) },
]

const MACHINE_FIELD_COLUMNS: Column<MachineField>[] = [...ENTRY_COLUMNS, SEARCHABLE_COLUMN]

const nameOf = (entry: { name: string }) => entry.name

/** One list of a schema, under its heading, in the viewer and the editor alike. */
export function SchemaList<Entry>(props: {
  list: ListName
  columns: Column<Entry>[]
  rows: Entry[]
  rowKey(entry: Entry): string
}) {
  const { heading, label, noun } = LIST_INFO[props.list]
  return (
    <>
      <h2 className={styles.heading}>{heading}</h2>
      <DataTable
        label={label}
        columns={props.columns}
        rows={props.rows}
        rowKey={props.rowKey}
        empty={`No ${noun}s.`}
      />
    </>
  )
}

/** A schema's three lists, each with exactly the presentation keys it accepts (D4, AD2). */
export function SchemaTables({ schema }: { schema: SuiteSchema }) {
  return (
    <>
      <SchemaList
        list="metrics"
        columns={METRIC_COLUMNS}
        rows={schema.metrics}
        rowKey={nameOf}
      />
      <SchemaList
        list="commit_fields"
        columns={COMMIT_FIELD_COLUMNS}
        rows={schema.commit_fields}
        rowKey={nameOf}
      />
      <SchemaList
        list="machine_fields"
        columns={MACHINE_FIELD_COLUMNS}
        rows={schema.machine_fields}
        rowKey={nameOf}
      />
    </>
  )
}
