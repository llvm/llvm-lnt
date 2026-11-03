import { useContext, useEffect, useId, useMemo, useRef, type Ref } from 'react'
import clsx from 'clsx'
import type { DisabledBehavior } from '@react-types/shared'
import {
  Button,
  Collection,
  Header,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  Select as AriaSelect,
  SelectStateContext,
  SelectValue,
  VisuallyHidden,
} from 'react-aria-components'
import { FieldLabel } from './field-label'
import { Popover } from './popover'
import { sectioned } from './sectioned'
import shared from './dropdown.module.css'
import styles from './select.module.css'

export interface Option<Value extends string> {
  value: Value
  label: string
  /**
   * Why the option cannot be picked, if it cannot, such as one the token does not allow (AR17):
   * shown on hover over the whole option, and part of its accessible name. It can still be focused
   * in the open list, from the keyboard too, so that the reason can be read, but picking it changes
   * nothing. Stepping through the options of the closed dropdown skips it.
   */
  reason?: string
  /**
   * The group the option is listed under, if it is in one: its heading, which is not an option, and
   * what tells it apart from another group with the same heading. The options in no group come
   * first, then each group, in the order the options give them, as a combobox lists its groups
   * (AR14). Groups and options share one space of ids, where a group's starts with `/section/`, so
   * an option in a dropdown with groups must not have a value starting with it. A suite's, its full
   * name `project/suite`, starts with a project name, which is never empty (D7).
   */
  section?: { key: string; heading: string }
  /**
   * What the closed dropdown shows once the option is picked, if not its label: a suite's full label,
   * say, where its project's heading is not shown beside it (AR22).
   */
  selectedLabel?: string
}

/**
 * Forgets the option last focused in the list once the list closes, if it is refused: typing on the
 * closed dropdown looks from there first, and would find it again and again rather than an option
 * beyond it.
 */
function ForgetRefusedFocus({ refused }: { refused: ReadonlySet<string> }) {
  // Null while React Aria renders the children before it has its state.
  const state = useContext(SelectStateContext)
  const isOpen = state?.isOpen
  const manager = state?.selectionManager
  useEffect(() => {
    if (isOpen || !manager) return
    const key = manager.focusedKey
    if (key != null && refused.has(String(key))) manager.setFocusedKey(null)
  }, [isOpen, manager, refused])
  return null
}

/** An option as the list shows it. */
function optionItem<Value extends string>(option: Option<Value>) {
  return (
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
  )
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
  const { unsectioned, sections } = useMemo(
    () => sectioned(options, (option) => option.section?.key),
    [options],
  )
  const refused = useMemo(
    () =>
      new Set<string>(
        options.filter((option) => option.reason !== undefined).map((option) => option.value),
      ),
    [options],
  )
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
          // A backstop: the closed dropdown sets the value directly, without the checks of a pick
          // from the list, and skips refused options only through `disabledKeys` below.
          if (!refused.has(key as string)) onChange(key as Value)
        }}
        onOpenChange={(isOpen) => (open.current = isOpen)}
        isDisabled={isDisabled}
        // Refused options are disabled for selection only, so that the open list can still focus
        // them. Stepping through the options of the closed dropdown skips them all the same: React
        // Aria steps there without regard to `disabledBehavior`, skipping any disabled option.
        // React Aria Components passes `disabledBehavior` on to React Stately without declaring it.
        disabledKeys={refused}
        {...({ disabledBehavior: 'selection' } satisfies { disabledBehavior: DisabledBehavior })}
      >
        <ForgetRefusedFocus refused={refused} />
        <FieldLabel label={label} hidden={hideLabel} />
        <Button
          ref={ref}
          className={styles.button}
          isPending={isPending}
          aria-describedby={title === undefined ? undefined : titleId}
        >
          {/* An option picked under a heading shows what names it without the heading. */}
          <SelectValue<Option<Value>>>
            {({ selectedItems, defaultChildren }) =>
              selectedItems[0]?.selectedLabel ?? defaultChildren
            }
          </SelectValue>
          <span aria-hidden="true">▾</span>
        </Button>
        {title !== undefined && <VisuallyHidden id={titleId}>{title}</VisuallyHidden>}
        <Popover className={shared.popover} maxHeight={320}>
          <ListBox className={shared.list}>
            <Collection items={unsectioned}>{optionItem}</Collection>
            {/* A group's id starts with `/section/` (see `Option.section`). */}
            {sections.map(([key, grouped]) => (
              <ListBoxSection key={`/section/${key}`} id={`/section/${key}`}>
                <Header className={shared.sectionHeader}>{grouped[0].section!.heading}</Header>
                <Collection items={grouped}>{optionItem}</Collection>
              </ListBoxSection>
            ))}
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

/** An option of a `TreeSelect` with the options below it, which checking it covers. */
export interface TreeParent<Value extends string> extends TreeOption<Value> {
  children: readonly TreeOption<Value>[]
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
 * The options checked, out of the options React Aria has selected, `keys`. A parent selected stands
 * for its children, which are dropped. The children of a parent checked cannot be selected.
 */
function checkedOf<Value extends string>(
  options: readonly TreeParent<Value>[],
  keys: readonly Value[],
): Value[] {
  const selected = new Set(keys)
  return options.flatMap((parent) => {
    if (selected.has(parent.value)) return [parent.value]
    return parent.children.map((child) => child.value).filter((child) => selected.has(child))
  })
}

/**
 * A dropdown checking any number of `options`, each with a checkbox, in a tree two levels deep: the
 * children are indented below their parent. Checking a parent covers its children: they are then
 * listed as covered, without a checkbox, and cannot be focused or checked, and those checked are
 * unchecked. Unchecking the parent lists them again, unchecked. The list stays open while options
 * are checked and unchecked. The button names the options checked, or says how many there are when
 * they are too many to name.
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
  let summary = placeholder
  if (picked.length > NAMED) summary = `${picked.length} selected`
  else if (picked.length > 0) {
    summary = picked.map((row) => row.summary ?? row.name ?? row.label).join(', ')
  }
  return (
    <AriaSelect
      className={shared.root}
      selectionMode="multiple"
      value={picked.map((row) => row.value)}
      onChange={(keys) => onChange(checkedOf(options, keys as Value[]))}
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
            const { parent, note } = row
            const covered = parent !== undefined && checked.has(parent.value)
            // Given only where it differs from what the option shows, which names it otherwise.
            let name: string | undefined
            if (covered) name = `${row.name ?? row.label}, covered by ${parent.label}`
            else if (row.name !== undefined) name = [row.name, note].filter(Boolean).join(' ')
            return (
              <ListBoxItem
                id={row.value}
                textValue={row.label}
                aria-label={name}
                isDisabled={covered}
                className={clsx(styles.checkOption, parent !== undefined && styles.child)}
              >
                {({ isSelected }) => (
                  <span className={styles.checkRow}>
                    {/* Only to show the option as checked: the option itself is what is picked. A
                        covered option keeps its room, to stay in line with the others. */}
                    <input
                      type="checkbox"
                      checked={isSelected}
                      readOnly
                      tabIndex={-1}
                      aria-hidden="true"
                    />
                    {row.label}
                    {note !== undefined && (
                      <>
                        {' '}
                        <span className={styles.note}>{note}</span>
                      </>
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
