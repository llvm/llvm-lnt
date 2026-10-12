/**
 * The points of a trace (GR1): one test on one machine, a point per commit, computed from the
 * measurements `POST /query` returns, apart from the chart that draws them.
 */

import { aggregate, type Aggregation } from '../../aggregation'
import type { Measurement } from '../../api/series'

/** A trace's value at one commit. */
export interface Point {
  commit: string
  /** The commit's position on the x-axis (GR3). */
  position: number
  value: number
  /** How many runs the value combines. */
  runs: number
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
  // Each commit's samples, by run.
  const commits = new Map<string, Map<string, number[]>>()
  for (const { commit, run, value } of measurements) {
    if (!positions.has(commit)) continue
    let runs = commits.get(commit)
    if (runs === undefined) commits.set(commit, (runs = new Map()))
    const samples = runs.get(run)
    if (samples === undefined) runs.set(run, [value])
    else samples.push(value)
  }
  const points: Point[] = []
  for (const [commit, runs] of commits) {
    const perRun = [...runs.values()].map((samples) => aggregate(samples, sampleAgg))
    points.push({
      commit,
      position: positions.get(commit)!,
      value: aggregate(perRun, runAgg),
      runs: runs.size,
    })
  }
  return points.sort((a, b) => a.position - b.position)
}
