import { useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useProjects } from '../../api/suites'
import { refusalInEvery } from '../../auth/scope'
import { useAuth } from '../../auth/use-auth'
import { ActionButton } from '../../components/action-button'
import { suiteTabPath } from '../test-suites/settings'
import { CreateSuite } from './create-suite'

/**
 * The Test Suites tab (AD2): "New suite", which opens the schema editor in its place to create a
 * suite (TS7). A suite is otherwise maintained from its Schema tab (TS6).
 */
export function SuitesTab() {
  const projects = useProjects()
  const { status } = useAuth()
  // A suite is created in a project, which the token must cover in full: "New suite" needs one
  // such project at least (AR17, AD2). Until the projects are listed, or when they cannot be, the
  // editor says so itself (TS7).
  const list = projects.data
  const reason =
    list?.length === 0
      ? 'There are no projects to create a suite in.'
      : refusalInEvery('manage', list, status, list)
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
        onCreated={(suite) => navigate(suiteTabPath(suite, 'schema'))}
      />
    )
  }
  return (
    <ActionButton ref={newSuiteRef} reason={reason} onClick={() => setCreating(true)}>
      New suite
    </ActionButton>
  )
}
