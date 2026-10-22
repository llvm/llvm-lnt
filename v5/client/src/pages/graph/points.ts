/**
 * The points of a trace (GR1): one test on one machine, a point per commit, computed from the
 * measurements `GET /series` returns, apart from the chart that draws them.
 */

import { aggregate, type Aggregation } from '../../aggregation'
import type { Measurement } from '../../api/series'
import type { RunSamples } from '../../components/run-samples-table'

/** A trace's value at one commit. */
export interface Point {
  commit: string
  /** The commit's position on the x-axis (GR3). */
  position: number
  value: number
  /** How many runs the value combines. */
  runs: number
}

/** One run's value: its samples, combined by the sample aggregation (GR1). */
export interface RunValue {
  /** The run's UUID. */
  run: string
  /** When the run was measured. */
  measured: string
  value: number
}

/** The samples of each run among `measurements` (GR1). */
export function runSamples(measurements: Iterable<Measurement>): RunSamples[] {
  const runs = new Map<string, RunSamples>()
  for (const { run, measured, value } of measurements) {
    const known = runs.get(run)
    if (known === undefined) runs.set(run, { run, measured, samples: [value] })
    else known.samples.push(value)
  }
  return [...runs.values()]
}

/** The value of each run among `measurements`, its samples combined by `sampleAgg`. */
export function runValues(
  measurements: Iterable<Measurement>,
  sampleAgg: Aggregation,
): RunValue[] {
  return runSamples(measurements).map(({ run, measured, samples }) => ({
    run,
    measured,
    value: aggregate(samples, sampleAgg),
  }))
}

/** The value of `runs`, one or more, combined by `runAgg` (GR1). */
export function combineRuns(runs: readonly RunValue[], runAgg: Aggregation): number {
  return aggregate(
    runs.map((run) => run.value),
    runAgg,
  )
}

/**
 * The points of a trace measured by `measurements`, in the order of the x-axis: at each commit
 * `positions` places, each run's samples combined by `sampleAgg`, then the runs by `runAgg` (GR1).
 * A commit that is not on the x-axis has no position, and no point (GR3).
 */
export function pointsOf(
  measurements: Iterable<Measurement>,
  positions: ReadonlyMap<string, number>,
  sampleAgg: Aggregation,
  runAgg: Aggregation,
): Point[] {
  const commits = new Map<string, Measurement[]>()
  for (const measurement of measurements) {
    if (!positions.has(measurement.commit)) continue
    const known = commits.get(measurement.commit)
    if (known === undefined) commits.set(measurement.commit, [measurement])
    else known.push(measurement)
  }
  const points: Point[] = []
  for (const [commit, measured] of commits) {
    const runs = runValues(measured, sampleAgg)
    points.push({
      commit,
      position: positions.get(commit)!,
      value: combineRuns(runs, runAgg),
      runs: runs.length,
    })
  }
  return points.sort((a, b) => a.position - b.position)
}
