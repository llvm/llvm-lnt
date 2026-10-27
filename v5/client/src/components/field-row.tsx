import type { ReactNode } from 'react'
import type { Schemas } from '../api/client'
import type { ScopeGate } from '../auth/scope'
import { FIELD_EDITING, type StoredValue } from '../fields'
import { formatFieldValue, labelOf, type FieldValue } from '../schema'
import { InfoRow } from './info-box'
import { InlineEdit } from './inline-edit'
import { LinkableText } from './linkable-text'

interface Props {
  /** The machine or commit field (D4). */
  field: { name: string; display_name: string | null; type: Schemas['AttributeType'] }
  /** The entity's value for it, as the API gave it. */
  value: FieldValue
  gate: ScopeGate
  /** What the row is labelled with, if not the field's label (AR6) alone. */
  label?: ReactNode
  /** Save `value`, or clear the field (null). */
  onSave(value: StoredValue | null): Promise<unknown>
}

/**
 * The info box row of a machine's or a commit's field, edited in place with the input its type
 * calls for (DT1).
 */
export function FieldRow({ field, value, gate, label, onSave }: Props) {
  const editing = FIELD_EDITING[field.type]
  return (
    <InfoRow label={label ?? labelOf(field)}>
      <InlineEdit
        label={labelOf(field)}
        value={value === null || value === undefined ? null : editing.text(value)}
        // The value as shown everywhere else, rather than the text it is edited as.
        display={() => <LinkableText text={formatFieldValue(value, field.type)} />}
        gate={gate}
        invalid={editing.invalid}
        multiline={editing.multiline}
        placeholder={editing.placeholder}
        size={editing.size}
        onSave={(text) => onSave(text === null ? null : editing.parse(text))}
      />
    </InfoRow>
  )
}
