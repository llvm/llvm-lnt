import { useId, useRef, type Ref } from 'react'
import clsx from 'clsx'
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
  /**
   * Why the option cannot be picked, if it cannot, such as one the token does not allow (AR17):
   * shown on hover over the whole option, and part of its accessible name. It can still be focused,
   * from the keyboard too, so that the reason can be read, but picking it changes nothing.
   */
  reason?: string
}

interface Props<Value extends string> {
  label: string
  options: readonly Option<Value>[]
  /** One of the options' values, or null while none is picked, which shows `placeholder`. */
  value: Value | null
  /** What the dropdown shows while no option is picked. */
  placeholder?: string
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
  /** The button that opens the list, to focus it from script. */
  ref?: Ref<HTMLButtonElement>
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
  placeholder,
  onChange,
  isDisabled,
  title,
  isPending,
  hideLabel,
  listPicksOnly,
  ref,
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
        placeholder={placeholder}
        // A single selection that cannot be cleared: React Aria reports a null only for no
        // selection.
        onChange={(key) => {
          if (key === null || (!open.current && listPicksOnly)) return
          if (options.find((option) => option.value === key)?.reason === undefined) {
            onChange(key as Value)
          }
        }}
        onOpenChange={(isOpen) => (open.current = isOpen)}
        isDisabled={isDisabled}
      >
        <FieldLabel label={label} hidden={hideLabel} />
        <Button
          ref={ref}
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
              <ListBoxItem
                id={option.value}
                className={clsx(shared.option, option.reason !== undefined && shared.refused)}
                textValue={option.label}
              >
                {option.reason === undefined ? (
                  option.label
                ) : (
                  <span className={shared.refusedText} title={option.reason}>
                    {option.label}
                    <VisuallyHidden elementType="span">: {option.reason}</VisuallyHidden>
                  </span>
                )}
              </ListBoxItem>
            )}
          </ListBox>
        </Popover>
      </AriaSelect>
    </span>
  )
}

/** The most options a `MultiSelect`'s button names; beyond that it counts them. */
const NAMED = 2

interface MultiProps<Value extends string> {
  label: string
  options: readonly Option<Value>[]
  /** The values of the options picked, in any order. */
  value: readonly Value[]
  /** What the button shows while no option is picked. */
  placeholder: string
  /** The values of the options picked, in the order of `options`. */
  onChange(value: NoInfer<Value>[]): void
  isDisabled?: boolean
  /** Keep the label for assistive technology only, where the page already says what it is. */
  hideLabel?: boolean
}

/**
 * A dropdown picking any number of `options`, each with a checkbox, whose list stays open while
 * they are checked and unchecked. Its button names the options picked, or says how many there are
 * when they are too many to name.
 */
export function MultiSelect<Value extends string>({
  label,
  options,
  value,
  placeholder,
  onChange,
  isDisabled,
  hideLabel,
}: MultiProps<Value>) {
  const picked = options.filter((option) => value.includes(option.value))
  let summary = placeholder
  if (picked.length > NAMED) summary = `${picked.length} selected`
  else if (picked.length > 0) summary = picked.map((option) => option.label).join(', ')
  return (
    <AriaSelect
      className={shared.root}
      selectionMode="multiple"
      value={picked.map((option) => option.value)}
      onChange={(keys) =>
        onChange(options.filter((option) => keys.includes(option.value)).map(({ value }) => value))
      }
      isDisabled={isDisabled}
    >
      <FieldLabel label={label} hidden={hideLabel} />
      <Button className={styles.button}>
        <SelectValue>{summary}</SelectValue>
        <span aria-hidden="true">▾</span>
      </Button>
      <Popover className={shared.popover} maxHeight={320}>
        <ListBox className={shared.list} items={options}>
          {(option) => (
            <ListBoxItem id={option.value} textValue={option.label} className={styles.checkOption}>
              {({ isSelected }) => (
                <>
                  {/* Only to show the option as checked: the option itself is what is picked. */}
                  <input
                    type="checkbox"
                    checked={isSelected}
                    readOnly
                    tabIndex={-1}
                    aria-hidden="true"
                  />
                  {option.label}
                </>
              )}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </AriaSelect>
  )
}
