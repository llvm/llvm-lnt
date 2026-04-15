// pages/home.ts — Dashboard page with sparkline trend overview.
// Suite-agnostic — served at /v5/.

import type { PageModule, RouteParams } from '../router';
import type { FieldInfo } from '../types';
import { getTestsuites } from '../router';
import { getTestSuiteInfo, getRunsPage, fetchTrends } from '../api';
import { el, agnosticUrl } from '../utils';
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
// Data fetching — uses server-side trends endpoint for geomean aggregation
// ---------------------------------------------------------------------------

/**
 * Fetch trend data for one metric across multiple machines.
 * Returns sparkline traces with server-computed geomean values per commit.
 */
async function fetchSuiteTrends(
  suite: string,
  metric: string,
  machines: string[],
  afterTime: string,
  signal: AbortSignal,
): Promise<SparklineTrace[]> {
  const items = await fetchTrends(suite, { metric, machine: machines, afterTime }, signal);

  // Group API response by machine, build SparklineTrace per machine
  const byMachine = new Map<string, Array<{ timestamp: string; value: number }>>();
  for (const item of items) {
    if (!item.submitted_at) continue;
    let points = byMachine.get(item.machine);
    if (!points) { points = []; byMachine.set(item.machine, points); }
    points.push({ timestamp: item.submitted_at, value: item.value });
  }

  const traces: SparklineTrace[] = [];
  for (const [machine, points] of byMachine) {
    if (points.length === 0) continue;
    const idx = machines.indexOf(machine);
    traces.push({ machine, color: machineColor(idx >= 0 ? idx : traces.length), points });
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
          getRunsPage(suite, { sort: '-submitted_at', limit: 50 }, sig),
        ]);

        if (sig.aborted) return;

        const metrics = suiteInfo.schema.metrics.filter(
          m => m.type === 'Real' || m.type === 'Integer',
        );
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

        const { element, destroy } = createSparklineCard({
          title: displayName,
          unit,
          traces,
          onClick: (machine?: string) => {
            const params = new URLSearchParams();
            params.set('suite', suite);
            if (machine) {
              params.append('machine', machine);
            } else {
              for (const m of machines) params.append('machine', m);
            }
            params.set('metric', metricName);
            window.location.href = agnosticUrl(`/graph?${params.toString()}`);
          },
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
