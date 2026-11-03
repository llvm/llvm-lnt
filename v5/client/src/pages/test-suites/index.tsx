import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { forgetUnobserved } from '../../api/keys'
import {
  fullName,
  refOf,
  removeSuite,
  renameSuite,
  suiteOfFullName,
  suiteRef,
  useProjects,
  type Project,
  type Suite,
  type SuiteRef,
  type SuiteSchema,
} from '../../api/suites'
import { useAuth } from '../../auth/use-auth'
import { Alert, Loaded } from '../../components/feedback'
import { Tabs } from '../../components/tabs'
import { useMounted } from '../../components/use-mounted'
import { projectLabel, suiteLabel } from '../../labels'
import { projectPath } from '../../paths'
import { readParam, useUrlState } from '../../url-state'
import { ChipLinks } from './chip-links'
import { CommitsTab } from './commits-tab'
import { MachinesTab } from './machines-tab'
import { RegressionsTab } from './regressions-tab'
import { RunsTab } from './runs-tab'
import { SchemaTab } from './schema-tab'
import {
  PARAMS,
  TABS,
  resetSettings,
  suiteTabPath,
  unusedSettings,
  type TabId,
} from './settings'
import styles from './test-suites.module.css'

/**
 * The Projects page (TS1): the chips of the projects, those of the selected project's suites, and
 * the selected suite's tabs. The page goes to the first project's, and that of a project with suites
 * to its first suite's, in place of itself in the history.
 */
export default function Projects() {
  const { project, suite } = useParams()
  const [search] = useSearchParams()
  const projects = useProjects()
  const shown = projects.data?.find((entry) => entry.name === project)
  const schema = shown?.suites.find((entry) => entry.name === suite)
  const named = project === undefined || suite === undefined ? undefined : suiteRef(project, suite)
  const notFound = useNotFoundFocus(named && fullName(named), schema !== undefined)

  // What the page shows once the projects have loaded. A list fetched again that fails leaves it
  // shown (AR7), and the tabs with it: an open schema editor, say, which has the list fetched again
  // when a save finds it out of date (TS7).
  const listed = (list: Project[]) => {
    if (project === undefined) {
      const first = list.at(0)
      return first === undefined ? (
        <p className={styles.note}>There are no projects yet.</p>
      ) : (
        <Navigate to={projectLanding(first)} replace />
      )
    }
    // Another chip leads to the tab shown, if any.
    const tab =
      schema === undefined ? PARAMS.tab.default : readParam(PARAMS.tab, search.getAll('tab'))
    const projectChips = (
      <ChipLinks
        label="Projects"
        chips={list.map((entry) => ({
          key: entry.name,
          text: projectLabel(entry),
          to: projectLanding(entry, tab),
        }))}
        selected={shown?.name}
        current={suite === undefined ? 'page' : 'true'}
      />
    )
    if (shown === undefined) {
      return (
        <>
          {projectChips}
          <Alert>Project '{project}' not found.</Alert>
        </>
      )
    }
    if (suite === undefined && shown.suites.length > 0) {
      return <Navigate to={projectLanding(shown)} replace />
    }
    return (
      <>
        {projectChips}
        {shown.suites.length === 0 ? (
          <p className={styles.note}>No test suites.</p>
        ) : (
          <ChipLinks
            label="Test suites"
            chips={shown.suites.map((entry) => ({
              key: entry.name,
              text: suiteLabel(entry),
              to: suiteTabPath(refOf(entry), tab),
            }))}
            selected={schema?.name}
          />
        )}
        {named === undefined ? null : schema === undefined ? (
          <Alert ref={notFound} tabIndex={-1}>
            Test suite '{fullName(named)}' not found.
          </Alert>
        ) : (
          <SuiteTabs key={fullName(named)} schema={schema} />
        )}
      </>
    )
  }

  return (
    <section>
      <h1>Projects</h1>
      <Loaded
        data={projects.data}
        error={projects.error}
        onRetry={() => void projects.refetch()}
        label="Loading projects..."
      >
        {listed}
      </Loaded>
    </section>
  )
}

/**
 * Where the page of `project` goes (TS1): the tab `tab`, in its default state, of its first suite,
 * or its own page when it has none.
 */
function projectLanding(project: Project, tab: TabId = PARAMS.tab.default): string {
  const first = project.suites.at(0)
  return first === undefined ? projectPath(project.name) : suiteTabPath(refOf(first), tab)
}

/**
 * The ref of the message saying that `suite`, by its full name, was not found, which takes the focus
 * when it replaces the suite's tabs -- once the suite has gone from the list, deleted elsewhere -- if
 * the focus went with them, so that it is not left nowhere.
 */
function useNotFoundFocus(suite: string | undefined, found: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  // The suite whose tabs were shown last, if they were.
  const shown = useRef<string | null>(null)
  useLayoutEffect(() => {
    const lost = !found && shown.current === suite
    shown.current = found && suite !== undefined ? suite : null
    if (lost && (document.activeElement === null || document.activeElement === document.body)) {
      ref.current?.focus()
    }
  })
  return ref
}

/** The history state of the page that a rename or a move leads to, in place of the old names'. */
interface Moved {
  /** The full name the suite had. */
  movedFrom: string
}

function SuiteTabs({ schema }: { schema: Suite }) {
  const [settings, update] = useUrlState(PARAMS)
  const { tab, search } = settings
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const { recheck } = useAuth()
  // Whether the user is still on the suite's page, whichever its tab: these tabs are its page.
  const mounted = useMounted()

  // Once the suite is renamed or moved from its schema editor, the page leaves for the Schema tab of the
  // new names, in place of itself in the history, unless the user has left it meanwhile (TS6,
  // AR16). Before it does, the list of projects holds the suite under its new names, so that the
  // old ones never show it as gone, and what was read under the old names is forgotten, the page's
  // own once it has gone (see below). The token is checked again, so that what it covers is named
  // as it now is (AR17).
  const onMoved = async (moved: SuiteSchema, to: SuiteRef) => {
    const leaving = mounted.current
    const from = refOf(schema)
    await renameSuite(queryClient, from, to, moved, { leaving })
    recheck()
    if (leaving) {
      const state = { movedFrom: fullName(from) } satisfies Moved
      navigate(suiteTabPath(to, 'schema'), { replace: true, state })
    }
  }
  // Arriving from the old names: what the page read there, which it has stopped observing, is
  // dropped rather than shown if the history leads back to them, and "Edit schema" takes the focus,
  // as once the editor has closed. Only once: the state is taken out of the history entry, so that
  // a reload or Back does not do it again.
  const movedFrom = (location.state as Moved | null)?.movedFrom
  const [focusEdit, setFocusEdit] = useState(movedFrom !== undefined)
  useEffect(() => {
    if (movedFrom === undefined) return
    forgetUnobserved(queryClient, suiteOfFullName(movedFrom))
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null })
  }, [movedFrom, queryClient, navigate, location.pathname, location.search])
  const onEditFocused = useCallback(() => setFocusEdit(false), [])
  // Another tab, chosen before the token has been checked, keeps what it chose.
  if (focusEdit && tab !== 'schema') setFocusEdit(false)

  // Once the suite is deleted from its Schema tab, the page leaves for the project's suites, in place
  // of itself in the history, unless the user has left it meanwhile (TS6, AR16). Read first, since the suite
  // going from the list takes these tabs with it. The token is checked again, since its key may
  // have been restricted to the suite, which it no longer lists (I5), so that a suite created later
  // under the name does not seem to be covered (AR17).
  const onDeleted = async () => {
    const leaving = mounted.current
    await removeSuite(queryClient, refOf(schema))
    recheck()
    if (leaving) navigate(projectPath(schema.project.name), { replace: true })
  }

  // `settings` changes only with the URL.
  useEffect(() => {
    const unused = unusedSettings(settings)
    if (Object.keys(unused).length > 0) update(unused)
  }, [settings, update])

  const select = (id: TabId) => update({ tab: id, ...resetSettings() })
  const onSearch = (text: string) => update({ search: text })

  return (
    <Tabs label="Suite data" tabs={TABS} selected={tab} onSelect={select}>
      {tab === 'runs' && <RunsTab schema={schema} search={search} onSearch={onSearch} />}
      {tab === 'machines' && <MachinesTab schema={schema} search={search} onSearch={onSearch} />}
      {tab === 'commits' && (
        <CommitsTab schema={schema} search={search} onSearch={onSearch} />
      )}
      {tab === 'regressions' && (
        <RegressionsTab
          schema={schema}
          search={search}
          onSearch={onSearch}
          filters={settings}
          onFilters={update}
        />
      )}
      {tab === 'schema' && (
        <SchemaTab
          schema={schema}
          onDeleted={onDeleted}
          onMoved={onMoved}
          focusEdit={focusEdit}
          onEditFocused={onEditFocused}
        />
      )}
    </Tabs>
  )
}
