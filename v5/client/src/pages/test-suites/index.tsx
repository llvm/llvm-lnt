import { useEffect } from 'react'
import { Link, useParams } from 'react-router'
import { useSuites, type SuiteSchema } from '../../api/suites'
import { Alert, ErrorMessage, Loading } from '../../components/feedback'
import { Tabs } from '../../components/tabs'
import { suitePath } from '../../paths'
import { useUrlState } from '../../url-state'
import { CommitsTab } from './commits-tab'
import { MachinesTab } from './machines-tab'
import { RegressionsTab } from './regressions-tab'
import { RunsTab } from './runs-tab'
import { PARAMS, TABS, resetSettings, unusedSettings, type TabId } from './settings'
import styles from './test-suites.module.css'

/** The Test Suites page (TS1): the suite picker, and the selected suite's tabs. */
export default function TestSuites() {
  const { suite } = useParams()
  const suites = useSuites()

  let content
  if (suites.isPending) {
    content = <Loading label="Loading test suites..." />
  } else if (suites.isError) {
    content = <ErrorMessage error={suites.error} />
  } else {
    const schema = suites.data.find((entry) => entry.name === suite)
    content = (
      <>
        <SuitePicker suites={suites.data} selected={suite} />
        {suite !== undefined &&
          (schema === undefined ? (
            <Alert>Test suite '{suite}' not found.</Alert>
          ) : (
            <SuiteTabs key={suite} schema={schema} />
          ))}
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

function SuitePicker({ suites, selected }: { suites: SuiteSchema[]; selected?: string }) {
  if (suites.length === 0) return <p className={styles.note}>There are no test suites yet.</p>
  return (
    <nav className={styles.suitePicker} aria-label="Test suites">
      {suites.map(({ name }) => (
        <Link
          key={name}
          to={suitePath(name)}
          className={styles.suiteCard}
          aria-current={name === selected ? 'page' : undefined}
        >
          {name}
        </Link>
      ))}
    </nav>
  )
}

function SuiteTabs({ schema }: { schema: SuiteSchema }) {
  const [settings, update] = useUrlState(PARAMS)
  const { tab, search } = settings

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
    </Tabs>
  )
}
