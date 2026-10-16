import { useId } from 'react'
import { VisuallyHidden } from 'react-aria-components'
import type { ScopeGate } from '../auth/scope'
import { days, formatInactiveDays, INACTIVITY_HELP, invalidInactiveDays } from '../inactivity'
import { HelpLabel } from './help-label'
import { InfoRow } from './info-box'
import { InlineEdit } from './inline-edit'

/**
 * The info box row of a machine's or a commit's `delete_after_inactive_days`, edited in place
 * (DT1, DT3). Its label explains the setting on hover, and its help describes the Edit button and
 * the input for assistive technology. `note`, if any, follows the value while one is set.
 */
export function InactivityRow({
  value,
  gate,
  note,
  onSave,
}: {
  value: number | null
  gate: ScopeGate
  note?: string
  onSave: (days: number | null) => Promise<unknown>
}) {
  const labelId = useId()
  const helpId = useId()
  return (
    <InfoRow
      label={
        <HelpLabel id={labelId} help={INACTIVITY_HELP}>
          Delete after inactivity
        </HelpLabel>
      }
    >
      <InlineEdit
        label="Delete after inactivity"
        value={days(value)}
        display={(text) =>
          note === undefined ? formatInactiveDays(text) : `${formatInactiveDays(text)} (${note})`
        }
        gate={gate}
        invalid={invalidInactiveDays}
        describedBy={helpId}
        onSave={(text) => onSave(text === null ? null : Number(text))}
      />
      <VisuallyHidden id={helpId}>{INACTIVITY_HELP}</VisuallyHidden>
    </InfoRow>
  )
}
