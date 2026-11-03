import type { Suite } from '../../api/suites'
import type { Column } from '../../components/data-table'
import { LinkableText } from '../../components/linkable-text'
import { formatFieldValue, isNumeric, labelOf, type FieldValue } from '../../schema'

type Field = Suite['commit_fields' | 'machine_fields'][number]

/** How long a field's value may be in a cell before it is cut short (TS3). */
const VALUE_LENGTH = 50

/**
 * A column for each of `fields` the schema marks `listed`, in schema order, headed by its label
 * and showing a row's value for it, cut short when long (TS3, TS4).
 */
export function listedColumns<Row extends { fields: Record<string, FieldValue> }>(
  fields: readonly Field[],
): Column<Row>[] {
  return fields
    .filter((field) => field.listed)
    .map((field) => ({
      id: `field:${field.name}`,
      header: labelOf(field),
      looks: isNumeric(field) ? ['numeric'] : undefined,
      cell: (row) => (
        <LinkableText
          text={formatFieldValue(row.fields[field.name], field.type)}
          max={VALUE_LENGTH}
        />
      ),
    }))
}
