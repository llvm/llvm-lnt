import { useContext, useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import {
  Button,
  Collection,
  ComboBox,
  ComboBoxStateContext,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  ListBoxLoadMoreItem,
  type Key,
} from 'react-aria-components'
import { errorMessage } from '../api/client'
import { Popover } from './popover'
import type { Suggestion, Suggestions } from './suggestions'
import styles from './combobox.module.css'

interface Props {
  label: string
  /** The picked suggestion, or null when nothing is picked. */
  value: Suggestion | null
  onChange: (value: Suggestion | null) => void
  /** From `useLocalSuggestions` or `useServerSuggestions`. */
  suggestions: Suggestions
  placeholder?: string
  isDisabled?: boolean
  /**
   * Called with whether the input holds text that is not the value's -- typed, but not picked --
   * whenever that changes: a form holding the combobox is not submitted meanwhile (AR2).
   */
  onPendingChange?: (pending: boolean) => void
}

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
 * A combobox, with AR2's manual selection: typing narrows the suggestions, and the value changes
 * only when the user picks one, or presses Enter on text that exactly matches one.
 *
 * The value is controlled by the caller, and the input's text by the combobox. The value need not
 * be among the suggestions loaded, which is the case for a commit restored from the URL that is not
 * on the first page of the picker's suggestions.
 */
export function Combobox({
  label,
  value,
  onChange,
  suggestions,
  placeholder,
  isDisabled,
  onPendingChange,
}: Props) {
  const [text, setText] = useState(value?.text ?? '')

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
    if (next === '' && value !== null) onChange(null)
  }

  const restore = () => setText(value?.text ?? '')
  const pick = (picked: Suggestion) => {
    if (picked.key === value?.key) {
      restore()
    } else {
      setText(picked.text)
      onChange(picked)
    }
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
      className={styles.root}
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
    >
      <Label>{label}</Label>
      <Field query={query} suggestions={suggestions} value={value} pick={pick}>
        <Input placeholder={placeholder} className={styles.input} />
      </Field>
      {/* Short enough that a page of suggestions scrolls rather than fills the window. */}
      <Popover className={styles.popover} maxHeight={320}>
        <ListBox
          className={styles.list}
          renderEmptyState={() => <EmptyState suggestions={suggestions} />}
        >
          <Collection items={suggestions.items}>
            {(item) => (
              <ListBoxItem id={item.key} textValue={item.text} className={styles.option}>
                {item.text}
              </ListBoxItem>
            )}
          </Collection>
          {suggestions.hasMore && (
            <ListBoxLoadMoreItem
              className={styles.status}
              onLoadMore={suggestions.loadMore}
              isLoading={suggestions.isLoadingMore}
            >
              Loading more...
            </ListBoxLoadMoreItem>
          )}
        </ListBox>
        {suggestions.error !== null && suggestions.items.length > 0 && (
          <div className={styles.status} role="alert">
            {errorMessage(suggestions.error)}
          </div>
        )}
      </Popover>
    </ComboBox>
  )
}

function EmptyState({ suggestions }: { suggestions: Suggestions }) {
  let message = 'No matches.'
  if (suggestions.error !== null) message = errorMessage(suggestions.error)
  else if (suggestions.isLoading) message = 'Loading...'
  return <div className={styles.status}>{message}</div>
}

/**
 * The input and its button. The list opens when the user types, as well as on ArrowDown and from
 * the button, as React Aria opens it.
 *
 * Enter with no suggestion highlighted is AR2's Enter on text that exactly matches a suggestion, so
 * that a value can be pasted and entered; with one highlighted, it picks that one, as React Aria
 * does. An Enter pressed before the suggestions for its text have arrived is held until they do,
 * and dropped if the text changes meanwhile, as leaving the combobox does by putting back the
 * value's text.
 */
function Field({
  query,
  suggestions,
  value,
  pick,
  children,
}: {
  query: string
  suggestions: Suggestions
  value: Suggestion | null
  pick: (picked: Suggestion) => void
  children: ReactElement
}) {
  const state = useContext(ComboBoxStateContext)!
  // The text the held Enter was pressed on, if any.
  const held = useRef<string | null>(null)

  const enter = (entered: string) => {
    const match = exactMatch(suggestions.items, entered)
    if (match === null) {
      // Nothing to pick: the text stays, and the list shows why.
      state.open()
      return
    }
    pick(match)
    // React Aria closes the list when the value changes, but the match may be the value already
    // (its commit string, typed while the input showed its display value).
    if (match.key === value?.key) state.close()
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
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    if (state.selectionManager.focusedKey !== null || query === '') return
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
      onInput={() => state.open()}
    >
      {children}
      <Button className={styles.button}>▾</Button>
    </div>
  )
}
