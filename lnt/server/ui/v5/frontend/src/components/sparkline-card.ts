// components/sparkline-card.ts — Lightweight Plotly sparkline chart for Dashboard.

import { el } from '../utils';

type PlotlyGd = HTMLElement & {
  on: (evt: string, cb: (data: { points: Array<{ curveNumber: number }> }) => void) => void;
};

declare const Plotly: {
  newPlot(el: HTMLElement, data: unknown[], layout: unknown, config?: unknown): Promise<PlotlyGd>;
  purge(el: HTMLElement): void;
};

export { machineColor } from '../utils';

export interface SparklineTrace {
  machine: string;
  color: string;
  points: Array<{ x: number; value: number; commit: string }>;
}

export interface SparklineCardOptions {
  title: string;
  unit?: string;
  traces: SparklineTrace[];
  /** Called on click. If a specific trace was clicked, `machine` is its name;
   *  otherwise (card background / title click) `machine` is undefined. */
  onClick?: (machine?: string) => void;
}

function formatLabel(title: string, unit?: string): string {
  return unit ? `${title} (${unit})` : title;
}

/**
 * Create a sparkline card element showing a small Plotly chart.
 * Returns the DOM element and a destroy() function to free Plotly resources.
 */
export function createSparklineCard(options: SparklineCardOptions): {
  element: HTMLElement;
  destroy(): void;
} {
  const titleEl = el('div', { class: 'sparkline-title' }, formatLabel(options.title, options.unit));
  const chartDiv = el('div', { class: 'sparkline-chart' });
  const card = el('div', { class: 'sparkline-card' }, titleEl, chartDiv);

  // Flag to prevent double-firing: Plotly's plotly_click fires after the DOM
  // click has already bubbled to the card, so we can't use stopPropagation.
  let traceClicked = false;

  if (options.onClick) {
    const handler = options.onClick;
    card.addEventListener('click', () => {
      if (traceClicked) {
        traceClicked = false;
        return;
      }
      handler();
    });
  }

  const plotlyData = options.traces.map(trace => ({
    x: trace.points.map(p => p.x),
    y: trace.points.map(p => p.value),
    text: trace.points.map(p => p.commit),
    type: 'scatter',
    mode: 'lines',
    line: { color: trace.color, width: 1.5 },
    hovertemplate:
      `<b>${trace.machine}</b><br>` +
      'Commit: %{text}<br>' +
      'Value: %{y:.4g}<extra></extra>',
  }));

  const layout = {
    margin: { t: 8, r: 8, b: 30, l: 40 },
    xaxis: { type: 'linear', showgrid: false, showticklabels: false },
    yaxis: { automargin: true, tickfont: { size: 10 } },
    showlegend: false,
    hovermode: 'closest' as const,
    autosize: true,
  };

  const config = { responsive: true, displayModeBar: false };

  // Schedule plot creation asynchronously (Plotly needs the element in the DOM)
  let plotted = false;
  requestAnimationFrame(() => {
    if (chartDiv.isConnected) {
      Plotly.newPlot(chartDiv, plotlyData, layout, config).then((gd) => {
        if (options.onClick) {
          const handler = options.onClick;
          gd.on('plotly_click', (eventData) => {
            const machine = options.traces[eventData.points[0]?.curveNumber]?.machine;
            if (machine) {
              traceClicked = true;
              handler(machine);
            }
          });
        }
      }).catch(() => { /* ok */ });
      plotted = true;
    }
  });

  return {
    element: card,
    destroy() {
      if (plotted) {
        try { Plotly.purge(chartDiv); } catch { /* ok */ }
      }
    },
  };
}

/**
 * Create a sparkline card placeholder showing a loading state.
 */
export function createSparklineLoading(title: string, unit?: string): HTMLElement {
  return el('div', { class: 'sparkline-card' },
    el('div', { class: 'sparkline-title' }, formatLabel(title, unit)),
    el('div', { class: 'sparkline-loading' }, 'Loading\u2026'),
  );
}

/**
 * Create a sparkline card placeholder showing an error state.
 */
export function createSparklineError(title: string, unit?: string): HTMLElement {
  return el('div', { class: 'sparkline-card' },
    el('div', { class: 'sparkline-title' }, formatLabel(title, unit)),
    el('div', { class: 'sparkline-error' }, 'Failed to load'),
  );
}
