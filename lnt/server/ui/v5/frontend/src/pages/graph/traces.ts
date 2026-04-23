// pages/graph/traces.ts — Pure functions for building chart-ready structures.
// Transforms cached data points into TimeSeriesTrace[], PinnedBaseline[], and
// ChartOverlays. No state, no DOM, no side effects.

import type { AggFn, QueryDataPoint, RegressionListItem } from '../../types';
import type { TimeSeriesTrace, PinnedBaseline, ChartOverlays } from './time-series-chart';
import { getAggFn, machineColor, TRACE_SEP } from '../../utils';

// ---- Symbol constants ----

/** Plotly marker symbols for machine differentiation. */
export const MACHINE_SYMBOLS = [
  'circle', 'triangle-up', 'square', 'diamond', 'x',
  'cross', 'star', 'pentagon', 'hexagon', 'hexagram',
];

/** Unicode characters matching MACHINE_SYMBOLS for display in chips and legend. */
export const SYMBOL_CHARS = ['●', '▲', '■', '◆', '✕', '+', '★', '⬠', '⬡', '✡'];

export function assignSymbol(machineIndex: number): string {
  return MACHINE_SYMBOLS[machineIndex % MACHINE_SYMBOLS.length];
}

export function assignSymbolChar(machineIndex: number): string {
  return SYMBOL_CHARS[machineIndex % SYMBOL_CHARS.length];
}

// ---- Color assignment ----

/** Build a stable color map from the FULL unfiltered test list.
 *  Colors are assigned by alphabetical position so they don't shift
 *  when the test filter changes. */
export function buildColorMap(allDiscoveredTests: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < allDiscoveredTests.length; i++) {
    map.set(allDiscoveredTests[i], machineColor(i));
  }
  return map;
}

// ---- Trace building ----

/**
 * Group data points by test and commit, apply two-level aggregation
 * (sample within run, then run across runs), and return one trace per test.
 *
 * The `machine` field on each trace is set to '' — the caller assigns it.
 */
export function buildTraces(
  points: QueryDataPoint[],
  runAgg: AggFn,
  sampleAgg: AggFn,
): TimeSeriesTrace[] {
  const testMap = new Map<string, QueryDataPoint[]>();
  for (const pt of points) {
    let arr = testMap.get(pt.test);
    if (!arr) { arr = []; testMap.set(pt.test, arr); }
    arr.push(pt);
  }

  const runAggFn = getAggFn(runAgg);
  const sampleAggFn = getAggFn(sampleAgg);
  const traces: TimeSeriesTrace[] = [];

  for (const [testName, testPoints] of testMap) {
    const commitMap = new Map<string, QueryDataPoint[]>();
    for (const pt of testPoints) {
      let arr = commitMap.get(pt.commit);
      if (!arr) { arr = []; commitMap.set(pt.commit, arr); }
      arr.push(pt);
    }

    const tracePoints: TimeSeriesTrace['points'] = [];
    for (const [commitValue, commitPoints] of commitMap) {
      // Step 1: group by run_uuid
      const byRun = new Map<string, number[]>();
      for (const pt of commitPoints) {
        let arr = byRun.get(pt.run_uuid);
        if (!arr) { arr = []; byRun.set(pt.run_uuid, arr); }
        arr.push(pt.value);
      }
      // Step 2: aggregate samples within each run
      const perRunValues = [...byRun.values()].map(v => sampleAggFn(v));
      // Step 3: aggregate across runs
      tracePoints.push({
        commit: commitValue,
        value: runAggFn(perRunValues),
        runCount: byRun.size,
        submitted_at: commitPoints[0].submitted_at,
      });
    }

    traces.push({ testName, machine: '', points: tracePoints });
  }

  traces.sort((a, b) => a.testName.localeCompare(b.testName));
  return traces;
}

// ---- Chart data orchestration ----

export interface BuildChartDataOpts {
  selectedTests: Set<string>;
  machines: string[];
  metric: string;
  runAgg: AggFn;
  sampleAgg: AggFn;
  /** Sync reader for cached data points. */
  readCachedTestData: (suite: string, machine: string, metric: string, test: string) => QueryDataPoint[];
  suite: string;
  /** Pre-built color map (from buildColorMap). */
  colorMap: Map<string, string>;
}

/**
 * Build all traces across machines with color and symbol assignment.
 * Returns traces plus an indexed map for O(1) raw-values hover lookup.
 */
export function buildChartData(opts: BuildChartDataOpts): {
  traces: TimeSeriesTrace[];
  rawValuesIndex: Map<string, number[]>;
} {
  const colorMap = opts.colorMap;
  const allTraces: TimeSeriesTrace[] = [];
  const rawValuesIndex = new Map<string, number[]>();

  const selectedSorted = [...opts.selectedTests].sort((a, b) => a.localeCompare(b));

  for (let mi = 0; mi < opts.machines.length; mi++) {
    const m = opts.machines[mi];
    const symbol = assignSymbol(mi);

    for (const testName of selectedSorted) {
      const points = opts.readCachedTestData(opts.suite, m, opts.metric, testName);
      if (points.length === 0) continue;

      // Build raw values index for hover scatter
      for (const pt of points) {
        const key = `${pt.test}|${m}|${pt.commit}`;
        let arr = rawValuesIndex.get(key);
        if (!arr) { arr = []; rawValuesIndex.set(key, arr); }
        arr.push(pt.value);
      }

      const machineTraces = buildTraces(points, opts.runAgg, opts.sampleAgg);
      for (const t of machineTraces) {
        allTraces.push({
          ...t,
          machine: m,
          color: colorMap.get(t.testName),
          markerSymbol: symbol,
        });
      }
    }
  }

  allTraces.sort((a, b) =>
    `${a.testName}${TRACE_SEP}${a.machine}`.localeCompare(`${b.testName}${TRACE_SEP}${b.machine}`));

  return { traces: allTraces, rawValuesIndex };
}

/**
 * Build a getRawValues callback from the index. Used by the chart's
 * hover scatter feature.
 */
export function buildRawValuesCallback(
  rawValuesIndex: Map<string, number[]>,
): (testName: string, machine: string, commit: string) => number[] {
  return (testName, machine, commit) => {
    return rawValuesIndex.get(`${testName}|${machine}|${commit}`) ?? [];
  };
}

// ---- Baseline building ----

/**
 * Build baseline reference lines from cached data.
 */
export function buildBaselinesFromData(
  baselines: Array<{ suite: string; machine: string; commit: string }>,
  getPoints: (suite: string, machine: string, commit: string, metric: string) => QueryDataPoint[],
  metric: string,
  aggFn: (values: number[]) => number,
  displayMap?: Map<string, string>,
): PinnedBaseline[] {
  return baselines.map((bl) => {
    const points = getPoints(bl.suite, bl.machine, bl.commit, metric);

    const rawPerTest = new Map<string, number[]>();
    for (const pt of points) {
      let arr = rawPerTest.get(pt.test);
      if (!arr) { arr = []; rawPerTest.set(pt.test, arr); }
      arr.push(pt.value);
    }

    const values = new Map<string, number>();
    for (const [test, raw] of rawPerTest) {
      values.set(test, aggFn(raw));
    }

    const commitDisplay = displayMap?.get(bl.commit) ?? bl.commit;
    const label = `${bl.suite}/${bl.machine}/${commitDisplay}`;

    return { label, values };
  });
}

// ---- Regression overlays ----

/**
 * Build Plotly shapes + annotations for regression markers.
 * Vertical dashed lines color-coded by state.
 */
export function buildRegressionOverlays(
  regressions: RegressionListItem[],
  displayMap: Map<string, string>,
): ChartOverlays {
  const shapes: unknown[] = [];
  const annotations: unknown[] = [];

  for (const r of regressions) {
    if (!r.commit) continue;

    const xVal = displayMap.get(r.commit) ?? r.commit;
    const color = r.state === 'active' ? '#d62728'
               : r.state === 'detected' ? '#ff7f0e'
               : '#999';

    shapes.push({
      type: 'line',
      x0: xVal,
      x1: xVal,
      y0: 0,
      y1: 1,
      yref: 'paper',
      line: { color, width: 1.5, dash: 'dash' },
    });

    annotations.push({
      x: xVal,
      y: 1,
      yref: 'paper',
      text: r.title || 'Regression',
      showarrow: false,
      font: { size: 10, color },
      yanchor: 'bottom',
      captureevents: true,
    });
  }

  return { shapes, annotations };
}
