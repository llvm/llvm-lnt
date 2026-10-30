import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { authedApi, unwrap } from '../../api/client'
import { refOf, schemaOf, type Suite, type SuiteRef, type SuiteSchema } from '../../api/suites'
import { fullLabel } from '../../labels'
import { useScopeGate } from '../../auth/scope'
import { useAuth } from '../../auth/use-auth'
import { ActionButton } from '../../components/action-button'
import { ActionRow } from '../../components/action-row'
import { CopyButton } from '../../components/copy-button'
import { downloadFile } from './schema/download'
import { EditSchema } from './schema/edit-schema'
import { MoveSuite } from './schema/move-suite'
import { SchemaTables } from './schema/schema-tables'
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
  /**
   * The page has just come from the suite's old names (see `onMoved`): "Rename or move" takes the
   * focus once the token has been checked again, and enables it, and `onMoveFocused` is called.
   */
  focusMove?: boolean
  onMoveFocused?(): void
}

/**
 * The Schema tab (TS6): the suite's schema, its exports, and its editing, renaming, moving and
 * deletion, which need `manage` in it. "Edit schema" opens the schema editor (TS7) in their place,
 * which asks before its changes go with the tab.
 */
export function SchemaTab({ schema, onDeleted, onMoved, focusMove, onMoveFocused }: Props) {
  const { name } = schema
  const suite = refOf(schema)
  const gate = useScopeGate('manage', suite)
  const { status } = useAuth()
  const [editing, setEditing] = useState(false)
  const [moving, setMoving] = useState(false)
  const editRef = useRef<HTMLButtonElement>(null)
  const moveRef = useRef<HTMLButtonElement>(null)
  // The button whose action has just closed, which takes the focus back once rendered: "Edit
  // schema" once the editor has closed, "Rename or move" once its panel has. In the commit, so that
  // what they changed never shows without the focus where it goes.
  const refocus = useRef<typeof editRef | null>(null)
  useLayoutEffect(() => {
    refocus.current?.current?.focus()
    refocus.current = null
  })
  // Once the token has been checked again after the move, which disables the gated controls
  // meanwhile, so that the button can take the focus (AR17). Only if the focus went with the old
  // page, so that wherever the user has put it since stays where it is.
  const checking = status.state === 'checking'
  useEffect(() => {
    if (!focusMove || checking) return
    onMoveFocused?.()
    const active = document.activeElement
    if (active === null || active === document.body) moveRef.current?.focus()
  }, [focusMove, checking, onMoveFocused])

  if (editing) {
    return (
      <EditSchema
        suite={suite}
        onClose={() => {
          setEditing(false)
          refocus.current = editRef
        }}
      />
    )
  }

  // The schema as the API returned it, which another project or instance can create the suite from
  // (D4).
  const json = JSON.stringify(schemaOf(schema), null, 2)
  return (
    <>
      <SchemaTables schema={schema} />
      <div className={styles.actions}>
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
          <ActionButton
            ref={moveRef}
            reason={gate.title}
            aria-expanded={moving}
            onClick={() => setMoving(true)}
          >
            Rename or move
          </ActionButton>
          <CopyButton text={json}>Copy as JSON</CopyButton>
          <button
            type="button"
            onClick={() => downloadFile(`${name}.json`, `${json}\n`, 'application/json')}
          >
            Download JSON
          </button>
        </ActionRow>
        {moving && (
          <MoveSuite
            schema={schema}
            onClose={() => {
              setMoving(false)
              refocus.current = moveRef
            }}
            onMoved={onMoved}
          />
        )}
      </div>
    </>
  )
}
