import { useId } from 'react'
import { useSuites, type SuiteSchema } from '../../api/suites'
import { useRecentlyActiveMachines } from '../../api/machines'
import { Loaded } from '../../components/feedback'
import { isNumeric, type Metric } from '../../schema'
import { enumParam, useUrlState } from '../../url-state'
import { SparklineCard } from './sparkline-card'
import { MACHINES_SHOWN } from './sparkline'
import styles from './dashboard.module.css'

/** The commit ranges offered (DA1), as `last_n` values. */
const RANGES = ['100', '500', '1000'] as const

const PARAMS = { range: enumParam(RANGES, '500') }

/** The Dashboard (DA1): the trend of every numeric metric of every suite. */
export default function Dashboard() {
  const [{ range }, update] = useUrlState(PARAMS)
  const suites = useSuites()

  return (
    <section>
      <header className={styles.header}>
        <h1>Dashboard</h1>
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
      </header>
      <Loaded
        isPending={suites.isPending}
        error={suites.error}
        onRetry={() => void suites.refetch()}
        label="Loading test suites..."
      >
        {suites.data?.length === 0 ? (
          <p className={styles.note}>There are no test suites yet.</p>
        ) : (
          suites.data?.map((schema) => (
            <SuiteSection key={schema.name} schema={schema} range={Number(range)} />
          ))
        )}
      </Loaded>
    </section>
  )
}

/** A suite's section (DA1): a card per numeric metric, all over the same machines (DA2). */
function SuiteSection({ schema, range }: { schema: SuiteSchema; range: number }) {
  const metrics = schema.metrics.filter(isNumeric)
  const machines = useRecentlyActiveMachines(schema.name, MACHINES_SHOWN, metrics.length > 0)
  const headingId = useId()

  return (
    <section className={styles.suite} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.suiteHeading}>
        {schema.name}
      </h2>
      {metrics.length === 0 ? (
        <p className={styles.note}>This suite has no numeric metrics.</p>
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

interface SuiteCardsProps {
  schema: SuiteSchema
  /** The suite's numeric metrics. */
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
