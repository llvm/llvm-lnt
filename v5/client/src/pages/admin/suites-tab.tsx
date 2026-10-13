import { useEffect, useRef, useState, type Ref } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { authedApi, unwrap } from '../../api/client'
import { removeSuite, useSuites, type SuiteSchema } from '../../api/suites'
import { useScopeGate } from '../../auth/scope'
import { ActionButton } from '../../components/action-button'
import { ActionRow } from '../../components/action-row'
import { ControlsPanel } from '../../components/controls-panel'
import { ErrorMessage, Loading } from '../../components/feedback'
import { Select } from '../../components/select'
import { useDropUnusable } from '../../url-state'
import { CopyButton } from '../../components/copy-button'
import { CreateSuite } from './create-suite'
import { downloadFile } from './download'
import { EditSchema } from './edit-schema'
import { SchemaTables } from './schema-tables'
import styles from './admin.module.css'

interface Props {
  /** The name of the suite shown, or '' for none. */
  selected: string
  onSelect(name: string): void
}

/**
 * The Test Suites tab (AD2): a dropdown selecting a suite, whose schema it shows, exports and
 * deletes, and "New suite" and "Edit schema", which open the schema editor in the viewer's place
 * (AD3). Nothing is selected until the user selects a suite, or the URL names one.
 */
export function SuitesTab({ selected, onSelect }: Props) {
  const suites = useSuites()
  const gate = useScopeGate('manage')
  // What the schema editor is open for, if it is: creating a suite, or editing the suite named.
  const [editor, setEditor] = useState<{ edit: string } | 'create' | null>(null)
  const selectRef = useRef<HTMLButtonElement>(null)
  const newSuiteRef = useRef<HTMLButtonElement>(null)
  const editRef = useRef<HTMLButtonElement>(null)
  const noteRef = useRef<HTMLParagraphElement>(null)
  // What takes the focus once rendered: the dropdown, or the note saying that there are no suites
  // if the suite deleted was the last, or the button that opened the editor once it is closed.
  const refocus = useRef<'select' | 'new-suite' | 'edit' | null>(null)
  useEffect(() => {
    if (refocus.current === null) return
    const target = { select: selectRef, 'new-suite': newSuiteRef, edit: editRef }[refocus.current]
    refocus.current = null
    ;(target.current ?? noteRef.current)?.focus()
  })

  // The suite whose schema the editor edits, if it does.
  const edited = editor !== null && editor !== 'create' ? editor.edit : null

  // A suite the instance does not have is dropped (AR2 "State"), as is one just deleted. If its
  // schema was being edited, the editor goes with it, and the focus to the dropdown, as once a suite
  // is deleted from the viewer.
  useDropUnusable(
    suites,
    (list) => selected === '' || list.some((suite) => suite.name === selected),
    () => {
      onSelect('')
      if (edited === selected) refocus.current = 'select'
    },
  )

  // A list fetched again that fails leaves the one the tab shows, and the editor with it.
  if (suites.data === undefined) {
    if (suites.isError) {
      return <ErrorMessage error={suites.error} onRetry={() => void suites.refetch()} />
    }
    return <Loading label="Loading test suites..." />
  }

  const schema = suites.data.find((suite) => suite.name === selected)
  // The editor edits the suite shown, and goes once another is.
  if (edited !== null && edited !== selected) setEditor(null)
  const editing = edited !== null && schema !== undefined
  const editorOpen = editor !== null
  const closeEditor = (focus: typeof refocus.current) => {
    setEditor(null)
    refocus.current = focus
  }

  const newSuite = (
    <ActionButton
      ref={newSuiteRef}
      reason={gate.title ?? (editorOpen ? 'Close the schema editor first.' : undefined)}
      onClick={() => setEditor('create')}
    >
      New suite
    </ActionButton>
  )
  return (
    <>
      <ControlsPanel>
        {suites.data.length > 0 && (
          <Select
            ref={selectRef}
            label="Test suite"
            options={[
              { value: '', label: 'Select a suite' },
              ...suites.data.map(({ name }) => ({ value: name, label: name })),
            ]}
            value={schema?.name ?? ''}
            onChange={onSelect}
            isDisabled={editorOpen}
          />
        )}
        {newSuite}
      </ControlsPanel>
      {editor === 'create' ? (
        <CreateSuite
          suites={suites.data}
          onCancel={() => closeEditor('new-suite')}
          onCreated={(name) => {
            closeEditor('select')
            onSelect(name)
          }}
        />
      ) : editing ? (
        <EditSchema name={selected} onClose={() => closeEditor('edit')} />
      ) : suites.data.length === 0 ? (
        <p ref={noteRef} tabIndex={-1} className={styles.note}>
          There are no test suites yet.
        </p>
      ) : (
        schema && (
          // Keyed, so that nothing of a suite's viewer, an open prompt say, stays on another's.
          <SchemaViewer
            key={schema.name}
            schema={schema}
            editRef={editRef}
            onEdit={() => setEditor({ edit: schema.name })}
            onDeleted={() => (refocus.current = 'select')}
          />
        )
      )}
    </>
  )
}

interface ViewerProps {
  schema: SuiteSchema
  /** Open the schema editor on the suite, from the button `editRef` refers to. */
  onEdit(): void
  editRef: Ref<HTMLButtonElement>
  /** The suite has been deleted while the viewer showed it, and is about to be forgotten. */
  onDeleted(): void
}

/**
 * A suite's schema, its exports, and its editing and deletion, which need `manage` (AD2).
 */
function SchemaViewer({ schema, onEdit, editRef, onDeleted }: ViewerProps) {
  const queryClient = useQueryClient()
  const gate = useScopeGate('manage')
  const { name } = schema
  // The schema as the API returned it, which another instance can create the suite from (D4).
  const json = JSON.stringify(schema, null, 2)

  return (
    <>
      <SchemaTables schema={schema} />
      <div className={styles.actions}>
        <ActionRow
          deleteAtEnd
          deletion={{
            label: 'Delete This Suite',
            scope: 'manage',
            expected: name,
            message: (
              <p>
                Deleting the test suite <strong>{name}</strong> permanently destroys all of its
                machines, runs, commits, samples and regressions. This cannot be undone.
              </p>
            ),
            busyMessage: 'Deleting a suite with much data may take a while.',
            onDelete: () =>
              unwrap(
                authedApi.DELETE('/api/suites/{name}', {
                  params: { path: { name }, query: { confirm: true } },
                }),
              ),
            onDeleted: async (shown) => {
              if (shown) onDeleted()
              await removeSuite(queryClient, name)
            },
          }}
        >
          <ActionButton ref={editRef} reason={gate.title} onClick={onEdit}>
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
