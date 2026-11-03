import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router'
import { authedApi, unwrap } from '../../api/client'
import { refOf, schemaOf, type Suite, type SuiteRef, type SuiteSchema } from '../../api/suites'
import { fullLabel } from '../../labels'
import { useScopeGate } from '../../auth/scope'
import { ActionButton } from '../../components/action-button'
import { ActionRow } from '../../components/action-row'
import { CopyButton } from '../../components/copy-button'
import { useFocusOnceChecked } from '../../components/use-focus-once-checked'
import { downloadFile } from './schema/download'
import { EditSchema } from './schema/edit-schema'
import { SchemaTables } from './schema/schema-tables'
import { movedFromOf } from './settings'
import styles from './schema/schema.module.css'

interface Props {
  schema: Suite
  /** The suite has been deleted: forget it, and leave its page if the user is still on it. */
  onDeleted(): Promise<void>
  /**
   * The suite has been renamed or moved to `to`: forget its old names, and leave its page for the
   * new one if the user is still on it.
   */
  onMoved(schema: SuiteSchema, to: SuiteRef): Promise<void>
}

/**
 * The Schema tab (TS6): the suite's schema, its exports, and its editing, renaming, moving and
 * deletion, which need `manage` in it. "Edit schema" opens the schema editor (TS7) in their place,
 * which renames and moves the suite too, and asks before its changes go with the tab.
 */
export function SchemaTab({ schema, onDeleted, onMoved }: Props) {
  const { name } = schema
  const suite = refOf(schema)
  const gate = useScopeGate('manage', suite)
  const [editing, setEditing] = useState(false)
  const editRef = useRef<HTMLButtonElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  // Whether "Edit schema" takes the focus back once rendered, the editor having closed. In the
  // commit, so that what it changed never shows without the focus where it goes.
  const refocus = useRef(false)
  useLayoutEffect(() => {
    if (refocus.current) editRef.current?.focus()
    refocus.current = false
  })
  // Arriving from the suite's old names (see `onMoved`), which a move always leads to this tab
  // from: "Edit schema" takes the focus once the token has been checked again, as once the editor
  // has closed, or the tab's actions do if it stays disabled, only if the focus went with the old
  // page. Read on mount, since the page then takes the state out of the history entry.
  const location = useLocation()
  const [focusEdit, setFocusEdit] = useState(() => movedFromOf(location) !== undefined)
  const onEditFocused = useCallback(() => setFocusEdit(false), [])
  useFocusOnceChecked(focusEdit, onEditFocused, editRef, actionsRef)

  if (editing) {
    return (
      <EditSchema
        suite={suite}
        onClose={() => {
          setEditing(false)
          refocus.current = true
        }}
        onMoved={onMoved}
      />
    )
  }

  // The schema as the API returned it, which another project or instance can create the suite from
  // (D4).
  const json = JSON.stringify(schemaOf(schema), null, 2)
  return (
    <>
      <SchemaTables schema={schema} />
      <div
        ref={actionsRef}
        className={styles.actions}
        role="group"
        aria-label="Schema actions"
        tabIndex={-1}
      >
        <ActionRow
          deleteAtEnd
          deletion={{
            label: 'Delete This Suite',
            scope: 'manage',
            suite,
            expected: name,
            message: (
              <p>
                Deleting the test suite <strong>{fullLabel(schema)}</strong> permanently destroys
                all of its machines, runs, commits, samples and regressions. This cannot be undone.
              </p>
            ),
            busyMessage: 'Deleting a suite with much data may take a while.',
            onDelete: () =>
              unwrap(
                authedApi.DELETE('/api/projects/{project}/suites/{suite}', {
                  params: { path: suite, query: { confirm: true } },
                }),
              ),
            onDeleted,
          }}
        >
          <ActionButton ref={editRef} reason={gate.title} onClick={() => setEditing(true)}>
            Edit schema
          </ActionButton>
          <CopyButton text={json}>Copy as JSON</CopyButton>
          <button
            type="button"
            onClick={() => downloadFile(`${name}.json`, `${json}\n`, 'application/json')}
          >
            Download JSON
          </button>
        </ActionRow>
      </div>
    </>
  )
}
