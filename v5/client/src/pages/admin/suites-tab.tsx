import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { authedApi, unwrap } from '../../api/client'
import { removeSuite, useSuites, type SuiteSchema } from '../../api/suites'
import { ActionRow } from '../../components/action-row'
import { ControlsPanel } from '../../components/controls-panel'
import { ErrorMessage, Loading } from '../../components/feedback'
import { Select } from '../../components/select'
import { useDropUnusable } from '../../url-state'
import { CopyButton } from './copy-button'
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
 * deletes. Nothing is selected until the user selects a suite, or the URL names one.
 */
export function SuitesTab({ selected, onSelect }: Props) {
  const suites = useSuites()
  const selectRef = useRef<HTMLButtonElement>(null)
  const noteRef = useRef<HTMLParagraphElement>(null)
  // The suite shown has been deleted: the focus goes to the dropdown once rendered, or to the note
  // saying that there are no suites if it was the last.
  const refocus = useRef(false)
  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    ;(selectRef.current ?? noteRef.current)?.focus()
  })

  // A suite the instance does not have is dropped (AR2 "State"), as is one just deleted.
  useDropUnusable(
    suites,
    (list) => selected === '' || list.some((suite) => suite.name === selected),
    () => onSelect(''),
  )

  if (suites.isPending) return <Loading label="Loading test suites..." />
  if (suites.isError) {
    return <ErrorMessage error={suites.error} onRetry={() => void suites.refetch()} />
  }
  if (suites.data.length === 0) {
    return (
      <p ref={noteRef} tabIndex={-1} className={styles.note}>
        There are no test suites yet.
      </p>
    )
  }

  const schema = suites.data.find((suite) => suite.name === selected)
  return (
    <>
      <ControlsPanel>
        <Select
          ref={selectRef}
          label="Test suite"
          options={[
            { value: '', label: 'Select a suite' },
            ...suites.data.map(({ name }) => ({ value: name, label: name })),
          ]}
          value={schema?.name ?? ''}
          onChange={onSelect}
        />
      </ControlsPanel>
      {schema && (
        // Keyed, so that nothing of a suite's viewer, an open prompt say, stays on another's.
        <SchemaViewer
          key={schema.name}
          schema={schema}
          onDeleted={() => (refocus.current = true)}
        />
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
