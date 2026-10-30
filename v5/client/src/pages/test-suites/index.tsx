import { useEffect, useLayoutEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router'
import { removeSuite, useSuites, type SuiteSchema } from '../../api/suites'
import { useAuth } from '../../auth/use-auth'
import { Alert, ErrorMessage, Loading } from '../../components/feedback'
import { Tabs } from '../../components/tabs'
import { useMounted } from '../../components/use-mounted'
import { suiteLabel } from '../../labels'
import { suitePath } from '../../paths'
import { useUrlState } from '../../url-state'
import { CommitsTab } from './commits-tab'
import { MachinesTab } from './machines-tab'
import { RegressionsTab } from './regressions-tab'
import { RunsTab } from './runs-tab'
import { SchemaTab } from './schema-tab'
import { PARAMS, TABS, resetSettings, unusedSettings, type TabId } from './settings'
import styles from './test-suites.module.css'

/** The Test Suites page (TS1): the suite picker, and the selected suite's tabs. */
export default function TestSuites() {
  const { suite } = useParams()
  const { search } = useLocation()
  const suites = useSuites()
  const schema = suites.data?.find((entry) => entry.name === suite)
  const notFound = useNotFoundFocus(suite, schema !== undefined)

  let content
  // A list fetched again that fails leaves the one the page shows, and the tabs with it: an open
  // schema editor, say, which has the list fetched again when a save finds it out of date (TS7).
  if (suites.data === undefined) {
    content = suites.isError ? (
      <ErrorMessage error={suites.error} onRetry={() => void suites.refetch()} />
    ) : (
      <Loading label="Loading test suites..." />
    )
  } else if (suite === undefined) {
    // `/suites` gives way to the first suite, which takes its place in the history (TS1).
    const first = suites.data.at(0)
    content =
      first === undefined ? (
        <SuitePicker suites={suites.data} />
      ) : (
        <Navigate to={{ pathname: suitePath(first.name), search }} replace />
      )
  } else {
    content = (
      <>
        <SuitePicker suites={suites.data} selected={suite} />
        {schema === undefined ? (
          <Alert ref={notFound} tabIndex={-1}>
            Test suite '{suite}' not found.
          </Alert>
        ) : (
          <SuiteTabs key={suite} schema={schema} />
        )}
      </>
    )
  }

  return (
    <section>
      <h1>Test Suites</h1>
      {content}
    </section>
  )
}

/**
 * The ref of the message saying that `suite` was not found, which takes the focus when it replaces
 * the suite's tabs -- once the suite has gone from the list, deleted elsewhere -- if the focus went
 * with them, so that it is not left nowhere.
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

function SuitePicker({ suites, selected }: { suites: SuiteSchema[]; selected?: string }) {
  if (suites.length === 0) return <p className={styles.note}>There are no test suites yet.</p>
  return (
    <nav className={styles.suitePicker} aria-label="Test suites">
      {suites.map((suite) => (
        <Link
          key={suite.name}
          to={suitePath(suite.name)}
          className={styles.suiteCard}
          aria-current={suite.name === selected ? 'page' : undefined}
        >
          {suiteLabel(suite)}
        </Link>
      ))}
    </nav>
  )
}

function SuiteTabs({ schema }: { schema: SuiteSchema }) {
  const [settings, update] = useUrlState(PARAMS)
  const { tab, search } = settings
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { recheck } = useAuth()
  // Whether the user is still on the suite's page, whichever its tab: these tabs are its page.
  const mounted = useMounted()

  // Once the suite is deleted from its Schema tab, the page leaves for `/suites`, in place of itself
  // in the history, unless the user has left it meanwhile (TS6, AR16). Read first, since the suite
  // going from the list takes these tabs with it. The token is checked again, since its key may
  // have been restricted to the suite, which it no longer lists, so that a suite created later
  // under the name does not seem to be covered (AR17).
  const onDeleted = async () => {
    const leaving = mounted.current
    await removeSuite(queryClient, schema.name)
    recheck()
    if (leaving) navigate('/suites', { replace: true })
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
      {tab === 'schema' && <SchemaTab schema={schema} onDeleted={onDeleted} />}
    </Tabs>
  )
}
