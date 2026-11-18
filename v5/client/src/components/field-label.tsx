import { Label, VisuallyHidden } from 'react-aria-components'
import help from './help-label.module.css'

/**
 * The label of a React Aria field, kept for assistive technology only when `hidden`, where the
 * page already says what the field is. With `title`, it explains the field on hover, looking as a
 * `HelpLabel` does: the caller also gives the field that explanation as its description.
 */
export function FieldLabel({
  label,
  hidden = false,
  title,
}: {
  label: string
  hidden?: boolean
  title?: string
}) {
  const element = (
    <Label className={title === undefined ? undefined : help.label} title={title}>
      {label}
    </Label>
  )
  return hidden ? <VisuallyHidden>{element}</VisuallyHidden> : element
}
