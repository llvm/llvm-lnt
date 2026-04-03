// components/time-series-chart.ts — Plotly time-series line chart.

import { el, TRACE_SEP } from '../utils';
import { GRAPH_CHART_HOVER } from '../events';

/** Escape HTML special characters to prevent XSS in Plotly hover templates. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

declare const Plotly: {
  newPlot(el: HTMLElement, data: unknown[], layout: unknown, config?: unknown): Promise<HTMLElement>;
  react(el: HTMLElement, data: unknown[], layout: unknown, config?: unknown): Promise<HTMLElement>;
  addTraces(el: HTMLElement, traces: unknown | unknown[], index?: number): void;
  deleteTraces(el: HTMLElement, indices: number | number[]): void;
  relayout(el: HTMLElement, update: Record<string, unknown>): void;
  restyle(el: HTMLElement, update: Record<string, unknown>, traces?: number | number[]): void;
  purge(el: HTMLElement): void;
  Fx: {
    hover(gd: HTMLElement, data: Array<{ curveNumber: number; pointNumber: number }>): void;
    unhover(gd: HTMLElement): void;
  };
};

export interface TimeSeriesTrace {
  testName: string;
  /** Machine name for this trace. */
  machine: string;
  /** Explicit color for the trace line and markers. */
  color?: string;
  /** Plotly marker symbol (e.g., 'circle', 'triangle-up', 'square'). */
  markerSymbol?: string;
  points: Array<{
    orderValue: string;
    value: number;
    runCount: number;
    timestamp: string | null;
  }>;
}

export interface PinnedOrder {
  orderValue: string;
  tag: string | null;
  /** Per-test values at this reference order. */
  values: Map<string, number>;
  color: string;
}

export interface TimeSeriesChartOptions {
  traces: TimeSeriesTrace[];
  yAxisLabel: string;
  pinnedOrders?: PinnedOrder[];
  onClick?: (orderValue: string) => void;
  /** Fixed x-axis category order. When set, the x-axis shows exactly these
   *  categories in this order and does not resize as data loads progressively. */
  categoryOrder?: string[];
  /** Lazy callback to get individual pre-aggregation values for a data point.
   *  Called on hover; if it returns >1 values, a scatter of the raw values
   *  is shown at the hovered x-position. */
  getRawValues?: (testName: string, machine: string, orderValue: string) => number[];
}

/**
 * Build Plotly trace objects and layout from our domain types.
 * Exported for testing (data preparation logic).
 */
export function buildPlotlyData(options: TimeSeriesChartOptions): {
  data: unknown[];
  layout: unknown;
} {
  const data: unknown[] = [];

  // Collect all unique order values across all traces (for consistent x-axis)
  const allOrders: string[] = [];
  const orderSet = new Set<string>();
  for (const trace of options.traces) {
    for (const pt of trace.points) {
      if (!orderSet.has(pt.orderValue)) {
        orderSet.add(pt.orderValue);
        allOrders.push(pt.orderValue);
      }
    }
  }

  for (const trace of options.traces) {
    const x = trace.points.map(p => p.orderValue);
    const y = trace.points.map(p => p.value);
    const traceName = `${trace.testName}${TRACE_SEP}${trace.machine}`;
    const customdata = trace.points.map(p => [
      p.orderValue,
      traceName,
      p.value.toPrecision(4),
      String(p.runCount),
      trace.testName,
      trace.machine,
    ]);

    const marker: Record<string, unknown> = { size: 4 };
    if (trace.color) marker.color = trace.color;
    if (trace.markerSymbol) marker.symbol = trace.markerSymbol;

    const traceObj: Record<string, unknown> = {
      x,
      y,
      name: traceName,
      mode: 'lines+markers',
      type: 'scatter',
      marker,
      line: { width: 1.5, ...(trace.color ? { color: trace.color } : {}) },
      customdata,
      hovertemplate:
        '<b>%{customdata[4]}</b><br>' +
        'Machine: %{customdata[5]}<br>' +
        'Order: %{customdata[0]}<br>' +
        'Value: %{customdata[2]}<br>' +
        'Runs: %{customdata[3]}<extra></extra>',
    };

    data.push(traceObj);
  }

  // Reference order traces (horizontal dashed lines with hover tooltips).
  // These are actual Plotly traces (not shapes) so they support hover.
  // Each trace is populated with a data point at every x-category so that
  // hover detection works anywhere along the line (not just at 2 endpoints).
  if (options.pinnedOrders) {
    const pinXValues = options.categoryOrder ?? (allOrders.length > 0 ? allOrders : null);

    if (pinXValues) {
      for (const ref of options.pinnedOrders) {
        const label = ref.tag ? `${ref.orderValue} (${ref.tag})` : ref.orderValue;
        for (const [testName, value] of ref.values) {
          const trace = options.traces.find(t => t.testName === testName);
          if (!trace || trace.points.length === 0) continue;

          data.push({
            x: pinXValues,
            y: Array(pinXValues.length).fill(value),
            mode: 'lines',
            type: 'scatter',
            line: { color: ref.color, width: 1.5, dash: 'dot' },
            showlegend: false,
            hovertemplate:
              `<b>Pinned: ${escapeHtml(label)}</b><br>` +
              `Test: ${escapeHtml(testName)}<br>` +
              `Value: ${value.toPrecision(4)}<extra></extra>`,
          });
        }
      }
    }
  }

  const xaxis: Record<string, unknown> = {
    type: 'category',
    title: 'Order',
    tickangle: -45,
    automargin: true,
  };
  if (options.categoryOrder) {
    xaxis.categoryorder = 'array';
    xaxis.categoryarray = options.categoryOrder;
    // Lock the visible range to show all categories — autorange ignores null
    // y-values in the scaffold trace, so we must set the range explicitly.
    xaxis.autorange = false;
    xaxis.range = [-0.5, options.categoryOrder.length - 0.5];
  }

  // Overlay "No data to plot" when chart has a scaffold but no actual traces
  const annotations: unknown[] = [];
  if (options.traces.length === 0 && options.categoryOrder) {
    annotations.push({
      text: 'No data to plot.',
      xref: 'paper',
      yref: 'paper',
      x: 0.5,
      y: 0.5,
      showarrow: false,
      font: { size: 16, color: '#999' },
    });
  }

  const layout = {
    xaxis,
    yaxis: {
      title: options.yAxisLabel,
      automargin: true,
    },
    annotations,
    margin: { t: 30, r: 20 },
    hovermode: 'closest' as const,
    hoverdistance: 5,
    showlegend: false,
    autosize: true,
  };

  return { data, layout };
}

/**
 * Handle returned by createTimeSeriesChart for incremental updates.
 */
export interface ChartHandle {
  /** Update the chart with new options using Plotly.react() (preserves zoom/pan). */
  update(options: TimeSeriesChartOptions): void;
  /** Programmatically highlight a trace by trace name '{test} · {machine}' (or clear highlight). */
  hoverTrace(traceName: string | null): void;
  /** Destroy the chart and free resources. */
  destroy(): void;
}

type PlotlyGd = HTMLElement & {
  on: (evt: string, cb: (data: { points: Array<{ customdata?: string[]; curveNumber: number; pointNumber: number }> }) => void) => void;
};

/**
 * Create a time-series chart that supports efficient incremental updates.
 * First call uses Plotly.newPlot(); subsequent update() calls use Plotly.react().
 */
export function createTimeSeriesChart(
  container: HTMLElement,
  options: TimeSeriesChartOptions,
): ChartHandle {
  let chartDiv: HTMLElement | null = null;
  let initialized = false;
  let plotReady: Promise<void> = Promise.resolve();
  const config = { responsive: true, displayModeBar: true };
  /** Ordered list of main trace test names (excludes reference order traces). */
  let traceNames: string[] = [];
  /** Total number of Plotly traces (main + reference order traces). */
  let totalTraceCount = 0;
  /** Whether a temporary scatter trace is currently appended. */
  let hasScatterTrace = false;
  /** Saved y-axis state before scatter trace was added (restored on unhover). */
  let savedYAxis: { range?: [number, number]; autorange?: unknown } | null = null;
  /** Current getRawValues callback (updated on each doPlot). */
  let getRawValues: TimeSeriesChartOptions['getRawValues'];
  /** Color map from test name to trace color (updated on each doPlot). */
  let traceColorMap = new Map<string, string>();

  function attachHandlers(gd: PlotlyGd, opts: TimeSeriesChartOptions): void {
    if (opts.onClick) {
      const handler = opts.onClick;
      gd.on('plotly_click', (eventData) => {
        const pt = eventData.points[0];
        if (pt?.customdata?.[0]) {
          handler(pt.customdata[0]);
        }
      });
    }

    // Dispatch hover events for bidirectional sync with legend table
    // and show raw value scatter for aggregated points
    gd.on('plotly_hover', (eventData) => {
      const pt = eventData.points[0];
      const traceName = pt?.customdata?.[1];
      if (traceName) {
        document.dispatchEvent(new CustomEvent(GRAPH_CHART_HOVER, { detail: traceName }));
      }

      // Show raw value scatter if getRawValues is available
      if (!getRawValues || !chartDiv) return;
      const orderValue = pt?.customdata?.[0];
      const testName = pt?.customdata?.[4];
      const machineName = pt?.customdata?.[5];
      if (!testName || !machineName || !orderValue) return;

      // Remove any existing scatter trace first
      plotReady = plotReady.then(() => {
        if (!chartDiv) return;
        if (hasScatterTrace) {
          try {
            Plotly.deleteTraces(chartDiv, [-1]);
            if (savedYAxis) {
              Plotly.relayout(chartDiv, {
                'yaxis.autorange': savedYAxis.autorange ?? true,
                ...(savedYAxis.range ? { 'yaxis.range': savedYAxis.range } : {}),
              });
              savedYAxis = null;
            }
          } catch { /* ok */ }
          hasScatterTrace = false;
        }
        if (!getRawValues) return;
        const rawValues = getRawValues(testName, machineName, orderValue);
        if (rawValues.length <= 1) return;

        const color = traceColorMap.get(`${testName}${TRACE_SEP}${machineName}`) || '#999';
        const scatter = {
          x: rawValues.map(() => orderValue),
          y: rawValues,
          mode: 'markers',
          type: 'scatter',
          marker: { size: 6, color, opacity: 0.3 },
          showlegend: false,
          hoverinfo: 'skip' as const,
        };
        try {
          // Save y-axis state and lock range before adding scatter
          const curLayout = (chartDiv as unknown as { layout?: {
            yaxis?: { range?: [number, number]; autorange?: unknown };
          } }).layout;
          if (curLayout?.yaxis) {
            savedYAxis = {
              range: curLayout.yaxis.range ? [...curLayout.yaxis.range] as [number, number] : undefined,
              autorange: curLayout.yaxis.autorange,
            };
            if (curLayout.yaxis.range) {
              Plotly.relayout(chartDiv, {
                'yaxis.autorange': false,
                'yaxis.range': [...curLayout.yaxis.range],
              });
            }
          }
          Plotly.addTraces(chartDiv, scatter);
          hasScatterTrace = true;
        } catch { /* ok */ }
      }).catch(err => {
        console.warn('Chart operation failed:', err);
      });
    });
    gd.on('plotly_unhover', () => {
      document.dispatchEvent(new CustomEvent(GRAPH_CHART_HOVER, { detail: null }));

      // Remove scatter trace and restore y-axis
      if (hasScatterTrace && chartDiv) {
        plotReady = plotReady.then(() => {
          if (!chartDiv || !hasScatterTrace) return;
          try {
            Plotly.deleteTraces(chartDiv, [-1]);
            if (savedYAxis) {
              Plotly.relayout(chartDiv, {
                'yaxis.autorange': savedYAxis.autorange ?? true,
                ...(savedYAxis.range ? { 'yaxis.range': savedYAxis.range } : {}),
              });
              savedYAxis = null;
            }
          } catch { /* ok */ }
          hasScatterTrace = false;
        }).catch(err => {
          console.warn('Chart operation failed:', err);
        });
      }
    });
  }

  function doPlot(opts: TimeSeriesChartOptions): void {
    if (opts.traces.length === 0 && !opts.categoryOrder) {
      if (chartDiv && initialized) {
        try { Plotly.purge(chartDiv); } catch { /* ok */ }
      }
      container.replaceChildren(el('p', { class: 'no-chart-data' }, 'No data to plot.'));
      chartDiv = null;
      initialized = false;
      traceNames = [];
      plotReady = Promise.resolve();
      return;
    }

    // Track main trace names for hoverTrace() mapping
    traceNames = opts.traces.map(t => `${t.testName}${TRACE_SEP}${t.machine}`);

    // Update callback and color map for scatter-on-hover
    getRawValues = opts.getRawValues;
    traceColorMap = new Map<string, string>();
    for (const t of opts.traces) {
      if (t.color) traceColorMap.set(`${t.testName}${TRACE_SEP}${t.machine}`, t.color);
    }

    const { data, layout } = buildPlotlyData(opts);

    // Track total trace count (main + reference) for restyle operations
    totalTraceCount = (data as unknown[]).length;

    // react()/newPlot() replaces all traces, so any scatter trace is gone
    hasScatterTrace = false;

    if (initialized && chartDiv && chartDiv.parentElement) {
      // Chain react() after any pending newPlot() to avoid race conditions
      plotReady = plotReady.then(() => {
        if (!chartDiv) return;
        // Preserve current axis ranges so user zoom is not reset by the
        // canonical layout from buildPlotlyData(). Read chartDiv.layout
        // inside the .then() because it may not be populated until the
        // previous newPlot()/react() resolves.
        const cur = (chartDiv as unknown as { layout?: {
          xaxis?: { range?: unknown; autorange?: unknown };
          yaxis?: { range?: unknown; autorange?: unknown };
        } }).layout;
        const lx = layout as { xaxis?: Record<string, unknown>; yaxis?: Record<string, unknown> };
        if (cur?.xaxis && lx.xaxis) {
          lx.xaxis.range = cur.xaxis.range;
          lx.xaxis.autorange = cur.xaxis.autorange;
        }
        if (cur?.yaxis && cur.yaxis.autorange === false) {
          // User has explicitly zoomed the y-axis — preserve their range.
          if (lx.yaxis) {
            lx.yaxis.range = cur.yaxis.range;
            lx.yaxis.autorange = false;
          }
        }
        Plotly.react(chartDiv, data, layout, config);
      }).catch(err => {
        console.warn('Chart operation failed:', err);
      });
    } else {
      chartDiv = el('div', { class: 'graph-chart' });
      container.replaceChildren(chartDiv);
      initialized = true;
      plotReady = Plotly.newPlot(chartDiv, data, layout, config).then((gd) => {
        attachHandlers(gd as PlotlyGd, opts);
      }).catch(err => {
        console.warn('Chart operation failed:', err);
      });
    }
  }

  doPlot(options);

  return {
    update(opts: TimeSeriesChartOptions): void {
      doPlot(opts);
    },
    hoverTrace(traceName: string | null): void {
      if (!chartDiv || !initialized) return;
      plotReady.then(() => {
        if (!chartDiv) return;
        if (!traceName) {
          // Restore all traces to normal appearance
          const allIndices = Array.from({ length: totalTraceCount }, (_, i) => i);
          if (allIndices.length > 0) {
            try {
              Plotly.restyle(chartDiv, { opacity: 1.0, 'line.width': 1.5 }, allIndices);
            } catch { /* ok */ }
          }
          return;
        }
        const curveNumber = traceNames.indexOf(traceName);
        if (curveNumber < 0) return;
        try {
          // Dim all traces
          const allIndices = Array.from({ length: totalTraceCount }, (_, i) => i);
          if (allIndices.length > 0) {
            Plotly.restyle(chartDiv, { opacity: 0.2, 'line.width': 1.5 }, allIndices);
          }
          // Emphasize the hovered trace
          Plotly.restyle(chartDiv, { opacity: 1.0, 'line.width': 3 }, [curveNumber]);
        } catch { /* ok */ }
      }).catch(err => {
        console.warn('Chart operation failed:', err);
      });
    },
    destroy(): void {
      if (chartDiv && initialized) {
        try { Plotly.purge(chartDiv); } catch { /* ok */ }
      }
      chartDiv = null;
      initialized = false;
      traceNames = [];
      totalTraceCount = 0;
      hasScatterTrace = false;
      savedYAxis = null;
      getRawValues = undefined;
      traceColorMap = new Map();
    },
  };
}
