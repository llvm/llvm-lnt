import {
  memo,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  type InputHTMLAttributes,
  type Ref,
} from 'react'
import { VisuallyHidden } from 'react-aria-components'
import { ActionButton } from '../../../components/action-button'
import type { Column } from '../../../components/data-table'
import { Select } from '../../../components/select'
import { SchemaList } from './schema-tables'
import {
  addEntry,
  changeEntry,
  nameProblems,
  newEntry,
  removeEntry,
  restoreEntry,
  type Draft,
  type DraftEntry,
} from './schema-editor-model'
import {
  flagProblem,
  isTextKey,
  KEY_HEADERS,
  LIST_INFO,
  LISTS,
  TYPES,
  type AttributeType,
  type ListName,
  type PresentationKey,
} from './schema-lists'
import styles from './schema.module.css'

const TYPE_OPTIONS = TYPES.map((type) => ({ value: type, label: type }))

/** A change to the draft, made from the draft as it is when the change applies. */
type Update = (draft: Draft) => Draft

interface Props {
  draft: Draft
  /** Apply `update` to the draft: a `useState` setter will do. */
  onChange(update: Update): void
  /**
   * The draft is being sent, or confirmed: nothing changes it, but nothing is disabled either, which
   * would lose the focus (as in InlineEdit).
   */
  busy: boolean
}

/**
 * The schema editor's three tables (TS7): the viewer's, with an input for each value. Each table
 * adds an entry at its end, and each entry can be removed.
 */
export function SchemaEditorTables({ draft, onChange, busy }: Props) {
  const container = useRef<HTMLDivElement>(null)
  // What takes the focus once a change has rendered: the element whose `data-focus` it is. Given in
  // the commit itself: an effect after it may run only as the next change begins, with `focusNext`
  // set for that change already, whose element is not there yet.
  const focusNext = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (focusNext.current === null) return
    container.current?.querySelector<HTMLElement>(`[data-focus="${focusNext.current}"]`)?.focus()
    focusNext.current = null
  })
  const change = useCallback(
    (update: Update, focus?: string) => {
      if (focus !== undefined) focusNext.current = focus
      onChange(update)
    },
    [onChange],
  )

  return (
    <div ref={container}>
      {LISTS.map((list) => (
        <ListTable key={list} list={list} entries={draft[list]} busy={busy} change={change} />
      ))}
    </div>
  )
}

interface ListProps {
  list: ListName
  entries: DraftEntry[]
  busy: boolean
  /** Apply `update`, then focus the element whose `data-focus` is `focus`, if given. */
  change(update: Update, focus?: string): void
}

/** One list's table, rendered again when the list changes, not on every keystroke elsewhere. */
const ListTable = memo(function ListTable({ list, entries, busy, change }: ListProps) {
  const { noun, keys, heading } = LIST_INFO[list]
  const problems = nameProblems(list, entries)
  const update = (entry: DraftEntry, changes: Partial<DraftEntry>) => {
    if (!busy) change((draft) => changeEntry(draft, list, entry.id, changes))
  }

  /** The entry's place in the list, from 1, by which its controls are named until it has a name. */
  const position = (entry: DraftEntry) => entries.indexOf(entry) + 1
  /**
   * An entry, as the accessible names of its controls say: `metric compile_time`, or `metric 2`
   * while its name is empty or refused, which another entry may share.
   */
  const entryLabel = (entry: DraftEntry) =>
    `${noun} ${entry.name === '' || problems.has(entry.id) ? position(entry) : entry.name}`

  /** The input of `key` for `entry`. */
  const input = (key: PresentationKey, entry: DraftEntry) => {
    const label = `${KEY_HEADERS[key].label} of ${entryLabel(entry)}`
    if (isTextKey(key)) {
      return (
        <input
          type="text"
          className={styles.cellInput}
          aria-label={label}
          value={entry[key]}
          readOnly={busy}
          autoComplete="off"
          onChange={(event) => update(entry, { [key]: event.target.value })}
        />
      )
    }
    const problem = flagProblem(list, key, entry.type)
    return (
      <input
        type="checkbox"
        className={styles.checkbox}
        aria-label={label}
        checked={entry[key]}
        disabled={problem !== undefined}
        aria-disabled={busy || undefined}
        title={problem}
        onChange={(event) => update(entry, { [key]: event.target.checked })}
      />
    )
  }

  /**
   * What takes the focus once `entry` is removed: its Undo button if it existed, which keeps its
   * row; otherwise the next row's button, or the one adding an entry.
   */
  const afterRemoving = (entry: DraftEntry) => {
    if (entry.original !== null) return `${entry.id}-undo`
    const next = entries[entries.indexOf(entry) + 1]
    if (next === undefined) return `add-${list}`
    return `${next.id}-${next.removed ? 'undo' : 'remove'}`
  }

  const columns: Column<DraftEntry>[] = [
    {
      id: 'name',
      header: 'Name',
      className: styles.editorCell,
      // An existing entry's name and type cannot change (D2).
      cell: (entry) =>
        entry.original !== null ? (
          <span className={entry.removed ? styles.removedName : undefined}>{entry.name}</span>
        ) : (
          <NameInput
            // By its place in the list, rather than by what is typed into it.
            label={`Name of ${noun} ${position(entry)}`}
            value={entry.name}
            problem={problems.get(entry.id)}
            readOnly={busy}
            className={styles.cellInput}
            data-focus={`${entry.id}-name`}
            onValue={(name) => update(entry, { name })}
          />
        ),
    },
    {
      id: 'type',
      header: 'Type',
      className: styles.editorCell,
      cell: (entry) =>
        entry.original !== null ? (
          entry.type
        ) : (
          <Select
            label={`Type of ${entryLabel(entry)}`}
            hideLabel
            options={TYPE_OPTIONS}
            value={entry.type}
            onChange={(type: AttributeType) => update(entry, { type })}
            isPending={busy}
          />
        ),
    },
    ...keys.map((key, index) => ({
      id: key,
      header: KEY_HEADERS[key].header,
      className: styles.editorCell,
      cell: (entry: DraftEntry) => {
        if (!entry.removed) return input(key, entry)
        // A removed entry says so, in words, in its first column of values.
        return index === 0 && <span className={styles.note}>(removed)</span>
      },
    })),
    {
      id: 'remove',
      header: <VisuallyHidden>Actions</VisuallyHidden>,
      className: styles.editorCell,
      // Remove, or for an entry removed already, Undo, each giving the focus to the other.
      cell: (entry) => {
        const undo = entry.removed
        return (
          <ActionButton
            aria-label={`${undo ? 'Undo removing' : 'Remove'} ${entryLabel(entry)}`}
            busy={busy}
            data-focus={`${entry.id}-${undo ? 'undo' : 'remove'}`}
            onClick={() =>
              undo
                ? change((draft) => restoreEntry(draft, list, entry.id), `${entry.id}-remove`)
                : change((draft) => removeEntry(draft, list, entry.id), afterRemoving(entry))
            }
          >
            {undo ? 'Undo' : '×'}
          </ActionButton>
        )
      },
    },
  ]

  return (
    <section aria-label={heading}>
      <SchemaList list={list} columns={columns} rows={entries} rowKey={rowKey} />
      <ActionButton
        className={styles.addEntry}
        busy={busy}
        data-focus={`add-${list}`}
        onClick={() => {
          const entry = newEntry(list)
          change((draft) => addEntry(draft, list, entry), `${entry.id}-name`)
        }}
      >
        + Add {noun}
      </ActionButton>
    </section>
  )
})

const rowKey = (entry: DraftEntry) => String(entry.id)

interface NameProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  /** The input's accessible name, unless a `<label>` gives it one. */
  label?: string
  value: string
  /** Why the name is refused, if it is. */
  problem: string | undefined
  onValue(value: string): void
  'data-focus'?: string
  ref?: Ref<HTMLInputElement>
}

/**
 * The input of a name the schema editor checks as it is typed: when refused, it has the red halo,
 * and the reason on hover and for assistive technology (TS7, AR11). Not limited in length, so that
 * a name too long is refused rather than cut short.
 */
export function NameInput({ label, problem, onValue, ...props }: NameProps) {
  const problemId = useId()
  return (
    <>
      <input
        type="text"
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        {...props}
        aria-invalid={problem !== undefined || undefined}
        aria-describedby={problem === undefined ? undefined : problemId}
        title={problem}
        onChange={(event) => onValue(event.target.value)}
      />
      {problem !== undefined && <VisuallyHidden id={problemId}>{problem}</VisuallyHidden>}
    </>
  )
}
