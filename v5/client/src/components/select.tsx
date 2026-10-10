import { useId, useRef } from 'react'
import {
  Button,
  ListBox,
  ListBoxItem,
  Select as AriaSelect,
  SelectValue,
  VisuallyHidden,
} from 'react-aria-components'
import { FieldLabel } from './field-label'
import { Popover } from './popover'
import shared from './dropdown.module.css'
import styles from './select.module.css'

export interface Option<Value extends string> {
  value: Value
  label: string
}

interface Props<Value extends string> {
  label: string
  options: readonly Option<Value>[]
  /** One of the options' values. */
  value: Value
  onChange(value: NoInfer<Value>): void
  isDisabled?: boolean
  /**
   * Why the dropdown is disabled (see `useScopeGate`), shown on hover and given to assistive
   * technology.
   */
  title?: string
  /** A change is under way: the dropdown cannot be opened, but keeps the focus. */
  isPending?: boolean
  /** Keep the label for assistive technology only, where the page already says what it is. */
  hideLabel?: boolean
  /**
   * Change the value only when an option is picked from the open list. Otherwise ArrowLeft,
   * ArrowRight and typing on the closed dropdown step through the options, which a dropdown that
   * saves every change would save one after the other.
   */
  listPicksOnly?: boolean
}

/**
 * A dropdown picking one of `options`. The app uses it rather than a native `<select>`, which the
 * lint configuration rejects: after a native select's list has been opened, Safari sends no
 * `pointerdown` for the next click, and React Aria, which starts a press on it, then misses that
 * click -- a tab, say, would need clicking twice.
 */
export function Select<Value extends string>({
  label,
  options,
  value,
  onChange,
  isDisabled,
  title,
  isPending,
  hideLabel,
  listPicksOnly,
}: Props<Value>) {
  const titleId = useId()
  // Whether the list is open. React Aria reports a pick before it closes the list.
  const open = useRef(false)
  return (
    // On an element of its own, since React Aria does not pass a title on to the button. Always
    // there, so that the dropdown is not mounted again, losing the focus, when the title goes.
    <span className={styles.titled} title={title}>
      <AriaSelect
        className={shared.root}
        value={value}
        // A single selection that cannot be cleared: React Aria reports a null only for no
        // selection.
        onChange={(key) => {
          if (key !== null && (open.current || !listPicksOnly)) onChange(key as Value)
        }}
        onOpenChange={(isOpen) => (open.current = isOpen)}
        isDisabled={isDisabled}
      >
        <FieldLabel label={label} hidden={hideLabel} />
        <Button
          className={styles.button}
          isPending={isPending}
          aria-describedby={title === undefined ? undefined : titleId}
        >
          <SelectValue />
          <span aria-hidden="true">▾</span>
        </Button>
        {title !== undefined && <VisuallyHidden id={titleId}>{title}</VisuallyHidden>}
        <Popover className={shared.popover} maxHeight={320}>
          <ListBox className={shared.list} items={options}>
            {(option) => (
              <ListBoxItem id={option.value} className={shared.option}>
                {option.label}
              </ListBoxItem>
            )}
          </ListBox>
        </Popover>
      </AriaSelect>
    </span>
  )
}
