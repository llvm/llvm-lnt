// pages/home.ts — Dashboard page with sparkline trend overview.
// Suite-agnostic — served at /v5/.

import type { PageModule, RouteParams } from '../router';
import type { FieldInfo, QueryDataPoint } from '../types';
import { getTestsuites } from '../router';
import { getTestSuiteInfo, getRunsPage, queryDataPoints } from '../api';
import { el, geomean, primaryOrderValue, agnosticUrl } from '../utils';
import type { SparklineTrace } from '../components/sparkline-card';
import {
  createSparklineCard, createSparklineLoading, createSparklineError,
  machineColor,
} from '../components/sparkline-card';

const MAX_MACHINES = 5;

type RangePreset = '30d' | '90d' | '1y';
const RANGE_DAYS: Record<RangePreset, number> = { '30d': 30, '90d': 90, '1y': 365 };
const RANGE_PRESETS: RangePreset[] = ['30d', '90d', '1y'];

function rangeToAfterTime(range: RangePreset): string {
  const d = new Date();
  d.setDate(d.getDate() - RANGE_DAYS[range]);
  return d.toISOString();
}

function isValidRange(s: string): s is RangePreset {
  return RANGE_PRESETS.includes(s as RangePreset);
}

// ---------------------------------------------------------------------------
// Data fetching abstraction — can be replaced by a server-side endpoint later
// ---------------------------------------------------------------------------

/**
 * Fetch trend data for one metric across multiple machines.
 * Returns sparkline traces with geomean-aggregated values per order.
 */
async function fetchSuiteTrends(
  suite: string,
  metric: string,
  machines: string[],
  afterTime: string,
  signal: AbortSignal,
): Promise<SparklineTrace[]> {
  // Fetch data for all machines in parallel
  const allPoints = await Promise.all(
    machines.map(machine =>
      queryDataPoints(suite, { metric, machine, afterTime }, signal)
    )
  );

  const traces: SparklineTrace[] = [];

  for (let i = 0; i < machines.length; i++) {
    const machine = machines[i];
    const points = allPoints[i];

    // Group by order value, compute geomean across all tests at each order
    const byOrder = new Map<string, { values: number[]; timestamp: string | null }>();
    for (const pt of points) {
      const orderKey = primaryOrderValue(pt.order);
      let entry = byOrder.get(orderKey);
      if (!entry) {
        entry = { values: [], timestamp: pt.timestamp };
        byOrder.set(orderKey, entry);
      }
      entry.values.push(pt.value);
      // Keep the latest timestamp for display
      if (pt.timestamp && (!entry.timestamp || pt.timestamp > entry.timestamp)) {
        entry.timestamp = pt.timestamp;
      }
    }

    // Convert to sparkline points, sorted by timestamp
    const sparkPoints: Array<{ timestamp: string; value: number }> = [];
    for (const [, entry] of byOrder) {
      const gm = geomean(entry.values);
      if (gm !== null && entry.timestamp) {
        sparkPoints.push({ timestamp: entry.timestamp, value: gm });
      }
    }
    sparkPoints.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    if (sparkPoints.length > 0) {
      traces.push({
        machine,
        color: machineColor(i),
        points: sparkPoints,
      });
    }
  }

  return traces;
}

// ---------------------------------------------------------------------------
// Dashboard page module
// ---------------------------------------------------------------------------

/** Track all Plotly card destroy callbacks for cleanup on unmount. */
let destroyFns: Array<() => void> = [];
let abortController: AbortController | null = null;

export const homePage: PageModule = {
  mount(container: HTMLElement, _params: RouteParams): void {
    // Clean up any previous state
    cleanup();

    abortController = new AbortController();
    const signal = abortController.signal;

    const suites = getTestsuites();

    // Read range from URL
    const urlParams = new URLSearchParams(window.location.search);
    let activeRange: RangePreset = '30d';
    const rangeParam = urlParams.get('range') || '';
    if (isValidRange(rangeParam)) activeRange = rangeParam;

    // Header with time range buttons
    const rangeGroup = el('div', { class: 'dashboard-range-group' });
    const rangeButtons = new Map<RangePreset, HTMLButtonElement>();
    for (const preset of RANGE_PRESETS) {
      const btn = el('button', {
        class: `dashboard-range-btn${preset === activeRange ? ' dashboard-range-btn-active' : ''}`,
      }, preset);
      btn.addEventListener('click', () => {
        if (preset === activeRange) return;
        activeRange = preset;
        syncUrl();
        for (const [p, b] of rangeButtons) {
          b.className = `dashboard-range-btn${p === activeRange ? ' dashboard-range-btn-active' : ''}`;
        }
        reloadAll();
      });
      rangeButtons.set(preset, btn);
      rangeGroup.append(btn);
    }

    const header = el('div', { class: 'dashboard-header' },
      el('h2', { class: 'page-header' }, 'Dashboard'),
      rangeGroup,
    );
    container.append(header);

    if (suites.length === 0) {
      container.append(el('p', {}, 'No test suites available.'));
      return;
    }

    // Suite sections
    const suiteSections = new Map<string, HTMLElement>();
    for (const suite of suites) {
      const grid = el('div', { class: 'sparkline-grid' });
      const section = el('div', { class: 'suite-section' },
        el('h3', {}, suite),
        grid,
      );
      suiteSections.set(suite, grid);
      container.append(section);
    }

    function syncUrl(): void {
      const params = new URLSearchParams();
      if (activeRange !== '30d') params.set('range', activeRange);
      const qs = params.toString();
      window.history.replaceState(null, '',
        window.location.pathname + (qs ? '?' + qs : ''));
    }

    function reloadAll(): void {
      // Abort previous requests
      if (abortController) abortController.abort();
      abortController = new AbortController();
      const sig = abortController.signal;

      // Destroy existing sparkline cards
      for (const fn of destroyFns) fn();
      destroyFns = [];

      // Clear grids
      for (const grid of suiteSections.values()) {
        grid.replaceChildren();
      }

      loadAllSuites(sig);
    }

    function loadAllSuites(sig: AbortSignal): void {
      for (const suite of suites) {
        const grid = suiteSections.get(suite)!;
        loadSuite(suite, grid, sig);
      }
    }

    async function loadSuite(suite: string, grid: HTMLElement, sig: AbortSignal): Promise<void> {
      try {
        // Fetch suite info and recent runs in parallel
        const [suiteInfo, runsPage] = await Promise.all([
          getTestSuiteInfo(suite, sig),
          getRunsPage(suite, { sort: '-start_time', limit: 50 }, sig),
        ]);

        if (sig.aborted) return;

        const metrics = suiteInfo.schema.metrics;
        if (metrics.length === 0) {
          grid.append(el('p', { class: 'sparkline-loading' }, 'No metrics defined.'));
          return;
        }

        // Find top N most recently active machines
        const seen = new Set<string>();
        const topMachines: string[] = [];
        for (const run of runsPage.items) {
          if (!seen.has(run.machine)) {
            seen.add(run.machine);
            topMachines.push(run.machine);
            if (topMachines.length >= MAX_MACHINES) break;
          }
        }

        if (topMachines.length === 0) {
          grid.append(el('p', { class: 'sparkline-loading' }, 'No recent runs.'));
          return;
        }

        // Create loading placeholders for each metric
        const placeholders = new Map<string, HTMLElement>();
        for (const metric of metrics) {
          const placeholder = createSparklineLoading(
            metric.display_name || metric.name,
            metric.unit_abbrev || metric.unit || undefined,
          );
          placeholders.set(metric.name, placeholder);
          grid.append(placeholder);
        }

        // Fetch and render each metric's sparkline
        const afterTime = rangeToAfterTime(activeRange);
        for (const metric of metrics) {
          loadMetricSparkline(suite, metric, topMachines, afterTime, grid, placeholders, sig);
        }
      } catch (err) {
        if (sig.aborted) return;
        grid.append(el('p', { class: 'sparkline-error' }, `Error loading suite: ${err}`));
      }
    }

    async function loadMetricSparkline(
      suite: string,
      metric: FieldInfo,
      machines: string[],
      afterTime: string,
      grid: HTMLElement,
      placeholders: Map<string, HTMLElement>,
      sig: AbortSignal,
    ): Promise<void> {
      const metricName = metric.name;
      const displayName = metric.display_name || metric.name;
      const unit = metric.unit_abbrev || metric.unit || undefined;

      try {
        const traces = await fetchSuiteTrends(suite, metricName, machines, afterTime, sig);
        if (sig.aborted) return;

        const graphParams = new URLSearchParams();
        graphParams.set('suite', suite);
        for (const m of machines) graphParams.append('machine', m);
        graphParams.set('metric', metricName);
        const graphUrl = `/graph?${graphParams.toString()}`;

        const { element, destroy } = createSparklineCard({
          title: displayName,
          unit,
          traces,
          onClick: () => { window.location.href = agnosticUrl(graphUrl); },
        });

        destroyFns.push(destroy);

        // Replace loading placeholder with the rendered card
        const placeholder = placeholders.get(metricName);
        if (placeholder && placeholder.parentElement === grid) {
          grid.replaceChild(element, placeholder);
        }
      } catch (err) {
        if (sig.aborted) return;
        const errorCard = createSparklineError(displayName, unit);
        const placeholder = placeholders.get(metricName);
        if (placeholder && placeholder.parentElement === grid) {
          grid.replaceChild(errorCard, placeholder);
        }
      }
    }

    // Initial load
    loadAllSuites(signal);
  },

  unmount(): void {
    cleanup();
  },
};

function cleanup(): void {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  for (const fn of destroyFns) fn();
  destroyFns = [];
}
