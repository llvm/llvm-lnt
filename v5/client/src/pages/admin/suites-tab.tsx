import { useLayoutEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useSuites } from '../../api/suites'
import { useScopeGate } from '../../auth/scope'
import { ActionButton } from '../../components/action-button'
import { ErrorMessage, Loading } from '../../components/feedback'
import { suiteTabPath } from '../test-suites/settings'
import { CreateSuite } from './create-suite'
import styles from './admin.module.css'

/**
 * The Test Suites tab (AD2): "New suite", which opens the schema editor in place of the tab's
 * content to create a suite (TS7), and the suites of the instance, each leading to its Schema tab
 * (TS6), where it is maintained.
 */
export function SuitesTab() {
  const suites = useSuites()
  // Creating a suite addresses none, so it needs an instance-wide token (AD2).
  const gate = useScopeGate('manage', null)
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const newSuiteRef = useRef<HTMLButtonElement>(null)
  // Whether "New suite" takes the focus once rendered: when the editor has just been cancelled.
  const refocus = useRef(false)
  useLayoutEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    newSuiteRef.current?.focus()
  })

  // A list fetched again that fails leaves the one the tab shows, and the editor with it.
  if (suites.data === undefined) {
    if (suites.isError) {
      return <ErrorMessage error={suites.error} onRetry={() => void suites.refetch()} />
    }
    return <Loading label="Loading test suites..." />
  }

  if (creating) {
    return (
      <CreateSuite
        suites={suites.data}
        onCancel={() => {
          setCreating(false)
          refocus.current = true
        }}
        onCreated={(name) => navigate(suiteTabPath(name, 'schema'))}
      />
    )
  }
  return (
    <>
      <div className={styles.newSuite}>
        <ActionButton ref={newSuiteRef} reason={gate.title} onClick={() => setCreating(true)}>
          New suite
        </ActionButton>
      </div>
      {suites.data.length === 0 ? (
        <p className={styles.note}>There are no test suites yet.</p>
      ) : (
        <>
          <p>Edit, export or delete a suite from its Schema tab:</p>
          <ul className={styles.suiteList} aria-label="Test suites">
            {suites.data.map(({ name }) => (
              <li key={name}>
                <Link to={suiteTabPath(name, 'schema')}>{name}</Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}
