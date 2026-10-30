import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
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
import { Alert, ErrorMessage, Loading } from '../../components/feedback'
import { Tabs } from '../../components/tabs'
import { useMounted } from '../../components/use-mounted'
import { projectLabel, suiteLabel } from '../../labels'
import { projectPath, PROJECTS_PATH, suitePath } from '../../paths'
import { useUrlState } from '../../url-state'
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

/** The Test Suites page (TS1): the suite picker, and the selected suite's tabs. */
export default function TestSuites() {
  const { project, suite } = useParams()
  const projects = useProjects()
  const shown = projects.data?.find((entry) => entry.name === project)
  const schema = shown?.suites.find((entry) => entry.name === suite)
  const named = project === undefined || suite === undefined ? undefined : suiteRef(project, suite)
  const notFound = useNotFoundFocus(named && fullName(named), schema !== undefined)

  let content
  // A list fetched again that fails leaves the one the page shows, and the tabs with it: an open
  // schema editor, say, which has the list fetched again when a save finds it out of date (TS7).
  if (projects.data === undefined) {
    content = projects.isError ? (
      <ErrorMessage error={projects.error} onRetry={() => void projects.refetch()} />
    ) : (
      <Loading label="Loading test suites..." />
    )
  } else if (project === undefined) {
    content =
      projects.data.length === 0 ? (
        <p className={styles.note}>There are no projects yet.</p>
      ) : (
        <SuitePicker projects={projects.data} />
      )
  } else if (shown === undefined) {
    content = <Alert>Project '{project}' not found.</Alert>
  } else {
    content = (
      <>
        <SuitePicker projects={[shown]} selected={suite} />
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
      <h1>Test Suites</h1>
      {/* Everywhere but on the list of every project (TS1). */}
      {project !== undefined && (
        <Link to={PROJECTS_PATH} className={styles.allProjects}>
          All projects
        </Link>
      )}
      {content}
    </section>
  )
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

/**
 * The suite picker (TS1): the suites of each of `projects`, under a heading with the project's
 * label, linking to the project's suites, each by its own label (AR22). A project without suites
 * says so.
 */
function SuitePicker({ projects, selected }: { projects: Project[]; selected?: string }) {
  return (
    <nav aria-label="Test suites">
      {projects.map((project) => (
        <ProjectSuites key={project.name} project={project} selected={selected} />
      ))}
    </nav>
  )
}

function ProjectSuites({ project, selected }: { project: Project; selected?: string }) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.projectHeading}>
        <Link to={projectPath(project.name)}>{projectLabel(project)}</Link>
      </h2>
      {project.suites.length === 0 ? (
        <p className={styles.note}>No test suites.</p>
      ) : (
        <div className={styles.suitePicker}>
          {project.suites.map((suite) => (
            <Link
              key={suite.name}
              to={suitePath(refOf(suite))}
              className={styles.suiteCard}
              aria-current={suite.name === selected ? 'page' : undefined}
            >
              {suiteLabel(suite)}
            </Link>
          ))}
        </div>
      )}
    </section>
  )
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

  // Once the suite is renamed or moved from its Schema tab, the page leaves for the Schema tab of the
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
  // dropped rather than shown if the history leads back to them, and "Rename or move" takes the
  // focus, as once its panel has closed. Only once: the state is taken out of the history entry,
  // so that a reload or Back does not do it again.
  const movedFrom = (location.state as Moved | null)?.movedFrom
  const [focusMove, setFocusMove] = useState(movedFrom !== undefined)
  useEffect(() => {
    if (movedFrom === undefined) return
    forgetUnobserved(queryClient, suiteOfFullName(movedFrom))
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null })
  }, [movedFrom, queryClient, navigate, location.pathname, location.search])
  const onMoveFocused = useCallback(() => setFocusMove(false), [])

  // Once the suite is deleted from its Schema tab, the page leaves for the project's suites, in place
  // of itself in the history, unless the user has left it meanwhile (TS6, AR16). Read first, since the suite
  // going from the list takes these tabs with it. The token is checked again, since its key may
  // have been restricted to the suite, which it no longer lists, so that a suite created later
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
          focusMove={focusMove}
          onMoveFocused={onMoveFocused}
        />
      )}
    </Tabs>
  )
}
