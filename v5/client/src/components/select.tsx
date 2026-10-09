import {
  Button,
  Label,
  ListBox,
  ListBoxItem,
  Select as AriaSelect,
  SelectValue,
} from 'react-aria-components'
import { Popover } from './popover'
import listStyles from './list-box.module.css'
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
}: Props<Value>) {
  return (
    <AriaSelect
      className={styles.root}
      value={value}
      // A single selection that cannot be cleared: React Aria reports a null only for no selection.
      onChange={(key) => key !== null && onChange(key as Value)}
      isDisabled={isDisabled}
    >
      <Label>{label}</Label>
      <Button className={styles.button}>
        <SelectValue />
        <span aria-hidden="true">▾</span>
      </Button>
      <Popover className={styles.popover} maxHeight={320}>
        <ListBox className={listStyles.list} items={options}>
          {(option) => (
            <ListBoxItem id={option.value} className={listStyles.option}>
              {option.label}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </AriaSelect>
  )
}
