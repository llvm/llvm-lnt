import { useId } from 'react'
import { Link } from 'react-router'
import { fullName, refOf, useProjects, type Project, type Suite } from '../../api/suites'
import { useRecentlyActiveMachines } from '../../api/machines'
import { ErrorMessage, Loaded, Loading } from '../../components/feedback'
import { Select } from '../../components/select'
import { projectLabel, projectNamed, suiteLabel } from '../../labels'
import { projectPath } from '../../paths'
import { isNumeric, type Metric } from '../../schema'
import { enumParam, stringParam, useDropUnusable, useUrlState } from '../../url-state'
import { suiteTabPath } from '../test-suites/settings'
import { SparklineCard } from './sparkline-card'
import { MACHINES_SHOWN } from './sparkline'
import styles from './dashboard.module.css'

/** The commit ranges offered (DA1), as `last_n` values. */
const RANGES = ['100', '500', '1000'] as const

const PARAMS = {
  range: enumParam(RANGES, '500'),
  /** The project the page is narrowed to, by name, or every project when empty (DA1). */
  project: stringParam(),
}

/** The `Project` dropdown's option for every project: no project name is empty (D7). */
const ALL_PROJECTS = { value: '', label: 'All projects' }

/**
 * The Dashboard (DA1): the trend of every metric each suite chooses to show, grouped by project,
 * or for one project alone.
 */
export default function Dashboard() {
  const [{ range, project }, update] = useUrlState(PARAMS)
  const projects = useProjects()
  const { data } = projects
  const picked = data?.find((entry) => entry.name === project)
  // A project the list does not hold is dropped (AR2 "State"); every project is shown meanwhile.
  useDropUnusable(
    projects,
    (list) => project === '' || list.some((entry) => entry.name === project),
    () => update({ project: '' }),
  )
  // The projects the dropdown offers: until they are listed, the project of the URL, by its name
  // (AR22).
  const offered = data ?? (project === '' ? [] : [projectNamed(undefined, project)])
  const options = [
    ALL_PROJECTS,
    ...offered.map((entry) => ({ value: entry.name, label: projectLabel(entry) })),
  ]

  let content
  // Unlike `Loaded`, a list fetched again that fails leaves the one the page shows, as on the Test
  // Suites page (TS1): only the list's first load takes the page's place.
  if (data === undefined) {
    content = projects.isError ? (
      <ErrorMessage
        context="The projects could not be loaded"
        error={projects.error}
        onRetry={() => void projects.refetch()}
      />
    ) : (
      <Loading label="Loading projects..." />
    )
  } else if (data.length === 0) {
    content = <p className={styles.note}>There are no projects yet.</p>
  } else {
    // Only the sections shown are rendered, and so fetch their data (DA1). One list whichever is
    // shown, so that picking a project keeps its sections as they are.
    content = (picked ? [picked] : data).map((entry) => (
      <ProjectSection key={entry.name} project={entry} range={Number(range)} />
    ))
  }

  return (
    <section>
      <header className={styles.header}>
        <h1>Dashboard</h1>
        <div className={styles.controls}>
          <Select
            label="Project"
            options={options}
            value={data === undefined || picked ? project : ''}
            onChange={(value) => update({ project: value })}
            isDisabled={data === undefined}
          />
          <div className={styles.ranges} role="group" aria-label="Commit range">
            {RANGES.map((value) => (
              <button
                key={value}
                type="button"
                className={styles.range}
                aria-pressed={value === range}
                onClick={() => update({ range: value })}
              >
                Last {value}
              </button>
            ))}
          </div>
        </div>
      </header>
      {content}
    </section>
  )
}

/**
 * A project's section (DA1): its suites' sections, under a heading with its label linking to its
 * suites on the Test Suites page, or that it has none.
 */
function ProjectSection({ project, range }: { project: Project; range: number }) {
  const headingId = useId()
  return (
    <section className={styles.project} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.projectHeading}>
        <Link to={projectPath(project.name)}>{projectLabel(project)}</Link>
      </h2>
      {project.suites.length === 0 ? (
        <p className={styles.note}>No test suites.</p>
      ) : (
        project.suites.map((schema) => (
          <SuiteSection key={fullName(refOf(schema))} schema={schema} range={range} />
        ))
      )}
    </section>
  )
}

/**
 * A suite's section (DA1): a card per metric the schema marks for the Dashboard, all over the same
 * machines (DA2).
 */
function SuiteSection({ schema, range }: { schema: Suite; range: number }) {
  const metrics = schema.metrics.filter((metric) => metric.dashboard)
  const machines = useRecentlyActiveMachines(refOf(schema), MACHINES_SHOWN, metrics.length > 0)
  const headingId = useId()

  return (
    <section className={styles.suite} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.suiteHeading}>
        {suiteLabel(schema)}
      </h3>
      {metrics.length === 0 ? (
        <NoCards schema={schema} />
      ) : (
        <Loaded
          isPending={machines.isPending}
          error={machines.error}
          onRetry={() => void machines.refetch()}
          label="Loading machines..."
        >
          {machines.data && (
            <SuiteCards schema={schema} metrics={metrics} machines={machines.data} range={range} />
          )}
        </Loaded>
      )}
    </section>
  )
}

/** Why a suite has no card (DA1): it has nothing to chart, or charts nothing it has. */
function NoCards({ schema }: { schema: Suite }) {
  if (!schema.metrics.some(isNumeric)) {
    return <p className={styles.note}>This suite has no numeric metrics.</p>
  }
  return (
    <p className={styles.note}>
      This suite shows no metrics on the Dashboard. Choose which ones to show in{' '}
      <Link to={suiteTabPath(refOf(schema), 'schema')}>its schema</Link>.
    </p>
  )
}

interface SuiteCardsProps {
  schema: Suite
  /** The metrics the suite shows on the Dashboard. */
  metrics: Metric[]
  machines: string[]
  range: number
}

/** The cards of a suite, or why there are none. */
function SuiteCards({ schema, metrics, machines, range }: SuiteCardsProps) {
  if (machines.length === 0) return <p className={styles.note}>No tracked machine has runs yet.</p>
  return (
    <div className={styles.grid}>
      {metrics.map((metric) => (
        <SparklineCard
          key={metric.name}
          schema={schema}
          metric={metric}
          machines={machines}
          range={range}
        />
      ))}
    </div>
  )
}
