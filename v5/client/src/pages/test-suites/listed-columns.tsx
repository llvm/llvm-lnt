import { VisuallyHidden } from 'react-aria-components'
import type { SuiteSchema } from '../../api/suites'
import type { Column } from '../../components/data-table'
import { truncate } from '../../format'
import { formatFieldValue, isNumeric, labelOf, type FieldValue } from '../../schema'

type Field = SuiteSchema['commit_fields' | 'machine_fields'][number]

/** How long a field's value may be in a cell before it is cut short (TS3). */
const VALUE_LENGTH = 50

/**
 * A column for each of `fields` the schema marks `listed`, in schema order, headed by its label
 * and showing a row's value for it. A long one is cut short, and whole on hover and to assistive
 * technology, which reads it in place of the cut one (TS3, TS4).
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
      cell: (row) => {
        const value = formatFieldValue(row.fields[field.name], field.type)
        const shown = truncate(value, VALUE_LENGTH)
        if (shown === value) return value
        return (
          <>
            <span title={value} aria-hidden="true">
              {shown}
            </span>
            <VisuallyHidden elementType="span">{value}</VisuallyHidden>
          </>
        )
      },
    }))
}
