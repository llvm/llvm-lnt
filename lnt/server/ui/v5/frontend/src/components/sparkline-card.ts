// components/sparkline-card.ts — Lightweight Plotly sparkline chart for Dashboard.

import { el } from '../utils';

declare const Plotly: {
  newPlot(el: HTMLElement, data: unknown[], layout: unknown, config?: unknown): Promise<HTMLElement>;
  purge(el: HTMLElement): void;
};

export { machineColor } from '../utils';

export interface SparklineTrace {
  machine: string;
  color: string;
  points: Array<{ timestamp: string; value: number }>;
}

export interface SparklineCardOptions {
  title: string;
  unit?: string;
  traces: SparklineTrace[];
  onClick?: () => void;
}

function formatLabel(title: string, unit?: string): string {
  return unit ? `${title} (${unit})` : title;
}

/**
 * Create a sparkline card element showing a small Plotly time-series chart.
 * Returns the DOM element and a destroy() function to free Plotly resources.
 */
export function createSparklineCard(options: SparklineCardOptions): {
  element: HTMLElement;
  destroy(): void;
} {
  const titleEl = el('div', { class: 'sparkline-title' }, formatLabel(options.title, options.unit));
  const chartDiv = el('div', { class: 'sparkline-chart' });
  const card = el('div', { class: 'sparkline-card' }, titleEl, chartDiv);

  if (options.onClick) {
    const handler = options.onClick;
    card.addEventListener('click', () => handler());
  }

  const plotlyData = options.traces.map(trace => ({
    x: trace.points.map(p => p.timestamp),
    y: trace.points.map(p => p.value),
    type: 'scatter',
    mode: 'lines',
    line: { color: trace.color, width: 1.5 },
    hovertemplate:
      `<b>${trace.machine}</b><br>` +
      'Value: %{y:.4g}<br>' +
      '%{x}<extra></extra>',
  }));

  const layout = {
    margin: { t: 8, r: 8, b: 30, l: 40 },
    xaxis: { type: 'date', showgrid: false, tickfont: { size: 10 } },
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
      Plotly.newPlot(chartDiv, plotlyData, layout, config).catch(() => { /* ok */ });
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
