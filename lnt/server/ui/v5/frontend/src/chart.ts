import type { ComparisonRow } from './types';
import { CHART_ZOOM, CHART_HOVER } from './events';
import { getState } from './state';
import { el } from './utils';

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
  // Filter to plottable rows
  let plottable = rows.filter(r =>
    r.sidePresent === 'both' && r.ratio !== null && r.status !== 'na'
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
  const y = plottable.map(r => (r.ratio! - 1) * 100);  // percent change from unity

  // Colors by status
  const colors = plottable.map(r => {
    switch (r.status) {
      case 'improved': return '#2ca02c';
      case 'regressed': return '#d62728';
      case 'noise': return '#999999';
      default: return '#1f77b4';
    }
  });

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

export function renderChart(container: HTMLElement, rows: ComparisonRow[], preserveZoom = false): void {
  // If switching to a different container, reset event wiring
  if (chartContainer !== container) {
    wiredContainer = null;
  }
  chartContainer = container;
  chartData = rows;
  drawChart(preserveZoom ? lastFilterTests : null);
}

// Plotly event handlers — receive data directly via gd.on() API
function onPlotlyRelayout(data: Record<string, unknown>): void {
  if (data && data['xaxis.range[0]'] !== undefined) {
    const lo = Math.max(0, Math.floor(data['xaxis.range[0]'] as number));
    const hi = Math.min(sortedTests.length - 1, Math.ceil(data['xaxis.range[1]'] as number));
    const visibleTests = new Set(sortedTests.slice(lo, hi + 1));
    document.dispatchEvent(new CustomEvent(CHART_ZOOM, { detail: visibleTests }));
  } else if (data && (data['xaxis.autorange'] || data['autosize'])) {
    document.dispatchEvent(new CustomEvent(CHART_ZOOM, { detail: null }));
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

function drawChart(filterTests: Set<string> | null): void {
  if (!chartContainer) return;
  lastFilterTests = filterTests;

  const state = getState();
  const noiseThreshold = state.noise;

  // Apply text filter from state on top of chart zoom filter
  let effectiveFilter = filterTests;
  if (state.testFilter) {
    const lf = state.testFilter.toLowerCase();
    const textMatches = new Set<string>();
    for (const r of chartData) {
      if (r.test.toLowerCase().includes(lf)) textMatches.add(r.test);
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

  // Noise band shapes + unity line (at y=0 = no change)
  const shapes = [
    // Noise band lower
    {
      type: 'line' as const,
      x0: -0.5, x1: sortedTests.length - 0.5,
      y0: -noiseThreshold, y1: -noiseThreshold,
      xref: 'x' as const, yref: 'y' as const,
      line: { color: '#aaa', width: 1, dash: 'dash' as const },
    },
    // Noise band upper
    {
      type: 'line' as const,
      x0: -0.5, x1: sortedTests.length - 0.5,
      y0: noiseThreshold, y1: noiseThreshold,
      xref: 'x' as const, yref: 'y' as const,
      line: { color: '#aaa', width: 1, dash: 'dash' as const },
    },
  ];

  const layout: Record<string, unknown> = {
    xaxis: {
      title: { text: 'Tests (sorted by ratio)' },
      showticklabels: false,
    },
    yaxis: {
      title: { text: 'Change from baseline (%)', standoff: 15 },
      ticksuffix: '%',
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
      }
    }
  }

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
}
