import {
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react'
import { Button, ComboBox, ComboBoxStateContext, Input, type Key } from 'react-aria-components'
import { List } from './combobox'
import { FieldLabel } from './field-label'
import { NAVIGATION_KEYS } from './navigation-keys'
import { Popover } from './popover'
import { NO_SUGGESTIONS, type Suggestion, type Suggestions } from './suggestions'
import shared from './dropdown.module.css'
import styles from './combobox.module.css'

interface Props {
  /** The input's name, for assistive technology only: the page says what it is. */
  label: string
  text: string
  onChange: (text: string) => void
  /**
   * What to suggest, undefined while it loads. Few enough to be filtered at once as the user types,
   * unlike `Combobox`'s: no list ever shows suggestions for earlier text.
   */
  suggestions: readonly Suggestion[] | undefined
  maxLength?: number
  /** The id of what describes the input, such as a note about its text. */
  describedBy?: string
  /** Shown as it is, but cannot be changed, and keeps the focus. */
  isReadOnly?: boolean
  inputRef?: Ref<HTMLInputElement>
}

/** The suggestions in `all` that contain `query`, whatever its case (AR9): all of them for none. */
function matching(all: readonly Suggestion[], query: string): readonly Suggestion[] {
  const lowered = query.toLowerCase()
  return lowered === '' ? all : all.filter((item) => item.text.toLowerCase().includes(lowered))
}

/**
 * The input of a field edited in place (AR12) that takes any text, and suggests values for it
 * (AR14): its text is its value. Typing filters the suggestions, and opening the list from its
 * button or with ArrowDown lists them all. A pick replaces the text, and saves nothing. Enter picks
 * only a suggestion highlighted from the keyboard, and otherwise goes on to the form holding the
 * input, which it saves. Tab never picks.
 */
export function TextCombobox({
  label,
  text,
  onChange,
  suggestions: all,
  maxLength,
  describedBy,
  isReadOnly,
  inputRef,
}: Props) {
  // The text the suggestions are filtered by: none, to list them all, while the input holds the
  // text it opened with, the suggestion last picked, or the text it held when the user opened the
  // list from its button or with ArrowDown.
  const whole = useRef(text)
  const [query, setQuery] = useState('')
  const queryOf = (next: string) => (next === whole.current ? '' : next.trim())
  const listAll = (shown: string) => {
    whole.current = shown
    setQuery('')
  }

  const items = useMemo(() => (all ? matching(all, query) : []), [all, query])
  const suggestions: Suggestions = useMemo(
    () => ({ ...NO_SUGGESTIONS, items, isLoading: all === undefined }),
    [items, all],
  )

  // How to close the list from outside it, which `Field` provides.
  const closeListRef = useRef(() => {})
  // The selection stays empty, and controlled, so that React Aria never puts any text back (on
  // Escape or on blur, say), a pick's or none, nor closes the list on a pick on its own.
  const onPick = (key: Key | null) => {
    const picked = items.find((item) => item.key === key)
    if (picked === undefined) return
    listAll(picked.text)
    onChange(picked.text)
    closeListRef.current()
  }

  return (
    <ComboBox
      className={shared.root}
      value={null}
      onChange={onPick}
      inputValue={text}
      onInputChange={(next) => {
        onChange(next)
        setQuery(queryOf(next))
      }}
      onOpenChange={(open, trigger) => {
        // From the button or with ArrowDown, rather than by typing.
        if (open && trigger === 'manual') listAll(text)
      }}
      // Controlled items, which React Aria does not filter: they are.
      items={items}
      // Closed by `Field` when nothing matches, rather than by React Aria, whose collection lags a
      // render behind the suggestions, and would close the list as they arrive.
      allowsEmptyCollection
      // Opened by `Field`, as `Combobox`'s is.
      menuTrigger="manual"
      isReadOnly={isReadOnly}
    >
      <FieldLabel label={label} hidden />
      <Field
        closeListRef={closeListRef}
        // Whether typing `next` would leave something to show.
        shows={(next) => all === undefined || matching(all, queryOf(next)).length > 0}
        nothingToShow={all !== undefined && items.length === 0}
        list={<List suggestions={suggestions} />}
      >
        <Input
          ref={inputRef}
          className={styles.input}
          maxLength={maxLength}
          aria-describedby={describedBy}
          spellCheck={false}
        />
      </Field>
    </ComboBox>
  )
}

/** The key of the suggestion that `target` is part of, if any. */
function keyOf(target: EventTarget): string | null {
  return (target as Element).closest?.('[role="option"]')?.getAttribute('data-key') ?? null
}

/**
 * The input, its button and its list. The list opens when the user types text that leaves
 * something to show, as well as on ArrowDown and from the button, as React Aria opens it, and it
 * closes while nothing matches the text.
 *
 * React Aria handles Enter only to pick a suggestion the user highlighted from the keyboard. Any
 * other Enter closes the list and goes on to the form, unlike React Aria, which would pick the
 * suggestion under the pointer, and keep the form from seeing it while the list is open. Tab never
 * reaches React Aria, which would pick the suggestion highlighted.
 */
function Field({
  closeListRef,
  shows,
  nothingToShow,
  list,
  children,
}: {
  closeListRef: RefObject<() => void>
  shows: (next: string) => boolean
  /** Whether no suggestion matches the text, and none is on its way: no list says so. */
  nothingToShow: boolean
  list: ReactNode
  children: ReactNode
}) {
  // Null in the render React Aria makes of its items alone, which handles no event, but runs the
  // effect below. That render must still hold the list, which React Aria looks for in it.
  const state = useContext(ComboBoxStateContext)
  // Before the page is painted, so that the list never shows that nothing matches.
  useLayoutEffect(() => {
    if (state === null) return
    closeListRef.current = () => state.close()
    if (nothingToShow && state.isOpen) state.close()
  })

  // The suggestion the pointer last moved onto, which React Aria highlights, since the user last
  // moved the highlight from the keyboard. React Aria forgets the highlight itself when the text
  // changes or the list closes.
  const hovered = useRef<string | null>(null)
  const onPointerOver = (event: PointerEvent) => {
    if (state === null) return
    const key = keyOf(event.target)
    // Not the one already highlighted, which the keyboard may have moved to.
    if (key !== null && key !== state.selectionManager.focusedKey) hovered.current = key
  }

  const onKeyDownCapture = (event: KeyboardEvent) => {
    if (state === null) return
    // An Enter ending an input method's composition belongs to it.
    if (event.nativeEvent.isComposing) return
    if (NAVIGATION_KEYS.has(event.key)) hovered.current = null
    if (event.key === 'Tab') {
      event.stopPropagation()
      return
    }
    if (event.key !== 'Enter') return
    const highlighted = state.isOpen ? state.selectionManager.focusedKey : null
    if (highlighted !== null && highlighted !== hovered.current) return
    // Not prevented, so that the form holding the input submits.
    state.close()
    event.stopPropagation()
  }

  return (
    <>
      <div
        className={styles.field}
        onKeyDownCapture={onKeyDownCapture}
        onInput={(event) => {
          if (state !== null && shows((event.target as HTMLInputElement).value)) state.open()
        }}
      >
        <div className={styles.inputBox}>{children}</div>
        <Button className={styles.button}>▾</Button>
      </div>
      <Popover className={shared.popover} maxHeight={320}>
        <div onPointerOver={onPointerOver}>{list}</div>
      </Popover>
    </>
  )
}
