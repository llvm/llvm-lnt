import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { authedApi, unwrap } from '../../api/client'
import { removeSuite, useSuites, type SuiteSchema } from '../../api/suites'
import { useScopeGate } from '../../auth/scope'
import { ActionRow } from '../../components/action-row'
import { ControlsPanel } from '../../components/controls-panel'
import { ErrorMessage, Loading } from '../../components/feedback'
import { Select } from '../../components/select'
import { useDropUnusable } from '../../url-state'
import { CopyButton } from './copy-button'
import { CreateSuite } from './create-suite'
import { downloadFile } from './download'
import { SchemaTables } from './schema-tables'
import styles from './admin.module.css'

interface Props {
  /** The name of the suite shown, or '' for none. */
  selected: string
  onSelect(name: string): void
}

/**
 * The Test Suites tab (AD2): a dropdown selecting a suite, whose schema it shows, exports and
 * deletes, and "New suite", which opens the schema editor in the viewer's place (AD3). Nothing is
 * selected until the user selects a suite, or the URL names one.
 */
export function SuitesTab({ selected, onSelect }: Props) {
  const suites = useSuites()
  const gate = useScopeGate('manage')
  const [creating, setCreating] = useState(false)
  const selectRef = useRef<HTMLButtonElement>(null)
  const newSuiteRef = useRef<HTMLButtonElement>(null)
  const noteRef = useRef<HTMLParagraphElement>(null)
  // What takes the focus once rendered: the dropdown, or the note saying that there are no suites
  // if the suite deleted was the last, or "New suite" once the editor is cancelled.
  const refocus = useRef<'select' | 'new-suite' | null>(null)
  useEffect(() => {
    if (refocus.current === null) return
    const target = refocus.current === 'new-suite' ? newSuiteRef : selectRef
    refocus.current = null
    ;(target.current ?? noteRef.current)?.focus()
  })

  // A suite the instance does not have is dropped (AR2 "State"), as is one just deleted.
  useDropUnusable(
    suites,
    (list) => selected === '' || list.some((suite) => suite.name === selected),
    () => onSelect(''),
  )

  // A list fetched again that fails leaves the one the tab shows, and the editor with it.
  if (suites.data === undefined) {
    if (suites.isError) {
      return <ErrorMessage error={suites.error} onRetry={() => void suites.refetch()} />
    }
    return <Loading label="Loading test suites..." />
  }

  const newSuite = (
    <button
      type="button"
      ref={newSuiteRef}
      disabled={gate.disabled || creating}
      title={gate.title}
      aria-expanded={creating}
      onClick={() => setCreating(true)}
    >
      New suite
    </button>
  )
  const schema = suites.data.find((suite) => suite.name === selected)
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
            isDisabled={creating}
          />
        )}
        {newSuite}
      </ControlsPanel>
      {creating ? (
        <CreateSuite
          suites={suites.data}
          onCancel={() => {
            setCreating(false)
            refocus.current = 'new-suite'
          }}
          onCreated={(name) => {
            setCreating(false)
            onSelect(name)
            refocus.current = 'select'
          }}
        />
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
            onDeleted={() => (refocus.current = 'select')}
          />
        )
      )}
    </>
  )
}

interface ViewerProps {
  schema: SuiteSchema
  /** The suite has been deleted while the viewer showed it, and is about to be forgotten. */
  onDeleted(): void
}

/** A suite's schema, its exports, and its deletion, which needs `manage` (AD2). */
function SchemaViewer({ schema, onDeleted }: ViewerProps) {
  const queryClient = useQueryClient()
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
