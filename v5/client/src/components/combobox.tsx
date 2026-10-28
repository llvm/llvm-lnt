import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  Button,
  Collection,
  ComboBox,
  ComboBoxStateContext,
  Header,
  Input,
  ListBox,
  ListBoxItem,
  ListBoxLoadMoreItem,
  ListBoxSection,
  ListLayout,
  Virtualizer,
  type Key,
} from 'react-aria-components'
import clsx from 'clsx'
import { errorMessage } from '../api/client'
import { FieldLabel } from './field-label'
import { Popover } from './popover'
import type { Suggestion, Suggestions } from './suggestions'
import shared from './dropdown.module.css'
import styles from './combobox.module.css'

interface CommonProps {
  label: string
  /** From `useLocalSuggestions` or `useServerSuggestions`. */
  suggestions: Suggestions
  placeholder?: string
  /**
   * A default value, taken from elsewhere, that the combobox shows while it holds no value. It is
   * shown in place of the placeholder, in italics, and assistive technology reads `description`
   * with the combobox, which names it and says where it comes from, as not every one reads a
   * placeholder. Being no value of the combobox, it has no button to clear it.
   */
  inherited?: { text: string; description: string }
  /**
   * What the combobox says when it has nothing at all to suggest (see `Suggestions.isEmpty`). It
   * replaces `placeholder`, and shows in the list. Write it as a phrase, without a final period.
   */
  emptyMessage?: string
  isDisabled?: boolean
  /** Shown as it is, but cannot be changed, and keeps the focus, unlike when disabled. */
  isReadOnly?: boolean
  /**
   * Whether the user can clear the value: true by default. A combobox whose value cannot be
   * cleared has no clear button, and emptying its input does not clear its value.
   */
  isClearable?: boolean
  /** Keep the label for assistive technology only, where the page already says what it is. */
  hideLabel?: boolean
  /**
   * What goes on the label's line, at its end, such as a button about the value: beside the label
   * rather than in it, so that it is no part of the combobox's name, and clicking it does not focus
   * the input. The line is there with or without it, so that nothing moves when it appears.
   */
  labelAside?: ReactNode
  /** Make the combobox fill the rest of its row, for text too long for the usual width. */
  fill?: boolean
  /**
   * Called with whether the input holds text that is not the value's -- typed, but not picked --
   * whenever that changes: a form holding the combobox is not submitted meanwhile (AR15).
   */
  onPendingChange?: (pending: boolean) => void
  /**
   * What the list shows for a suggestion, if more than its text, such as a badge beside it. Its
   * text is still what the input shows once it is picked, and what typing to it matches, whereas
   * what this renders, badge included, is what assistive technology reads as its name. Memoize
   * it, as every suggestion is rendered again when it changes.
   */
  renderSuggestion?: (suggestion: Suggestion) => ReactNode
  /**
   * Render only the suggestions in view, and those around them, for a list of thousands that would
   * otherwise make typing lag (AR9).
   */
  virtualized?: boolean
}

/** A combobox holding a value: the suggestion last picked. */
interface ValueProps {
  /** The picked suggestion, or null when nothing is picked. */
  value: Suggestion | null
  onChange: (value: Suggestion | null) => void
  onPick?: never
}

/**
 * A combobox that hands what is picked to something else, such as a list of chips, rather than
 * holding it: a pick is passed to `onPick` and empties the input.
 */
interface PickProps {
  onPick: (picked: Suggestion) => void
  value?: never
  onChange?: never
}

type Props = CommonProps & (ValueProps | PickProps)

function sameSuggestion(a: Suggestion | null, b: Suggestion | null): boolean {
  return a?.key === b?.key && a?.text === b?.text
}

/** The text the combobox searches for: none while the input shows the value's own text. */
function searchText(text: string, value: Suggestion | null): string {
  return text === (value?.text ?? '') ? '' : text.trim()
}

/** The only suggestion whose text, or one of its aliases, is exactly `text`. */
function exactMatch(items: readonly Suggestion[], text: string): Suggestion | null {
  const matches = items.filter((item) => item.text === text || item.aliases?.includes(text))
  return matches.length === 1 ? matches[0] : null
}

/**
 * A combobox, with AR14's manual selection: typing narrows the suggestions, and the value changes
 * only when the user picks one, or presses Enter on text that exactly matches one.
 *
 * The value is controlled by the caller, and the input's text by the combobox. The value need not
 * be among the suggestions loaded, which is the case for a commit restored from the URL that is not
 * on the first page of the picker's suggestions. A combobox given `onPick` instead holds no value:
 * it hands each pick on, and empties its input.
 */
export function Combobox({
  label,
  value = null,
  onChange,
  onPick,
  suggestions,
  placeholder,
  inherited,
  emptyMessage,
  isDisabled,
  isReadOnly,
  isClearable = true,
  hideLabel,
  labelAside,
  fill = false,
  onPendingChange,
  renderSuggestion,
  virtualized = false,
}: Props) {
  const [text, setText] = useState(value?.text ?? '')
  const descriptionId = useId()

  // A value set from outside -- or one whose text arrived later, like a commit's display value --
  // replaces the text the input showed for the previous one. Text the user is typing stays.
  const [shown, setShown] = useState(value)
  if (!sameSuggestion(value, shown)) {
    setShown(value)
    if (text === (shown?.text ?? '')) setText(value?.text ?? '')
  }

  const pending = text !== (value?.text ?? '')
  useEffect(() => onPendingChange?.(pending), [pending, onPendingChange])

  const query = searchText(text, value)
  const { search } = suggestions
  useEffect(() => search(query), [query, search])

  const onInputChange = (next: string) => {
    setText(next)
    if (next === '' && value !== null && isClearable) onChange?.(null)
  }

  // The clear button empties the input, which clears the value, and leaves the focus in it.
  const inputRef = useRef<HTMLInputElement>(null)
  const clear = () => {
    onInputChange('')
    inputRef.current?.focus()
  }

  const restore = () => setText(value?.text ?? '')
  // How to close the list from outside it, which `Field` provides.
  const closeListRef = useRef(() => {})
  // Every pick closes the list. React Aria closes it when the value changes, but a pick may leave
  // the value as it is: one handed on to `onPick`, or one of the value itself (its commit string,
  // entered while the input showed its display value).
  const pick = (picked: Suggestion) => {
    if (onPick) {
      setText('')
      onPick(picked)
    } else if (picked.key === value?.key) {
      restore()
    } else {
      setText(picked.text)
      onChange?.(picked)
    }
    closeListRef.current()
  }

  // A pick, or React Aria asking to put the value's text back (on blur, or Enter with nothing
  // highlighted), which it does by "changing" the value to the current one.
  const onKeyChange = (key: Key | null) => {
    const picked = suggestions.items.find((item) => item.key === key)
    if (key === (value?.key ?? null) || picked === undefined) restore()
    else pick(picked)
  }

  return (
    <ComboBox
      className={clsx(shared.root, fill && shared.fill)}
      value={value?.key ?? null}
      onChange={onKeyChange}
      inputValue={text}
      onInputChange={onInputChange}
      // Controlled items, which React Aria does not filter: the source has.
      items={suggestions.items}
      allowsEmptyCollection
      // Opened by `Field` rather than by React Aria, which reopens the list when it puts back the
      // text of a value that is not among the suggestions shown (on Escape, say).
      menuTrigger="manual"
      isDisabled={isDisabled}
      isReadOnly={isReadOnly}
    >
      {labelAside === undefined ? (
        <FieldLabel label={label} hidden={hideLabel} />
      ) : (
        <div className={shared.labelLine}>
          <FieldLabel label={label} hidden={hideLabel} />
          {labelAside}
        </div>
      )}
      <Field query={query} suggestions={suggestions} pick={pick} closeListRef={closeListRef}>
        <div className={styles.inputBox}>
          <Input
            ref={inputRef}
            placeholder={
              inherited?.text ?? ((suggestions.isEmpty && emptyMessage) || placeholder)
            }
            className={clsx(styles.input, inherited && styles.inherited)}
            aria-describedby={inherited && descriptionId}
          />
          {text !== '' && isClearable && !isDisabled && !isReadOnly && (
            <button
              type="button"
              className={styles.clear}
              aria-label={`Clear ${label}`}
              // Out of the tab order, like the button opening the list: the input can be emptied
              // from the keyboard. Kept from taking the focus, which would leave the combobox, and
              // so put back the text of its value before the click empties it.
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={clear}
            >
              ×
            </button>
          )}
        </div>
      </Field>
      {/* Hidden, yet a description still: unlike text that is only visually hidden, it is not
          read again on its own, after the combobox. */}
      {inherited && (
        <span id={descriptionId} hidden>
          {inherited.description}
        </span>
      )}
      {/* Short enough that a page of suggestions scrolls rather than fills the window. */}
      <Popover
        className={clsx(shared.popover, virtualized && styles.virtualPopover)}
        maxHeight={320}
      >
        <List
          suggestions={suggestions}
          renderSuggestion={renderSuggestion}
          virtualized={virtualized}
          emptyMessage={emptyMessage}
        />
        {suggestions.error !== null && suggestions.items.length > 0 && (
          <div className={styles.status} role="alert">
            {errorMessage(suggestions.error)}
          </div>
        )}
      </Popover>
    </ComboBox>
  )
}

/**
 * How a virtualized list lays its suggestions out, with their heights estimated, as a suggestion's
 * text may wrap: it measures those it shows.
 */
const LIST_LAYOUT = { estimatedRowSize: 30, loaderSize: 30 }

/**
 * `items` as the list shows them: those in no section, then each section with its own, in the order
 * of their first suggestion.
 */
function sectioned(items: readonly Suggestion[]) {
  // Most lists have no sections, among them lists of thousands of suggestions (AR9), which are
  // then shown as they are.
  if (!items.some((item) => item.section !== undefined)) return { unsectioned: items, sections: [] }
  const unsectioned: Suggestion[] = []
  const sections = new Map<string, Suggestion[]>()
  for (const item of items) {
    if (item.section === undefined) unsectioned.push(item)
    else if (sections.has(item.section)) sections.get(item.section)!.push(item)
    else sections.set(item.section, [item])
  }
  return { unsectioned, sections: [...sections] }
}

/**
 * The list of suggestions, and the item loading more of them, while there are more or they are on
 * their way.
 */
function List({
  suggestions,
  renderSuggestion,
  virtualized,
  emptyMessage,
}: {
  suggestions: Suggestions
  renderSuggestion: ((suggestion: Suggestion) => ReactNode) | undefined
  virtualized: boolean
  emptyMessage: string | undefined
}) {
  const { unsectioned, sections } = useMemo(() => sectioned(suggestions.items), [suggestions.items])
  // Kept from one render to the next, so that React Aria does not go over every suggestion again on
  // each keystroke, while the suggestions themselves are still those for earlier text (AR9).
  const option = useCallback(
    (item: Suggestion) => (
      <ListBoxItem
        id={item.key}
        textValue={item.text}
        className={clsx(shared.option, virtualized && styles.virtualOption)}
      >
        {/* Rendered once shown, rather than for every suggestion, as React Aria lists them all. */}
        {renderSuggestion ? () => renderSuggestion(item) : item.text}
      </ListBoxItem>
    ),
    [renderSuggestion, virtualized],
  )
  const list = (
    <ListBox
      className={clsx(shared.list, virtualized && styles.virtualList)}
      renderEmptyState={() => <EmptyState suggestions={suggestions} emptyMessage={emptyMessage} />}
    >
      {/* Rendered again for a new `renderSuggestion`, which React Aria would not do on its own. */}
      <Collection items={unsectioned} dependencies={[renderSuggestion]}>
        {option}
      </Collection>
      {/* Sections and suggestions share one space of ids. A section's starts with a `/` so that it
          cannot be that of a suggestion named like it, such as a machine "Untracked": only machine
          pickers have sections (AR18), and a machine's name holds no `/` (I1). A section is shown
          only while it holds suggestions, since `sectioned` makes none for an empty one. */}
      {sections.map(([section, items]) => (
        <ListBoxSection key={`/section/${section}`} id={`/section/${section}`}>
          <Header className={styles.sectionHeader}>{section}</Header>
          <Collection items={items} dependencies={[renderSuggestion]}>
            {option}
          </Collection>
        </ListBoxSection>
      ))}
      {(suggestions.hasMore || suggestions.isLoadingMore) && (
        <ListBoxLoadMoreItem
          className={styles.status}
          onLoadMore={suggestions.loadMore}
          isLoading={suggestions.isLoadingMore}
        >
          Loading more...
        </ListBoxLoadMoreItem>
      )}
    </ListBox>
  )
  if (!virtualized) return list
  return (
    <Virtualizer layout={ListLayout} layoutOptions={LIST_LAYOUT}>
      {list}
    </Virtualizer>
  )
}

function EmptyState({
  suggestions,
  emptyMessage,
}: {
  suggestions: Suggestions
  emptyMessage: string | undefined
}) {
  let message = 'No matches.'
  if (suggestions.error !== null) message = errorMessage(suggestions.error)
  else if (suggestions.isLoading) message = 'Loading...'
  else if (suggestions.isEmpty && emptyMessage !== undefined) message = `${emptyMessage}.`
  return <div className={styles.status}>{message}</div>
}

/** The keys that move the highlight among the suggestions. */
const NAVIGATION_KEYS = new Set(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'])

/**
 * The input and its button. The list opens when the user types, as well as on ArrowDown and from
 * the button, as React Aria opens it.
 *
 * Enter with no suggestion highlighted is AR14's Enter on text that exactly matches a suggestion,
 * so that a value can be pasted and entered; with one highlighted, it picks that one, as React Aria
 * does. An Enter pressed before the suggestions for its text have arrived is held until they do,
 * and dropped if the text changes meanwhile, as leaving the combobox does by putting back the
 * value's text.
 *
 * While the list still shows the suggestions for earlier text, as it does until those for the
 * text typed arrive (AR9), only a suggestion the user moved to from the keyboard since the text last
 * changed counts as highlighted. The one the pointer is on, which React Aria highlights too, even
 * when the list opens under a resting pointer, is not for this text: Enter must not pick it.
 */
function Field({
  query,
  suggestions,
  pick,
  closeListRef,
  children,
}: {
  query: string
  suggestions: Suggestions
  pick: (picked: Suggestion) => void
  closeListRef: RefObject<() => void>
  children: ReactElement
}) {
  const state = useContext(ComboBoxStateContext)!
  useLayoutEffect(() => {
    closeListRef.current = () => state.close()
  })
  // The text the held Enter was pressed on, if any.
  const held = useRef<string | null>(null)
  // Whether the user has moved the highlight from the keyboard since the text last changed.
  const navigated = useRef(false)

  const enter = (entered: string) => {
    const match = exactMatch(suggestions.items, entered)
    if (match === null) {
      // Nothing to pick: the text stays, and the list shows why.
      state.open()
      return
    }
    pick(match)
  }

  useEffect(() => {
    const entered = held.current
    if (entered === null) return
    if (entered !== query) held.current = null
    else if (!suggestions.isLoading) {
      held.current = null
      enter(entered)
    }
  })

  const onKeyDownCapture = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return
    if (NAVIGATION_KEYS.has(event.key)) navigated.current = true
    if (event.key !== 'Enter' || query === '') return
    const highlighted = state.selectionManager.focusedKey !== null
    if (highlighted && (navigated.current || !suggestions.isLoading)) return
    // Ours rather than React Aria's, which would put the value's text back, and no form's either.
    event.preventDefault()
    event.stopPropagation()
    if (!suggestions.isLoading) {
      enter(query)
    } else {
      held.current = query
      suggestions.search(query, { immediate: true })
    }
  }

  return (
    <div
      className={styles.field}
      onKeyDownCapture={onKeyDownCapture}
      onInput={() => {
        navigated.current = false
        state.open()
      }}
    >
      {children}
      <Button className={styles.button}>▾</Button>
    </div>
  )
}
