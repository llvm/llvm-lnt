// pages/graph.ts — Time-series graph page with lazy loading and client-side caching.

import type { PageModule, RouteParams } from '../router';
import type { AggFn, QueryDataPoint } from '../types';
import { getFields, getOrders, fetchOneCursorPage, apiUrl, queryDataPoints } from '../api';
import type { MachineRunInfo, OrderSummary } from '../types';
import { el, debounce, getAggFn, primaryOrderValue, TRACE_SEP } from '../utils';
import { navigate } from '../router';
import { onCustomEvent, GRAPH_TABLE_HOVER, GRAPH_CHART_HOVER } from '../events';
import { renderMachineCombobox } from '../components/machine-combobox';
import { renderMetricSelector, filterMetricFields } from '../components/metric-selector';
import { renderOrderSearch, type OrderSuggestion } from '../components/order-search';
import {
  type TimeSeriesTrace, type PinnedOrder, type ChartHandle,
  createTimeSeriesChart,
} from '../components/time-series-chart';
import { createLegendTable, type LegendEntry, type LegendTableHandle } from '../components/legend-table';

const DEFAULT_CAP = 20;
const PAGE_LIMIT = '10000';
const CHART_BATCH_SIZE = 10;
const PIN_COLORS = ['#e377c2', '#ff7f0e', '#9467bd', '#8c564b', '#17becf'];
const PLOTLY_COLORS = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
  '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
];
const MACHINE_SYMBOLS = [
  'circle', 'triangle-up', 'square', 'diamond', 'x',
  'cross', 'star', 'pentagon', 'hexagon', 'hexagram',
];
/** Unicode characters matching MACHINE_SYMBOLS for display in chips and legend. */
const SYMBOL_CHARS = ['●', '▲', '■', '◆', '✕', '+', '★', '⬠', '⬡', '✡'];

// ---------------------------------------------------------------------------
// Cache — keyed by 'machine::metric'
// ---------------------------------------------------------------------------

interface MetricCache {
  points: QueryDataPoint[];
  nextCursor: string | null;
  loading: boolean;
  hasInitialData: boolean;
  complete: boolean;
}

let cache = new Map<string, MetricCache>();
/** Per-machine scaffolds (order values). */
let machineScaffolds = new Map<string, string[]>();
let metricAborts = new Map<string, AbortController>();
/** AbortController for in-flight scaffold fetches; aborted on unmount. */
let scaffoldAbort: AbortController | null = null;
/** Cached suggestions for the pinned-order search (built from scaffold union + tags). */
let cachedSuggestions: OrderSuggestion[] | null = null;
/** Cached orders fetched via getOrders — avoids re-fetching on every rebuildSuggestions call. */
let cachedOrders: OrderSummary[] | null = null;

function cacheKey(machine: string, metric: string): string {
  return `${machine}::${metric}`;
}

function abortForMachine(machine: string): void {
  for (const [key, ctrl] of metricAborts) {
    if (key.startsWith(machine + '::')) {
      ctrl.abort();
      metricAborts.delete(key);
    }
  }
}

function abortAllMetrics(): void {
  for (const ctrl of metricAborts.values()) ctrl.abort();
  metricAborts.clear();
}

function getOrCreateCache(machine: string, metric: string): MetricCache {
  const key = cacheKey(machine, metric);
  let entry = cache.get(key);
  if (!entry) {
    entry = { points: [], nextCursor: null, loading: false, hasInitialData: false, complete: false };
    cache.set(key, entry);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Module-scope UI state
// ---------------------------------------------------------------------------

let machineComboCleanup: (() => void) | null = null;
let orderSearchCleanup: (() => void) | null = null;
let chartHandle: ChartHandle | null = null;
let legendHandle: LegendTableHandle | null = null;
let manuallyHidden = new Set<string>();
let autoCapped = true;
/** Current visible trace names (updated on each render, used by legend callbacks). */
let currentVisibleTraceNames: string[] = [];
/** The active trace name set from the last chart render, used to skip no-op chart updates. */
let prevActiveTraceNames = new Set<string>();
/** Pending requestAnimationFrame ID for deferred chart updates. */
let pendingChartRAF: number | null = null;
/** Generation counter to cancel stale batched chart renders. */
let chartRenderGen = 0;
let cleanupTableHover: (() => void) | null = null;
let cleanupChartHover: (() => void) | null = null;
/** List of selected machines (preserved across unmount/remount). */
let machines: string[] = [];

/** Check whether two sets contain the same elements. Exported for testing. */
export function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

function assignColor(index: number): string {
  return PLOTLY_COLORS[index % PLOTLY_COLORS.length];
}

function assignSymbol(machineIndex: number): string {
  return MACHINE_SYMBOLS[machineIndex % MACHINE_SYMBOLS.length];
}

function assignSymbolChar(machineIndex: number): string {
  return SYMBOL_CHARS[machineIndex % SYMBOL_CHARS.length];
}

// Re-export TRACE_SEP for test convenience
export { TRACE_SEP } from '../utils';

/** Build the trace name for a test×machine combination. */
function traceName(testName: string, machine: string): string {
  return `${testName}${TRACE_SEP}${machine}`;
}

/** Extract the test name portion from a trace name (everything before the separator). */
function testNameFromTrace(tn: string): string {
  const idx = tn.lastIndexOf(TRACE_SEP);
  return idx >= 0 ? tn.slice(0, idx) : tn;
}

/**
 * Compute the union of all machines' scaffolds, preserving order.
 */
function computeScaffoldUnion(): string[] | null {
  if (machineScaffolds.size === 0) return null;
  const seen = new Set<string>();
  const union: string[] = [];
  for (const scaffold of machineScaffolds.values()) {
    for (const ov of scaffold) {
      if (!seen.has(ov)) {
        seen.add(ov);
        union.push(ov);
      }
    }
  }
  return union.length > 0 ? union : null;
}

/**
 * Determine which traces are active (plotted).
 * The filter matches on the test name portion of the trace name only.
 * Exported for testing.
 */
export function computeActiveTests(
  allTraceNames: string[],
  testFilter: string,
  hidden: Set<string>,
  capped: boolean,
): Set<string> {
  // Apply text filter (matches on test name portion only)
  let candidates: string[];
  if (testFilter) {
    const lf = testFilter.toLowerCase();
    candidates = allTraceNames.filter(tn => {
      const test = testNameFromTrace(tn);
      return test.toLowerCase().includes(lf);
    });
  } else {
    candidates = allTraceNames;
  }

  // 20-cap: only active when no filter and no manual toggles
  if (capped && !testFilter && hidden.size === 0) {
    return new Set(candidates.slice(0, DEFAULT_CAP));
  }

  // Remove manually hidden
  return new Set(candidates.filter(n => !hidden.has(n)));
}

export const graphPage: PageModule = {
  mount(container: HTMLElement, params: RouteParams): void {
    const ts = params.testsuite;
    // Create a fresh abort controller for scaffold fetches this mount cycle.
    scaffoldAbort = new AbortController();
    container.append(el('h2', { class: 'page-header' }, 'Graph'));

    // Parse URL state — URL is always the source of truth on mount.
    const urlParams = new URLSearchParams(window.location.search);
    machines = urlParams.getAll('machine').filter(Boolean);
    let metric = urlParams.get('metric') || '';
    let testFilter = urlParams.get('test_filter') || '';
    let runAgg: AggFn = (urlParams.get('run_agg') as AggFn) || 'median';
    let sampleAgg: AggFn = (urlParams.get('sample_agg') as AggFn) || 'median';
    const pinValues = urlParams.getAll('pin');
    const pinnedOrders: Array<{ value: string; tag: string | null }> = pinValues.map(v => ({ value: v, tag: null }));

    // Progress + chart containers
    const progressContainer = el('div', {});
    const warningContainer = el('div', {});
    const chartContainer = el('div', {},
      el('p', { class: 'no-chart-data' }, 'No data to plot.'),
    );

    // ----- Controls Panel -----
    const controlsPanel = el('div', { class: 'controls-panel' });
    container.append(controlsPanel);

    // ----- Controls Row 1: Metric, Test Filter, Aggregation -----
    const controlsRow = el('div', { class: 'graph-controls' });
    controlsPanel.append(controlsRow);

    // Metric selector (loaded async)
    const metricGroup = el('div', {});
    const metricLoading = el('span', { class: 'progress-label' }, 'Loading metrics...');
    metricGroup.append(metricLoading);
    controlsRow.append(metricGroup);

    getFields(ts).then(fields => {
      metricLoading.remove();
      const initial = renderMetricSelector(metricGroup, filterMetricFields(fields), (m) => {
        metric = m;
        updateUrlState();
        if (machines.length > 0) doPlot();
      }, metric || undefined, { placeholder: true });
      if (!metric) metric = initial;
    }).catch(() => {
      metricLoading.remove();
      metricGroup.append(el('p', { class: 'error-banner' }, 'Failed to load fields'));
    });

    // Test filter
    const filterGroup = el('div', { class: 'control-group' });
    filterGroup.append(el('label', {}, 'Filter tests'));
    const filterInput = el('input', {
      type: 'text',
      class: 'test-filter-input',
      placeholder: 'Filter tests...',
    }) as HTMLInputElement;
    filterInput.value = testFilter;
    filterInput.addEventListener('input', debounce(() => {
      testFilter = filterInput.value.trim();
      if (testFilter) autoCapped = false;
      renderFromAllCaches();
      updateUrlState();
    }, 200) as EventListener);
    filterGroup.append(filterInput);
    controlsRow.append(filterGroup);

    // Aggregation controls
    const runAggGroup = el('div', { class: 'control-group' });
    runAggGroup.append(el('label', {}, 'Run aggregation'));
    const runAggSelect = el('select', { class: 'agg-select' }) as HTMLSelectElement;
    for (const a of ['median', 'mean', 'min', 'max']) {
      const opt = el('option', { value: a }, a);
      if (a === runAgg) (opt as HTMLOptionElement).selected = true;
      runAggSelect.append(opt);
    }
    runAggSelect.addEventListener('change', () => {
      runAgg = runAggSelect.value as AggFn;
      renderFromAllCaches();
      updateUrlState();
    });
    runAggGroup.append(runAggSelect);
    controlsRow.append(runAggGroup);

    const sampleAggGroup = el('div', { class: 'control-group' });
    sampleAggGroup.append(el('label', {}, 'Sample aggregation'));
    const sampleAggSelect = el('select', { class: 'agg-select' }) as HTMLSelectElement;
    for (const a of ['median', 'mean', 'min', 'max']) {
      const opt = el('option', { value: a }, a);
      if (a === sampleAgg) (opt as HTMLOptionElement).selected = true;
      sampleAggSelect.append(opt);
    }
    sampleAggSelect.addEventListener('change', () => {
      sampleAgg = sampleAggSelect.value as AggFn;
      renderFromAllCaches();
      updateUrlState();
    });
    sampleAggGroup.append(sampleAggSelect);
    controlsRow.append(sampleAggGroup);

    // ----- Controls Row 2: Machines + Pinned Orders (side by side) -----
    const secondRow = el('div', { class: 'graph-controls' });
    controlsPanel.append(secondRow);

    // Machine chip input
    const machineGroup = el('div', { class: 'control-group' });
    machineGroup.append(el('label', {}, 'Machines'));
    const machineInputContainer = el('div', {});
    const machineChipsEl = el('div', { class: 'chip-list', style: 'margin-top: 4px' });
    machineGroup.append(machineInputContainer, machineChipsEl);

    function renderMachineChips(): void {
      machineChipsEl.replaceChildren();
      for (const m of machines) {
        const idx = machines.indexOf(m);
        const symbolChar = assignSymbolChar(idx);
        const chip = el('span', { class: 'chip' }, `${symbolChar} ${m}`);
        const removeBtn = el('button', { class: 'chip-remove' }, '\u00d7');
        removeBtn.addEventListener('click', () => {
          abortForMachine(m);
          machines = machines.filter(x => x !== m);
          machineScaffolds.delete(m);
          for (const key of [...cache.keys()]) {
            if (key.startsWith(m + '::')) cache.delete(key);
          }
          renderMachineChips();
          rebuildSuggestions();
          if (machines.length > 0 && metric) {
            doPlot();
          } else {
            // No machines left — show empty state
            renderFromAllCaches();
          }
          updateUrlState();
        });
        chip.append(removeBtn);
        machineChipsEl.append(chip);
      }
    }

    const machineHandle = renderMachineCombobox(machineInputContainer, {
      testsuite: ts,
      initialValue: '',
      onSelect: (name) => {
        if (name && !machines.includes(name)) {
          machines.push(name);
          renderMachineChips();
          machineHandle.clear();
          if (metric) doPlot();
          updateUrlState();
        }
      },
    });
    machineComboCleanup = machineHandle.destroy;
    renderMachineChips();
    secondRow.append(machineGroup);

    // Pinned Orders (same row as Machines)
    const pinGroup = el('div', { class: 'control-group' });
    pinGroup.append(el('label', {}, 'Pinned Orders'));
    const pinSearchContainer = el('div', {});
    const pinChips = el('div', { class: 'chip-list', style: 'margin-top: 4px' });
    pinGroup.append(pinSearchContainer, pinChips);
    secondRow.append(pinGroup);

    const pinSearchHandle = renderOrderSearch(pinSearchContainer, {
      testsuite: ts,
      placeholder: 'Pin an order...',
      suggestions: cachedSuggestions ?? [],
      onSelect: (value) => {
        if (!pinnedOrders.find(r => r.value === value)) {
          const tag = cachedSuggestions?.find(s => s.orderValue === value)?.tag ?? null;
          pinnedOrders.push({ value, tag });
          renderPinChips();
          renderFromAllCaches();
          updateUrlState();
        }
      },
    });
    orderSearchCleanup = pinSearchHandle.destroy;

    renderPinChips();

    function renderPinChips(): void {
      pinChips.replaceChildren();
      for (const ref of pinnedOrders) {
        const chip = el('span', { class: 'chip' },
          ref.tag ? `${ref.value} (${ref.tag})` : ref.value,
        );
        const removeBtn = el('button', { class: 'chip-remove' }, '\u00d7');
        removeBtn.addEventListener('click', () => {
          const idx = pinnedOrders.indexOf(ref);
          if (idx >= 0) pinnedOrders.splice(idx, 1);
          renderPinChips();
          renderFromAllCaches();
          updateUrlState();
        });
        chip.append(removeBtn);
        pinChips.append(chip);
      }
    }

    container.append(progressContainer, warningContainer, chartContainer);
    const legendContainer = el('div', { class: 'legend-container' });
    container.append(legendContainer);

    // ----- Hover sync -----
    cleanupTableHover = onCustomEvent<string | null>(GRAPH_TABLE_HOVER, (tn) => {
      if (chartHandle) chartHandle.hoverTrace(tn);
    });
    cleanupChartHover = onCustomEvent<string | null>(GRAPH_CHART_HOVER, (tn) => {
      if (legendHandle) legendHandle.highlightRow(tn);
    });

    // ----- Scaffold suggestions -----
    function rebuildSuggestions(): void {
      const scaffold = computeScaffoldUnion();
      if (!scaffold) {
        cachedSuggestions = [];
        pinSearchHandle.setSuggestions([]);
        return;
      }
      // Fetch tags (cached after first fetch to avoid repeated full-pagination calls)
      const ordersPromise = cachedOrders
        ? Promise.resolve(cachedOrders)
        : getOrders(ts).then(orders => { cachedOrders = orders; return orders; });
      ordersPromise.then(allOrders => {
        const tagMap = new Map<string, string | null>();
        for (const o of allOrders) {
          tagMap.set(primaryOrderValue(o.fields), o.tag ?? null);
        }
        const suggestions: OrderSuggestion[] = scaffold.map(ov => ({
          orderValue: ov,
          tag: tagMap.get(ov) ?? null,
        }));
        suggestions.sort((a, b) => {
          if (a.tag && !b.tag) return -1;
          if (!a.tag && b.tag) return 1;
          return 0;
        });
        cachedSuggestions = suggestions;
        pinSearchHandle.setSuggestions(suggestions);
        // Backfill tags for any pinned orders that were added before suggestions loaded
        let tagsUpdated = false;
        for (const pin of pinnedOrders) {
          if (!pin.tag) {
            const match = suggestions.find(s => s.orderValue === pin.value);
            if (match?.tag) { pin.tag = match.tag; tagsUpdated = true; }
          }
        }
        if (tagsUpdated) renderPinChips();
      }).catch(() => { /* ok */ });
    }

    // ----- Lazy loading (per machine) -----

    function startLazyLoad(testsuite: string, machineName: string, metricName: string): void {
      const key = cacheKey(machineName, metricName);
      const existingAbort = metricAborts.get(key);
      if (existingAbort) existingAbort.abort();

      const ctrl = new AbortController();
      metricAborts.set(key, ctrl);

      const entry = getOrCreateCache(machineName, metricName);
      if (entry.complete || entry.loading) return;
      entry.loading = true;

      (async () => {
        try {
          while (!entry.complete) {
            if (ctrl.signal.aborted) break;

            const params: Record<string, string> = {
              machine: machineName,
              metric: metricName,
              sort: '-order',
              limit: PAGE_LIMIT,
            };
            if (entry.nextCursor) params.cursor = entry.nextCursor;

            const page = await fetchOneCursorPage<QueryDataPoint>(
              apiUrl(testsuite, 'query'), params, ctrl.signal,
            );

            entry.points.push(...page.items);
            entry.nextCursor = page.nextCursor;
            if (!entry.hasInitialData) entry.hasInitialData = true;
            if (!page.nextCursor) entry.complete = true;

            // Re-render if this machine is still selected and metric matches
            if (machines.includes(machineName) && metricName === metric) {
              renderFromAllCaches(false);
            }
          }

          // Fetch missing reference order data after loading completes
          if (!ctrl.signal.aborted && machines.includes(machineName) && metricName === metric) {
            await fetchMissingPinData(testsuite, machineName, metricName, entry, ctrl.signal);
          }
        } catch (e: unknown) {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          if (machines.includes(machineName) && metricName === metric) {
            warningContainer.replaceChildren(
              el('p', { class: 'error-banner' }, `Failed to load data for ${machineName}: ${e}`),
            );
          }
        } finally {
          entry.loading = false;
        }
      })();
    }

    // ----- Render from all machines' caches -----

    function renderFromAllCaches(batch = true): void {
      // Collect data from all machines
      const allChronological: Array<{ machine: string; points: QueryDataPoint[] }> = [];
      let anyHasData = false;
      let allComplete = true;
      let totalPoints = 0;

      for (const m of machines) {
        const entry = cache.get(cacheKey(m, metric));
        if (entry?.hasInitialData) {
          anyHasData = true;
          const chronological = [...entry.points].reverse();
          allChronological.push({ machine: m, points: chronological });
          totalPoints += entry.points.length;
          if (!entry.complete) allComplete = false;
        } else {
          allComplete = false;
        }
      }

      if (!anyHasData) {
        // No data yet — show empty chart with scaffold if available, clear legend
        progressContainer.replaceChildren();
        if (legendHandle) { legendHandle.update([], undefined); }
        const scaffold = computeScaffoldUnion();
        chartRenderGen++;
        if (pendingChartRAF !== null) {
          cancelAnimationFrame(pendingChartRAF);
          pendingChartRAF = null;
        }
        const chartOpts = {
          traces: [] as TimeSeriesTrace[],
          yAxisLabel: metric || '',
          categoryOrder: scaffold ?? undefined,
        };
        if (chartHandle) {
          chartHandle.update(chartOpts);
        } else if (scaffold) {
          chartHandle = createTimeSeriesChart(chartContainer, chartOpts);
        }
        return;
      }

      // Collect all unique test names across all machines (for color assignment)
      const allTestNames = new Set<string>();
      for (const { points } of allChronological) {
        for (const pt of points) allTestNames.add(pt.test);
      }
      const sortedTestNames = [...allTestNames].sort((a, b) => a.localeCompare(b));

      // Assign colors by test name (same test on different machines = same color)
      const colorMap = new Map<string, string>();
      sortedTestNames.forEach((name, i) => colorMap.set(name, assignColor(i)));

      // Build traces per machine with marker symbols
      const allTraces: TimeSeriesTrace[] = [];
      const allTraceNames: string[] = [];

      for (let mi = 0; mi < machines.length; mi++) {
        const m = machines[mi];
        const symbol = assignSymbol(mi);
        const machineData = allChronological.find(d => d.machine === m);
        if (!machineData) continue;

        const activePoints = machineData.points;
        const machineTraces = buildTraces(activePoints, '', runAgg, sampleAgg);
        for (const t of machineTraces) {
          const tn = traceName(t.testName, m);
          allTraces.push({
            ...t,
            machine: m,
            color: colorMap.get(t.testName),
            markerSymbol: symbol,
          });
          allTraceNames.push(tn);
        }
      }

      // Sort all trace names for consistent ordering
      allTraceNames.sort((a, b) => a.localeCompare(b));

      // Filter visible trace names (filter matches on test name portion only)
      const lf = testFilter.toLowerCase();
      const visibleTraceNames = testFilter
        ? allTraceNames.filter(tn => testNameFromTrace(tn).toLowerCase().includes(lf))
        : allTraceNames;
      currentVisibleTraceNames = visibleTraceNames;

      // Compute active set
      const activeSet = computeActiveTests(allTraceNames, testFilter, manuallyHidden, autoCapped);

      // Filter traces to only active ones
      const activeTraces = allTraces
        .filter(t => activeSet.has(traceName(t.testName, t.machine)))
        .sort((a, b) => traceName(a.testName, a.machine).localeCompare(traceName(b.testName, b.machine)));

      // --- Synchronous phase: legend table + progress ---

      const legendEntries: LegendEntry[] = visibleTraceNames.map(tn => {
        const testN = testNameFromTrace(tn);
        // Extract machine name from trace name (after the separator)
        const sepIdx = tn.lastIndexOf(TRACE_SEP);
        const machN = sepIdx >= 0 ? tn.slice(sepIdx + TRACE_SEP.length) : undefined;
        const machIdx = machN ? machines.indexOf(machN) : -1;
        return {
          testName: tn,
          color: colorMap.get(testN) || '#999',
          active: activeSet.has(tn),
          machineName: machN,
          symbolChar: machIdx >= 0 ? assignSymbolChar(machIdx) : undefined,
        };
      });

      // Message
      const capActive = autoCapped && !testFilter && manuallyHidden.size === 0
        && allTraceNames.length > DEFAULT_CAP;
      let legendMessage: string | undefined;
      if (capActive) {
        legendMessage = `Showing first ${DEFAULT_CAP} of ${allTraceNames.length} traces. Use the test filter or click rows to see specific traces.`;
      } else if (visibleTraceNames.length < allTraceNames.length) {
        legendMessage = `${visibleTraceNames.length} of ${allTraceNames.length} traces matching`;
      } else if (allTraceNames.length > 0) {
        legendMessage = `${allTraceNames.length} traces`;
      }

      if (legendHandle) {
        legendHandle.update(legendEntries, legendMessage);
      } else {
        legendHandle = createLegendTable(legendContainer, {
          entries: legendEntries,
          message: legendMessage,
          onToggle: (tn) => {
            autoCapped = false;
            if (manuallyHidden.has(tn)) {
              manuallyHidden.delete(tn);
            } else {
              manuallyHidden.add(tn);
            }
            renderFromAllCaches();
          },
          onIsolate: (tn) => {
            autoCapped = false;
            const othersAllHidden = currentVisibleTraceNames.every(
              n => n === tn || manuallyHidden.has(n),
            );
            if (othersAllHidden) {
              manuallyHidden = new Set();
            } else {
              manuallyHidden = new Set(currentVisibleTraceNames.filter(n => n !== tn));
            }
            renderFromAllCaches();
          },
        });
      }

      // Progress
      if (allComplete) {
        progressContainer.replaceChildren();
      } else {
        progressContainer.replaceChildren(
          el('span', { class: 'progress-label' }, `Loading ${totalPoints} samples...`),
        );
      }

      // --- Deferred chart update phase ---
      //
      // Skip the chart update entirely when the active trace set hasn't changed
      // and this is a user-initiated change (batch=true). This avoids unnecessary
      // Plotly.react() calls when e.g. typing more characters into the filter
      // that still match the same set of tests.
      if (batch && setsEqual(activeSet, prevActiveTraceNames)) {
        return;
      }
      prevActiveTraceNames = new Set(activeSet);

      chartRenderGen++;
      const myGen = chartRenderGen;
      if (pendingChartRAF !== null) {
        cancelAnimationFrame(pendingChartRAF);
        pendingChartRAF = null;
      }

      // Collect all chronological points for reference orders and raw values
      const allPoints: QueryDataPoint[] = [];
      for (const { points } of allChronological) {
        for (const pt of points) allPoints.push(pt);
      }

      const refs = buildRefsFromCache(allPoints, pinnedOrders, getAggFn(runAgg));
      const scaffold = computeScaffoldUnion();

      const rawValuesCallback = (testName: string, machineName: string, orderValue: string): number[] => {
        const values: number[] = [];
        for (const pt of allPoints) {
          if (pt.test === testName && pt.machine === machineName && primaryOrderValue(pt.order) === orderValue) {
            values.push(pt.value);
          }
        }
        return values;
      };

      function renderAllTraces(): void {
        pendingChartRAF = null;
        if (myGen !== chartRenderGen) return;

        const chartOpts = {
          traces: activeTraces,
          yAxisLabel: metric,
          pinnedOrders: refs.length > 0 ? refs : undefined,
          categoryOrder: scaffold ?? undefined,
          getRawValues: rawValuesCallback,
        };

        if (chartHandle) {
          chartHandle.update(chartOpts);
        } else {
          chartHandle = createTimeSeriesChart(chartContainer, chartOpts);
        }
      }

      if (!batch) {
        // Progressive data loading: render all traces in a single deferred frame.
        // No batching here to avoid the batch sequence being repeatedly canceled
        // by rapid page arrivals.
        if (activeTraces.length === 0) {
          renderAllTraces();
        } else {
          pendingChartRAF = requestAnimationFrame(renderAllTraces);
        }
      } else {
        // User-initiated change (filter, toggle, aggregation, pinned orders):
        // render traces in batches of CHART_BATCH_SIZE per animation frame.
        // This batching prevents the browser from freezing when a filter matches
        // thousands of tests and the 20-cap is disabled — the chart achieves
        // eventual consistency while the UI stays responsive.
        let batchEnd = 0;

        function renderNextBatch(): void {
          pendingChartRAF = null;
          if (myGen !== chartRenderGen) return;

          batchEnd = Math.min(batchEnd + CHART_BATCH_SIZE, activeTraces.length);
          const batchTraces = activeTraces.slice(0, batchEnd);

          const chartOpts = {
            traces: batchTraces,
            yAxisLabel: metric,
            pinnedOrders: refs.length > 0 ? refs : undefined,
            categoryOrder: scaffold ?? undefined,
            getRawValues: rawValuesCallback,
          };

          if (chartHandle) {
            chartHandle.update(chartOpts);
          } else {
            chartHandle = createTimeSeriesChart(chartContainer, chartOpts);
          }

          if (batchEnd < activeTraces.length) {
            pendingChartRAF = requestAnimationFrame(renderNextBatch);
          }
        }

        if (activeTraces.length === 0) {
          renderNextBatch();
        } else {
          pendingChartRAF = requestAnimationFrame(renderNextBatch);
        }
      }
    }

    // ----- Reference orders -----

    async function fetchMissingPinData(
      testsuite: string,
      machineName: string,
      metricName: string,
      entry: MetricCache,
      signal: AbortSignal,
    ): Promise<void> {
      for (const pin of pinnedOrders) {
        const hasData = entry.points.some(pt => primaryOrderValue(pt.order) === pin.value);
        if (hasData || !pin.value) continue;

        try {
          const pinPoints = await queryDataPoints(testsuite, {
            machine: machineName, metric: metricName,
            afterOrder: pin.value, beforeOrder: pin.value,
          }, signal);
          if (pinPoints.length > 0) {
            entry.points.push(...pinPoints);
            if (machines.includes(machineName) && metricName === metric) {
              renderFromAllCaches(false);
            }
          }
        } catch { /* ref order may not exist */ }
      }
    }

    // ----- Scaffold fetching (per machine) -----

    async function fetchScaffold(testsuite: string, machineName: string): Promise<void> {
      if (machineScaffolds.has(machineName)) return;
      const signal = scaffoldAbort?.signal;
      try {
        const seen = new Set<string>();
        const orders: string[] = [];
        let cursor: string | undefined;
        const runsUrl = apiUrl(testsuite, `machines/${encodeURIComponent(machineName)}/runs`);
        while (true) {
          if (signal?.aborted) return;
          if (!machines.includes(machineName)) return;
          const params: Record<string, string> = { sort: 'order', limit: '10000' };
          if (cursor) params.cursor = cursor;
          const page = await fetchOneCursorPage<MachineRunInfo>(runsUrl, params, signal);
          for (const run of page.items) {
            const ov = primaryOrderValue(run.order);
            if (!seen.has(ov)) { seen.add(ov); orders.push(ov); }
          }
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }
        if (!machines.includes(machineName)) return;
        machineScaffolds.set(machineName, orders);
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        /* scaffold is optional */
      }
    }

    // ----- Plot handler -----

    function doPlot(): void {
      if (machines.length === 0 || !metric) {
        chartContainer.replaceChildren(
          el('p', { class: 'no-chart-data' }, 'No data to plot.'),
        );
        return;
      }

      warningContainer.replaceChildren();

      // For each machine, ensure scaffold and data fetching are running
      const plotMetric = metric;
      const plotMachines = [...machines];

      (async () => {
        // Fetch scaffolds for any machines that don't have one yet
        await Promise.all(plotMachines.map(m => fetchScaffold(ts, m)));

        // Rebuild suggestions after scaffolds load
        rebuildSuggestions();

        // Render empty chart with scaffold if available
        const scaffold = computeScaffoldUnion();
        if (plotMetric === metric && scaffold) {
          if (!chartHandle) {
            chartHandle = createTimeSeriesChart(chartContainer, {
              traces: [] as TimeSeriesTrace[],
              yAxisLabel: plotMetric,
              categoryOrder: scaffold,
            });
          }
          progressContainer.replaceChildren(
            el('span', { class: 'progress-label' }, 'Loading data...'),
          );
        }

        // Start lazy loading for each machine
        for (const m of plotMachines) {
          if (machines.includes(m) && plotMetric === metric) {
            const entry = getOrCreateCache(m, plotMetric);
            if (entry.hasInitialData) {
              // Already have data — render immediately
              renderFromAllCaches(false);
              if (!entry.complete && !entry.loading) {
                startLazyLoad(ts, m, plotMetric);
              }
            } else if (!entry.loading) {
              startLazyLoad(ts, m, plotMetric);
            }
          }
        }
      })();

      updateUrlState();
    }

    function updateUrlState(): void {
      const qs = new URLSearchParams();
      for (const m of machines) qs.append('machine', m);
      qs.set('metric', metric);
      if (testFilter) qs.set('test_filter', testFilter);
      if (runAgg !== 'median') qs.set('run_agg', runAgg);
      if (sampleAgg !== 'median') qs.set('sample_agg', sampleAgg);
      for (const ref of pinnedOrders) qs.append('pin', ref.value);
      window.history.replaceState(null, '', window.location.pathname + '?' + qs.toString());
    }

    // Auto-plot if machines and metric provided via URL
    if (machines.length > 0 && metric) {
      doPlot();
    }
  },

  unmount(): void {
    if (machineComboCleanup) { machineComboCleanup(); machineComboCleanup = null; }
    if (orderSearchCleanup) { orderSearchCleanup(); orderSearchCleanup = null; }
    if (scaffoldAbort) { scaffoldAbort.abort(); scaffoldAbort = null; }
    abortAllMetrics();
    if (pendingChartRAF !== null) { cancelAnimationFrame(pendingChartRAF); pendingChartRAF = null; }
    if (chartHandle) { chartHandle.destroy(); chartHandle = null; }
    if (legendHandle) { legendHandle.destroy(); legendHandle = null; }
    if (cleanupTableHover) { cleanupTableHover(); cleanupTableHover = null; }
    if (cleanupChartHover) { cleanupChartHover(); cleanupChartHover = null; }
    manuallyHidden = new Set();
    autoCapped = true;
    currentVisibleTraceNames = [];
    prevActiveTraceNames = new Set();
    chartRenderGen = 0;
    cachedSuggestions = null;
    // Intentionally preserve cache and machineScaffolds across
    // unmount/remount so that navigating back renders instantly from
    // cache. The machines list is restored from URL on mount.
  },
};

/**
 * Group raw query data points into traces, applying test filter and aggregation.
 * Exported for testing.
 */
export function buildTraces(
  points: QueryDataPoint[],
  testFilter: string,
  runAgg: AggFn,
  _sampleAgg: AggFn,
): TimeSeriesTrace[] {
  // Group by test name
  const testMap = new Map<string, QueryDataPoint[]>();
  for (const pt of points) {
    if (testFilter && !pt.test.toLowerCase().includes(testFilter.toLowerCase())) continue;
    let arr = testMap.get(pt.test);
    if (!arr) { arr = []; testMap.set(pt.test, arr); }
    arr.push(pt);
  }

  const aggFn = getAggFn(runAgg);
  const traces: TimeSeriesTrace[] = [];

  for (const [testName, testPoints] of testMap) {
    // Group by order value
    const orderMap = new Map<string, QueryDataPoint[]>();
    for (const pt of testPoints) {
      const ov = primaryOrderValue(pt.order);
      let arr = orderMap.get(ov);
      if (!arr) { arr = []; orderMap.set(ov, arr); }
      arr.push(pt);
    }

    const tracePoints: TimeSeriesTrace['points'] = [];
    for (const [orderValue, orderPoints] of orderMap) {
      const values = orderPoints.map(p => p.value);
      tracePoints.push({
        orderValue,
        value: aggFn(values),
        runCount: orderPoints.length,
        timestamp: orderPoints[0].timestamp,
      });
    }

    // Machine is set by the caller (renderFromAllCaches) after buildTraces returns
    traces.push({ testName, machine: '', points: tracePoints });
  }

  traces.sort((a, b) => a.testName.localeCompare(b.testName));
  return traces;
}

/**
 * Build PinnedOrder objects from cached data points, applying aggregation.
 * Exported for testing.
 */
export function buildRefsFromCache(
  points: QueryDataPoint[],
  refs: Array<{ value: string; tag: string | null }>,
  aggFn: (values: number[]) => number,
): PinnedOrder[] {
  return refs.map((ref, i) => {
    // Collect all raw values per test at this order
    const rawPerTest = new Map<string, number[]>();
    for (const pt of points) {
      if (primaryOrderValue(pt.order) === ref.value) {
        let arr = rawPerTest.get(pt.test);
        if (!arr) { arr = []; rawPerTest.set(pt.test, arr); }
        arr.push(pt.value);
      }
    }
    // Aggregate using the same function as the main traces
    const values = new Map<string, number>();
    for (const [test, raw] of rawPerTest) {
      values.set(test, aggFn(raw));
    }
    return {
      orderValue: ref.value,
      tag: ref.tag,
      values,
      color: PIN_COLORS[i % PIN_COLORS.length],
    };
  });
}
