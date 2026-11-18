import { Label, VisuallyHidden } from 'react-aria-components'
import styles from './help-label.module.css'

/**
 * The label of a React Aria field, kept for assistive technology only when `hidden`, where the
 * page already says what the field is. With `help`, it explains the field on hover, looking as a
 * `HelpLabel` does: the caller also gives the field that explanation as its description.
 */
export function FieldLabel({
  label,
  hidden = false,
  help,
}: {
  label: string
  hidden?: boolean
  help?: string
}) {
  const element = (
    <Label className={help === undefined ? undefined : styles.label} title={help}>
      {label}
    </Label>
  )
  return hidden ? <VisuallyHidden>{element}</VisuallyHidden> : element
}
