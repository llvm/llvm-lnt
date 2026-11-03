import { useId, useMemo, useRef, type Ref } from 'react'
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

/** The most options a `TreeSelect`'s button names; beyond that it counts them. */
const NAMED = 2

/** An option of a `TreeSelect`, below an option of its own if it is a child. */
export interface TreeOption<Value extends string> {
  value: Value
  /** What the list shows. Typing on the list matches it. */
  label: string
  /** Its accessible name, where the label alone does not say enough, such as out of context. */
  name?: string
  /** What the button names it as, once it is checked, if not by `name` or `label`. */
  summary?: string
  /** Shown after the label, muted, and part of its accessible name, but not matched by typing. */
  note?: string
}

/** An option of a `TreeSelect` with the options below it, which checking it checks too. */
export interface TreeParent<Value extends string> extends TreeOption<Value> {
  children: readonly TreeOption<Value>[]
  /** Why a child is checked, and cannot be unchecked, while this option is checked. */
  implied: string
}

interface TreeProps<Value extends string> {
  label: string
  options: readonly TreeParent<Value>[]
  /** The values of the options checked, in any order: a parent's, and no child of a checked one. */
  value: readonly Value[]
  /** What the button shows while no option is checked. */
  placeholder: string
  /** The values of the options checked, in the order of `options`. */
  onChange(value: NoInfer<Value>[]): void
  isDisabled?: boolean
  /** Keep the label for assistive technology only, where the page already says what it is. */
  hideLabel?: boolean
}

/** An option of a `TreeSelect` as its list holds it, with its parent if it has one. */
interface Row<Value extends string> extends TreeOption<Value> {
  parent?: TreeParent<Value>
}

/**
 * The options checked, out of the options React Aria has selected, `keys`, when `value` was checked
 * before. A parent selected stands for its children, which are dropped. So are the children of a
 * parent unchecked, which were only shown checked because of it. This depends on the keys alone,
 * not on how they were selected: one click, or a range of options with Shift.
 */
function checkedOf<Value extends string>(
  options: readonly TreeParent<Value>[],
  value: readonly Value[],
  keys: readonly Value[],
): Value[] {
  const selected = new Set(keys)
  const before = new Set(value)
  return options.flatMap((parent) => {
    if (selected.has(parent.value)) return [parent.value]
    if (before.has(parent.value)) return []
    return parent.children.map((child) => child.value).filter((child) => selected.has(child))
  })
}

/**
 * A dropdown checking any number of `options`, each with a checkbox, in a tree two levels deep: the
 * children are indented below their parent. Checking a parent checks its children too, which are
 * shown checked and cannot be unchecked until the parent is, and unchecking it unchecks them. The
 * list stays open while options are checked and unchecked. The button names the options checked,
 * or says how many there are when they are too many to name.
 */
export function TreeSelect<Value extends string>({
  label,
  options,
  value,
  placeholder,
  onChange,
  isDisabled,
  hideLabel,
}: TreeProps<Value>) {
  const checked = new Set(value)
  // Built again only when the options change, so that the list renders its rows again only then,
  // or when what is checked changes (see `dependencies` below).
  const rows = useMemo(
    (): Row<Value>[] =>
      options.flatMap((parent) => [
        parent,
        ...parent.children.map((child) => ({ ...child, parent })),
      ]),
    [options],
  )
  const picked = rows.filter((row) => checked.has(row.value))
  // What the list shows checked, which React Aria then says is selected: the children of a parent
  // checked too.
  const shown = rows.filter(
    (row) => checked.has(row.value) || (row.parent !== undefined && checked.has(row.parent.value)),
  )
  let summary = placeholder
  if (picked.length > NAMED) summary = `${picked.length} selected`
  else if (picked.length > 0) {
    summary = picked.map((row) => row.summary ?? row.name ?? row.label).join(', ')
  }
  return (
    <AriaSelect
      className={shared.root}
      selectionMode="multiple"
      value={shown.map((row) => row.value)}
      onChange={(keys) => onChange(checkedOf(options, value, keys as Value[]))}
      isDisabled={isDisabled}
    >
      <FieldLabel label={label} hidden={hideLabel} />
      <Button className={styles.button}>
        <SelectValue>{summary}</SelectValue>
        <span aria-hidden="true">▾</span>
      </Button>
      <Popover className={shared.popover} maxHeight={320}>
        <ListBox className={shared.list} items={rows} dependencies={[value]}>
          {(row) => {
            const reason =
              row.parent !== undefined && checked.has(row.parent.value)
                ? row.parent.implied
                : undefined
            // Given only where it differs from what the option shows, which names it otherwise.
            const name =
              row.name === undefined
                ? undefined
                : [row.name, row.note].filter(Boolean).join(' ') + (reason ? `: ${reason}` : '')
            return (
              <ListBoxItem
                id={row.value}
                textValue={row.label}
                aria-label={name}
                className={clsx(
                  styles.checkOption,
                  row.parent !== undefined && styles.child,
                  reason !== undefined && shared.refused,
                )}
              >
                {({ isSelected }) => (
                  <span className={styles.checkRow} title={reason}>
                    {/* Only to show the option as checked: the option itself is what is picked. */}
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={reason !== undefined}
                      readOnly
                      tabIndex={-1}
                      aria-hidden="true"
                    />
                    {row.label}
                    {row.note !== undefined && (
                      <>
                        {' '}
                        <span className={styles.note}>{row.note}</span>
                      </>
                    )}
                    {reason !== undefined && (
                      <VisuallyHidden elementType="span">: {reason}</VisuallyHidden>
                    )}
                  </span>
                )}
              </ListBoxItem>
            )
          }}
        </ListBox>
      </Popover>
    </AriaSelect>
  )
}
