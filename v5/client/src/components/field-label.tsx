import { Label, VisuallyHidden } from 'react-aria-components'

/**
 * The label of a React Aria field, kept for assistive technology only when `hidden`, where the
 * page already says what the field is.
 */
export function FieldLabel({ label, hidden = false }: { label: string; hidden?: boolean }) {
  const element = <Label>{label}</Label>
  return hidden ? <VisuallyHidden>{element}</VisuallyHidden> : element
}
