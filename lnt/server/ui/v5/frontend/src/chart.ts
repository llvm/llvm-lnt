import type { ComparisonRow } from './types';
import { CHART_ZOOM, CHART_HOVER } from './events';
import { getState } from './state';
import { el, STATUS_COLORS, matchesFilter } from './utils';

/** Candidate "nice" percentage values for the positive side (B > A). */
const NICE_PCTS_POS = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50,
  100, 200, 500, 1000, 2000, 5000, 10000, 50000,
];
/** Candidate "nice" percentage values for the negative side (B < A, all < 100). */
const NICE_PCTS_NEG = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 75, 90, 95, 99,
];

function formatNicePct(p: number): string {
  if (p >= 1000 && p === Math.floor(p)) {
    return p.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '%';
  }
  return p + '%';
}

/** Precomputed tick candidates — log₂ positions and labels for all nice percentages. */
const TICK_CANDIDATES: ReadonlyArray<{ pos: number; label: string }> = [
  { pos: 0, label: '0%' },
  ...NICE_PCTS_POS.map(p => ({ pos: Math.log2(1 + p / 100), label: '+' + formatNicePct(p) })),
  ...NICE_PCTS_NEG.map(p => ({ pos: Math.log2(1 - p / 100), label: '\u2212' + formatNicePct(p) })),
];

/**
 * Generate "nice" tick values and labels for the log₂(ratio) y-axis.
 * Ticks are placed at log₂ positions corresponding to nice percentage values,
 * auto-adapting to the data range. For small ranges you get ±1%, ±2%, ±5%;
 * for large ranges you get ±50%, ±100%, ±500%, etc.
 */
export function generateChartTicks(
  yMin: number, yMax: number,
): { tickvals: number[]; ticktext: string[] } {
  // Filter precomputed candidates to data range with slight padding
  const pad = Math.max((yMax - yMin) * 0.05, 0.001);
  const inRange = TICK_CANDIDATES
    .filter(c => c.pos >= yMin - pad && c.pos <= yMax + pad && Number.isFinite(c.pos))
    .sort((a, b) => a.pos - b.pos);

  if (inRange.length === 0) {
    return { tickvals: [0], ticktext: ['0%'] };
  }

  // Thin to ~10 ticks with even visual spacing if too many
  const MAX_TICKS = 10;
  let ticks = inRange;
  if (inRange.length > MAX_TICKS) {
    // Keep 0% always; select remaining at evenly-spaced log₂ target positions
    const zero = inRange.find(c => c.pos === 0);
    const others = inRange.filter(c => c.pos !== 0);
    const targetCount = Math.min(others.length, zero ? MAX_TICKS - 1 : MAX_TICKS);

    const posMin = others[0].pos;
    const posMax = others[others.length - 1].pos;
    const step = targetCount > 1 ? (posMax - posMin) / (targetCount - 1) : 0;

    const selected: Array<{ pos: number; label: string }> = [];
    const used = new Set<number>();
    for (let i = 0; i < targetCount; i++) {
      const target = posMin + i * step;
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let j = 0; j < others.length; j++) {
        if (used.has(j)) continue;
        const dist = Math.abs(others[j].pos - target);
        if (dist < bestDist) { bestDist = dist; bestIdx = j; }
      }
      if (bestIdx >= 0) {
        used.add(bestIdx);
        selected.push(others[bestIdx]);
      }
    }

    if (zero) selected.push(zero);
    selected.sort((a, b) => a.pos - b.pos);
    ticks = selected;
  }

  // Enforce minimum visual gap so tick labels don't overlap.
  // Walk left-to-right, keeping a tick only if it's far enough from the last
  // kept tick. Always prefer 0% when it competes with a neighbor.
  const range = yMax - yMin || 0.01;
  const minGap = range * 0.06;
  const spaced: Array<{ pos: number; label: string }> = [ticks[0]];
  for (let i = 1; i < ticks.length; i++) {
    const prev = spaced[spaced.length - 1];
    if (ticks[i].pos - prev.pos >= minGap) {
      spaced.push(ticks[i]);
    } else if (ticks[i].pos === 0) {
      // 0% wins over its neighbor
      spaced[spaced.length - 1] = ticks[i];
    }
  }

  return { tickvals: spaced.map(c => c.pos), ticktext: spaced.map(c => c.label) };
}

export interface ChartData {
  sortedTests: string[];
  x: number[];
  y: number[];
  colors: string[];
  customdata: string[][];
}

/**
 * Prepare chart data from comparison rows.
 * Filters, sorts, and maps rows into Plotly-ready arrays.
 * Returns null if no plottable data remains after filtering.
 */
export function prepareChartData(
  rows: ComparisonRow[],
  filterTests: Set<string> | null,
): ChartData | null {
  // Filter to plottable rows (ratio must be positive for log₂)
  let plottable = rows.filter(r =>
    r.sidePresent === 'both' && r.ratio !== null && r.ratio > 0 && r.status !== 'na'
  );

  if (filterTests) {
    plottable = plottable.filter(r => filterTests.has(r.test));
  }

  if (plottable.length === 0) {
    return null;
  }

  // Sort by ratio ascending
  plottable.sort((a, b) => (a.ratio ?? 0) - (b.ratio ?? 0));
  const sortedTests = plottable.map(r => r.test);

  const x = plottable.map((_, i) => i);
  const y = plottable.map(r => Math.log2(r.ratio!));  // log₂ scale: symmetric for equal multiplicative changes

  // Colors by status
  const colors = plottable.map(r =>
    STATUS_COLORS[r.status] ?? '#1f77b4',
  );

  const customdata = plottable.map(r => [
    r.test,
    r.valueA !== null ? r.valueA.toPrecision(4) : 'N/A',
    r.valueB !== null ? r.valueB.toPrecision(4) : 'N/A',
    r.deltaPct !== null ? `${r.deltaPct > 0 ? '+' : ''}${r.deltaPct.toFixed(2)}%` : 'N/A',
    r.ratio !== null ? r.ratio.toFixed(4) : 'N/A',
  ]);

  return { sortedTests, x, y, colors, customdata };
}

declare const Plotly: {
  newPlot(el: HTMLElement, data: unknown[], layout: unknown, config?: unknown): Promise<HTMLElement>;
  react(el: HTMLElement, data: unknown[], layout: unknown, config?: unknown): Promise<HTMLElement>;
  relayout(el: HTMLElement, update: Record<string, unknown>): Promise<void>;
  purge(el: HTMLElement): void;
  Fx: {
    hover(el: HTMLElement, data: Array<{ curveNumber: number; pointNumber: number }>): void;
    unhover(el: HTMLElement): void;
  };
};

let chartContainer: HTMLElement | null = null;
let chartData: ComparisonRow[] = [];
let sortedTests: string[] = [];  // test names in chart order
let wiredContainer: HTMLElement | null = null;  // track which container has listeners
/** Last zoom filter passed to drawChart, preserved for refreshChart(). */
let lastFilterTests: Set<string> | null = null;
/** Guard flag to prevent infinite loop when we call Plotly.relayout() to update ticks. */
let updatingTicks = false;
/** Full data y-range, used to restore ticks on double-click autorange reset. */
let dataYMin = 0;
let dataYMax = 0;

export function renderChart(container: HTMLElement, rows: ComparisonRow[], preserveZoom = false, preFilteredTests?: Set<string> | null): void {
  // If switching to a different container, reset event wiring
  if (chartContainer !== container) {
    wiredContainer = null;
  }
  chartContainer = container;
  chartData = rows;
  drawChart(preserveZoom ? lastFilterTests : null, preFilteredTests);
}

// Plotly event handlers — receive data directly via gd.on() API
function onPlotlyRelayout(data: Record<string, unknown>): void {
  // X-axis zoom → dispatch CHART_ZOOM to sync table filtering
  if (data && data['xaxis.range[0]'] !== undefined) {
    const lo = Math.max(0, Math.floor(data['xaxis.range[0]'] as number));
    const hi = Math.min(sortedTests.length - 1, Math.ceil(data['xaxis.range[1]'] as number));
    const visibleTests = new Set(sortedTests.slice(lo, hi + 1));
    document.dispatchEvent(new CustomEvent(CHART_ZOOM, { detail: visibleTests }));
  } else if (data && (data['xaxis.autorange'] || data['autosize'])) {
    document.dispatchEvent(new CustomEvent(CHART_ZOOM, { detail: null }));
  }

  // Y-axis zoom → recompute tick labels for the new visible range
  if (updatingTicks || !chartContainer) return;

  let newYMin: number | undefined;
  let newYMax: number | undefined;
  if (data && data['yaxis.range[0]'] !== undefined) {
    newYMin = data['yaxis.range[0]'] as number;
    newYMax = data['yaxis.range[1]'] as number;
  } else if (data && data['yaxis.autorange']) {
    newYMin = dataYMin;
    newYMax = dataYMax;
  }

  if (newYMin !== undefined && newYMax !== undefined) {
    const { tickvals, ticktext } = generateChartTicks(newYMin, newYMax);
    updatingTicks = true;
    Plotly.relayout(chartContainer, {
      'yaxis.tickvals': tickvals,
      'yaxis.ticktext': ticktext,
    }).finally(() => { updatingTicks = false; });
  }
}

function onPlotlyHover(data: { points?: Array<{ pointIndex: number }> }): void {
  const points = data?.points;
  if (points && points.length > 0) {
    const testName = sortedTests[points[0].pointIndex];
    document.dispatchEvent(new CustomEvent(CHART_HOVER, { detail: testName }));
  }
}

function onPlotlyUnhover(): void {
  document.dispatchEvent(new CustomEvent(CHART_HOVER, { detail: null }));
}

function drawChart(filterTests: Set<string> | null, preFilteredTests?: Set<string> | null): void {
  if (!chartContainer) return;
  lastFilterTests = filterTests;

  const state = getState();

  // Apply text filter from state on top of chart zoom filter
  let effectiveFilter = filterTests;
  if (preFilteredTests) {
    if (effectiveFilter) {
      effectiveFilter = new Set([...effectiveFilter].filter(t => preFilteredTests.has(t)));
    } else {
      effectiveFilter = preFilteredTests;
    }
  } else if (state.testFilter) {
    const textMatches = new Set<string>();
    for (const r of chartData) {
      if (matchesFilter(r.test, state.testFilter)) textMatches.add(r.test);
    }
    if (effectiveFilter) {
      effectiveFilter = new Set([...effectiveFilter].filter(t => textMatches.has(t)));
    } else {
      effectiveFilter = textMatches;
    }
  }

  const prepared = prepareChartData(chartData, effectiveFilter);

  if (!prepared) {
    Plotly.purge(chartContainer);
    chartContainer.replaceChildren(el('p', { class: 'no-chart-data' }, 'No data to chart.'));
    sortedTests = [];
    wiredContainer = null;
    return;
  }

  sortedTests = prepared.sortedTests;
  const { x, y, colors, customdata } = prepared;

  const trace = {
    x, y,
    customdata,
    type: 'bar',
    marker: {
      color: colors,
      line: { color: '#fff', width: 0.5 },
    },
    hovertemplate:
      '<b>%{customdata[0]}</b><br>' +
      'Ratio: %{customdata[4]}<br>' +
      'Value A: %{customdata[1]}<br>' +
      'Value B: %{customdata[2]}<br>' +
      'Delta: %{customdata[3]}' +
      '<extra></extra>',
  };

  // Noise band shapes in log₂ space (only when Delta % knob is enabled).
  const shapes: Array<Record<string, unknown>> = [];
  if (state.noiseConfig.pct.enabled && state.noiseConfig.pct.value > 0) {
    const noiseFrac = state.noiseConfig.pct.value / 100;
    const noiseUpper = Math.log2(1 + noiseFrac);
    const noiseLower = noiseFrac < 1 ? Math.log2(1 - noiseFrac) : -noiseUpper;
    shapes.push(
      {
        type: 'line' as const,
        x0: -0.5, x1: sortedTests.length - 0.5,
        y0: noiseLower, y1: noiseLower,
        xref: 'x' as const, yref: 'y' as const,
        line: { color: '#aaa', width: 1, dash: 'dash' as const },
      },
      {
        type: 'line' as const,
        x0: -0.5, x1: sortedTests.length - 0.5,
        y0: noiseUpper, y1: noiseUpper,
        xref: 'x' as const, yref: 'y' as const,
        line: { color: '#aaa', width: 1, dash: 'dash' as const },
      },
    );
  }

  // Compute data y-range for tick generation and autorange restore.
  let yMin = 0, yMax = 0;
  for (const val of y) {
    if (val < yMin) yMin = val;
    if (val > yMax) yMax = val;
  }
  dataYMin = yMin;
  dataYMax = yMax;

  // Determine effective y-range for tick generation: use preserved zoom if active,
  // otherwise use full data range. Ticks are computed once for whichever range applies.
  let tickYMin = yMin;
  let tickYMax = yMax;

  const layout: Record<string, unknown> = {
    xaxis: {
      title: { text: 'Tests (sorted by ratio)' },
      showticklabels: false,
    },
    yaxis: {
      title: { text: 'Change from baseline (log scale)', standoff: 15 },
      zeroline: true,
      zerolinewidth: 2,
      zerolinecolor: '#333',
    },
    shapes,
    bargap: 0,
    margin: { t: 30, b: 50, l: 90, r: 20 },
    height: 400,
    hovermode: 'closest',
    dragmode: 'zoom',
  };

  // Preserve user zoom: read current axis ranges from the chart div
  // (set by Plotly on user drag-zoom) and apply them to the new layout.
  // If the user hasn't zoomed (autorange is true), don't set explicit
  // ranges so Plotly auto-fits to new data.
  if (wiredContainer === chartContainer) {
    const gd = chartContainer as unknown as { layout?: Record<string, Record<string, unknown>> };
    if (gd.layout) {
      const xa = gd.layout['xaxis'];
      const ya = gd.layout['yaxis'];
      if (xa && xa['autorange'] === false && xa['range']) {
        (layout['xaxis'] as Record<string, unknown>)['range'] = xa['range'];
        (layout['xaxis'] as Record<string, unknown>)['autorange'] = false;
      }
      if (ya && ya['autorange'] === false && ya['range']) {
        (layout['yaxis'] as Record<string, unknown>)['range'] = ya['range'];
        (layout['yaxis'] as Record<string, unknown>)['autorange'] = false;
        tickYMin = (ya['range'] as number[])[0];
        tickYMax = (ya['range'] as number[])[1];
      }
    }
  }

  const { tickvals, ticktext } = generateChartTicks(tickYMin, tickYMax);
  (layout['yaxis'] as Record<string, unknown>)['tickvals'] = tickvals;
  (layout['yaxis'] as Record<string, unknown>)['ticktext'] = ticktext;

  const config = {
    responsive: true,
    displayModeBar: true,
    modeBarButtonsToRemove: ['toImage', 'sendDataToCloud'],
    scrollZoom: true,
  };

  // If container was purged (no-data state), clear stale HTML before Plotly.react
  if (wiredContainer !== chartContainer) {
    chartContainer.replaceChildren();
  }

  Plotly.react(chartContainer, [trace], layout, config);

  // Wire events via Plotly's .on() API (added to the div by Plotly.react).
  // Purge removes .on() handlers, so re-register whenever wiredContainer is stale.
  if (wiredContainer !== chartContainer) {
    const gd = chartContainer as unknown as {
      on(event: string, handler: (...args: never[]) => void): void;
    };
    gd.on('plotly_relayout', onPlotlyRelayout);
    gd.on('plotly_hover', onPlotlyHover);
    gd.on('plotly_unhover', onPlotlyUnhover);
    wiredContainer = chartContainer;
  }
}

// External: highlight a point by test name
export function highlightPoint(testName: string | null): void {
  if (!chartContainer) return;
  if (!testName) {
    try { Plotly.Fx.unhover(chartContainer); } catch { /* chart may be purged */ }
    return;
  }
  const idx = sortedTests.indexOf(testName);
  if (idx >= 0) {
    Plotly.Fx.hover(chartContainer, [{ curveNumber: 0, pointNumber: idx }]);
  }
}

/** Purge the Plotly chart and reset module-level state. Call from page unmount. */
export function destroyChart(): void {
  if (chartContainer) {
    Plotly.purge(chartContainer);
  }
  chartContainer = null;
  chartData = [];
  sortedTests = [];
  wiredContainer = null;
  lastFilterTests = null;
  updatingTicks = false;
  dataYMin = 0;
  dataYMax = 0;
}
