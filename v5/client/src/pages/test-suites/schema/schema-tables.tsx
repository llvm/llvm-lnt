import type { ReactNode } from 'react'
import type { Suite, SuiteSchema } from '../../../api/suites'
import { DataTable, type Column } from '../../../components/data-table'
import { InfoBox, InfoRow } from '../../../components/info-box'
import { MISSING, yesNo } from '../../../format'
import { projectLabel } from '../../../labels'
import { formatUnit, type Metric } from '../../../schema'
import {
  isUrlKey,
  KEY_HEADERS,
  LIST_INFO,
  REPOSITORY_HEADERS,
  REPOSITORY_KEYS,
  type ListName,
  type RepositoryKey,
} from './schema-lists'
import styles from './schema.module.css'

type CommitField = SuiteSchema['commit_fields'][number]
type MachineField = SuiteSchema['machine_fields'][number]

/**
 * The columns every list starts with. An entry is shown by its name, with its display name apart,
 * `--` when it has none, rather than repeating the name (TS6).
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
  {
    id: 'dashboard',
    header: KEY_HEADERS.dashboard.header,
    cell: (metric) => yesNo(metric.dashboard),
  },
]

const SEARCHABLE_COLUMN: Column<CommitField | MachineField> = {
  id: 'searchable',
  header: KEY_HEADERS.searchable.header,
  cell: (field) => yesNo(field.searchable),
}

const LISTED_COLUMN: Column<CommitField | MachineField> = {
  id: 'listed',
  header: KEY_HEADERS.listed.header,
  cell: (field) => yesNo(field.listed),
}

const COMMIT_FIELD_COLUMNS: Column<CommitField>[] = [
  ...ENTRY_COLUMNS,
  SEARCHABLE_COLUMN,
  { id: 'display', header: KEY_HEADERS.display.header, cell: (field) => yesNo(field.display) },
  LISTED_COLUMN,
]

const MACHINE_FIELD_COLUMNS: Column<MachineField>[] = [
  ...ENTRY_COLUMNS,
  SEARCHABLE_COLUMN,
  LISTED_COLUMN,
]

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

/**
 * A schema's repository, under its heading, in the viewer and the editor alike: each key, as
 * `value` gives it, its URL templates in a fixed-width font.
 */
export function RepositoryBox({ value }: { value(key: RepositoryKey): ReactNode }) {
  return (
    <>
      <h2 className={styles.heading}>Repository</h2>
      <InfoBox label="Repository">
        {REPOSITORY_KEYS.map((key) => (
          <InfoRow key={key} label={REPOSITORY_HEADERS[key]} mono={isUrlKey(key)}>
            {value(key)}
          </InfoRow>
        ))}
      </InfoBox>
    </>
  )
}

/**
 * The suite a schema is of, by its project's label, its name and its display name, `--` when it
 * has none, rather than repeating the name (TS6).
 */
function SuiteBox({ schema }: { schema: Suite }) {
  return (
    <>
      <h2 className={styles.heading}>Suite</h2>
      <InfoBox label="Suite">
        <InfoRow label="Project">{projectLabel(schema.project)}</InfoRow>
        <InfoRow label="Name">{schema.name}</InfoRow>
        <InfoRow label="Display name">{schema.display_name ?? MISSING}</InfoRow>
      </InfoBox>
    </>
  )
}

/**
 * A schema's suite, its three lists, each with exactly the presentation keys it accepts, and its
 * repository, whose templates are text rather than links: they are not URLs until filled in (D4,
 * TS6).
 */
export function SchemaTables({ schema }: { schema: Suite }) {
  return (
    <>
      <SuiteBox schema={schema} />
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
      <RepositoryBox value={(key) => schema.repository[key] ?? MISSING} />
    </>
  )
}
