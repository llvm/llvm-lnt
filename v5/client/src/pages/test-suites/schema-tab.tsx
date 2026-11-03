import { useLayoutEffect, useRef, useState } from 'react'
import { authedApi, unwrap } from '../../api/client'
import { refOf, schemaOf, type Suite } from '../../api/suites'
import { fullLabel } from '../../labels'
import { useScopeGate } from '../../auth/scope'
import { ActionButton } from '../../components/action-button'
import { ActionRow } from '../../components/action-row'
import { CopyButton } from '../../components/copy-button'
import { downloadFile } from './schema/download'
import { EditSchema } from './schema/edit-schema'
import { SchemaTables } from './schema/schema-tables'
import styles from './schema/schema.module.css'

interface Props {
  schema: Suite
  /** The suite has been deleted: forget it, and leave its page if the user is still on it. */
  onDeleted(): Promise<void>
}

/**
 * The Schema tab (TS6): the suite's schema, its exports, and its editing and deletion, which need
 * `manage` in it. "Edit schema" opens the schema editor (TS7) in their place, which asks before
 * its changes go with the tab.
 */
export function SchemaTab({ schema, onDeleted }: Props) {
  const { name } = schema
  const suite = refOf(schema)
  const gate = useScopeGate('manage', suite)
  const [editing, setEditing] = useState(false)
  const editRef = useRef<HTMLButtonElement>(null)
  // Whether "Edit schema" takes the focus once rendered: when the editor has just closed. In the
  // commit, so that the schema saved never shows without the focus where it goes.
  const refocus = useRef(false)
  useLayoutEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    editRef.current?.focus()
  })

  if (editing) {
    return (
      <EditSchema
        suite={suite}
        onClose={() => {
          setEditing(false)
          refocus.current = true
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
