import { useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useScopeGate } from '../../auth/scope'
import { ActionButton } from '../../components/action-button'
import { suiteTabPath } from '../test-suites/settings'
import { CreateSuite } from './create-suite'

/**
 * The Test Suites tab (AD2): "New suite", which opens the schema editor in its place to create a
 * suite (TS7). A suite is otherwise maintained from its Schema tab (TS6).
 */
export function SuitesTab() {
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

  if (creating) {
    return (
      <CreateSuite
        onCancel={() => {
          setCreating(false)
          refocus.current = true
        }}
        onCreated={(name) => navigate(suiteTabPath(name, 'schema'))}
      />
    )
  }
  return (
    <ActionButton ref={newSuiteRef} reason={gate.title} onClick={() => setCreating(true)}>
      New suite
    </ActionButton>
  )
}
