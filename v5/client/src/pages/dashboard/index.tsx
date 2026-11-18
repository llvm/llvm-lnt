import { useId, useMemo } from 'react'
import { Link } from 'react-router'
import { useBranches, type BranchName } from '../../api/commits'
import {
  findSuite,
  fullName,
  refOf,
  useProjects,
  type Project,
  type Suite,
  type SuiteRef,
} from '../../api/suites'
import { useRecentlyActiveMachines } from '../../api/machines'
import { Loaded } from '../../components/feedback'
import { Select } from '../../components/select'
import { projectLabel, projectNamed, suiteLabel, type MachineNames } from '../../labels'
import { projectPath } from '../../paths'
import { isNumeric, type Metric } from '../../schema'
import { enumParam, stringParam, useDropUnusable, useUrlState } from '../../url-state'
import { suiteTabPath } from '../test-suites/settings'
import { branchOptions, hasNamedBranch, plottedBranch } from '../../branches'
import {
  branchOfCard,
  cardBranchParam,
  withBranchOfCard,
  type CardBranch,
} from './card-branches'
import { SparklineCard } from './sparkline-card'
import { MACHINES_SHOWN } from './sparkline'
import styles from './dashboard.module.css'

/** The commit ranges offered (DA1), as `last_n` values. */
const RANGES = ['100', '500', '1000'] as const

const PARAMS = {
  range: enumParam(RANGES, '500'),
  /** The project the page is narrowed to, by name, or every project when empty (DA1). */
  project: stringParam(),
  /** The cards showing another branch than their default (DA1). */
  branch: cardBranchParam(),
}

/** What the sections read and change of the cards' branches (DA1). */
interface CardBranches {
  entries: CardBranch[]
  update(entries: CardBranch[]): void
}

/** The `Project` dropdown's option for every project: no project name is empty (D7). */
const ALL_PROJECTS = { value: '', label: 'All projects' }

/**
 * The Dashboard (DA1): the trend of every metric each suite chooses to show, grouped by project,
 * or for one project alone.
 */
export default function Dashboard() {
  const [{ range, project, branch }, update] = useUrlState(PARAMS)
  const projects = useProjects()
  const { data } = projects
  const picked = data?.find((entry) => entry.name === project)
  // A project the list does not hold is dropped (AR2 "State"); every project is shown meanwhile.
  useDropUnusable(
    projects,
    (list) => project === '' || list.some((entry) => entry.name === project),
    () => update({ project: '' }),
  )
  // So is the branch of a card that no suite shows (DA1), whereas a card's suite drops the branches
  // its list does not hold (see `SuiteSection`).
  const shown = (list: Project[]) => {
    const suites = list.flatMap((entry) => entry.suites)
    return branch.filter(({ suite, metric }) =>
      dashboardMetrics(findSuite(suites, suite)).some((entry) => entry.name === metric),
    )
  }
  useDropUnusable(
    projects,
    (list) => shown(list).length === branch.length,
    () => update({ branch: shown(data!) }),
  )
  const branches: CardBranches = {
    entries: branch,
    update: (entries) => update({ branch: entries }),
  }
  // The projects the dropdown offers: until they are listed, the project of the URL, by its name
  // (AR22).
  const offered = data ?? (project === '' ? [] : [projectNamed(undefined, project)])
  const options = [
    ALL_PROJECTS,
    ...offered.map((entry) => ({ value: entry.name, label: projectLabel(entry) })),
  ]

  const content = (
    <Loaded
      data={data}
      error={projects.error}
      onRetry={() => void projects.refetch()}
      label="Loading projects..."
      context="The projects could not be loaded"
    >
      {(list) =>
        list.length === 0 ? (
          <p className={styles.note}>There are no projects yet.</p>
        ) : (
          // Only the sections shown are rendered, and so fetch their data (DA1). One list whichever
          // is shown, so that picking a project keeps its sections as they are.
          (picked ? [picked] : list).map((entry) => (
            <ProjectSection
              key={entry.name}
              project={entry}
              range={Number(range)}
              branches={branches}
            />
          ))
        )
      }
    </Loaded>
  )

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
 * suites on the Projects page, or that it has none.
 */
function ProjectSection({
  project,
  range,
  branches,
}: {
  project: Project
  range: number
  branches: CardBranches
}) {
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
          <SuiteSection
            key={fullName(refOf(schema))}
            schema={schema}
            range={range}
            branches={branches}
          />
        ))
      )}
    </section>
  )
}

/**
 * A suite's section (DA1): a card per metric the schema marks for the Dashboard, all over the same
 * machines, each on a branch of the suite's (DA2).
 */
function SuiteSection({
  schema,
  range,
  branches,
}: {
  schema: Suite
  range: number
  branches: CardBranches
}) {
  const suite = refOf(schema)
  const metrics = dashboardMetrics(schema)
  const machines = useRecentlyActiveMachines(suite, MACHINES_SHOWN, metrics.length > 0)
  const branchList = useBranches(suite, metrics.length > 0)
  const headingId = useId()

  // The branches are shown from any list, even one cached before the page was opened, but only one
  // listed since is current enough to drop the branch of a card that it does not hold, or that is
  // its default (DA1). A failed refetch drops nothing.
  const current = branchList.isSuccess && branchList.isFetchedAfterMount
  const kept = (list: BranchName[]) =>
    branches.entries.filter(
      (entry) => entry.suite !== suite || (list.includes(entry.branch) && entry.branch !== list[0]),
    )
  useDropUnusable(
    { data: current ? branchList.data : undefined, isSuccess: current },
    (list) => kept(list).length === branches.entries.length,
    () => branches.update(kept(branchList.data!)),
  )

  return (
    <section className={styles.suite} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.suiteHeading}>
        {suiteLabel(schema)}
      </h3>
      {metrics.length === 0 ? (
        <NoCards schema={schema} />
      ) : (
        <Loaded
          data={machines.data}
          error={machines.error}
          onRetry={() => void machines.refetch()}
          label="Loading machines..."
        >
          {(data) => (
            <SuiteCards
              schema={schema}
              suite={suite}
              metrics={metrics}
              machines={data}
              range={range}
              branchList={branchList}
              current={current}
              branches={branches}
            />
          )}
        </Loaded>
      )}
    </section>
  )
}

/** The metrics `schema` shows on the Dashboard, each on a card (DA1), if any. */
function dashboardMetrics(schema: Suite | undefined): Metric[] {
  return schema?.metrics.filter((metric) => metric.dashboard) ?? []
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
  suite: SuiteRef
  /** The metrics the suite shows on the Dashboard. */
  metrics: Metric[]
  machines: MachineNames[]
  range: number
  /** The suite's branches. */
  branchList: ReturnType<typeof useBranches>
  /** Whether they were listed since the page was opened. */
  current: boolean
  branches: CardBranches
}

/** The cards of a suite, or why there are none. */
function SuiteCards({ machines, branchList, ...props }: SuiteCardsProps) {
  if (machines.length === 0) return <p className={styles.note}>No tracked machine has runs yet.</p>
  return (
    <Loaded
      data={branchList.data}
      error={branchList.error}
      onRetry={() => void branchList.refetch()}
      label="Loading branches..."
      context="The branches could not be listed"
    >
      {(list) => <Cards {...props} machines={machines} branchList={branchList} list={list} />}
    </Loaded>
  )
}

/** The cards of a suite, once some list of its branches, `list`, is at hand (DA2). */
function Cards({
  schema,
  suite,
  metrics,
  machines,
  range,
  branchList,
  current,
  branches,
  list,
}: SuiteCardsProps & { list: BranchName[] }) {
  // The options of every card's branch selector, if it has one.
  const options = useMemo(() => (hasNamedBranch(list) ? branchOptions(list) : null), [list])
  const retry = () => void branchList.refetch()
  return (
    <div className={styles.grid}>
      {metrics.map((metric) => {
        const named = branchOfCard(branches.entries, suite, metric.name)
        // The branch the URL names, or the list's first entry. One that a list cached before the
        // page was opened does not hold waits for a current list, which may hold it.
        const branch =
          named === undefined || list.includes(named) || current
            ? plottedBranch(list, named ?? null)
            : undefined
        return (
          <SparklineCard
            key={metric.name}
            schema={schema}
            metric={metric}
            machines={machines}
            range={range}
            branch={branch}
            named={named}
            options={options}
            listingError={branchList.isError && !branchList.isFetching ? branchList.error : null}
            onRetryListing={retry}
            onBranch={(picked) => {
              // The default is left out of the URL (DA1).
              const entry = picked === (list[0] ?? null) ? undefined : picked!
              branches.update(withBranchOfCard(branches.entries, suite, metric.name, entry))
            }}
          />
        )
      })}
    </div>
  )
}
