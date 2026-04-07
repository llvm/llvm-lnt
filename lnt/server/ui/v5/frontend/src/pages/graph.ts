// pages/graph.ts — Time-series graph page with lazy loading and client-side caching.

import type { PageModule, RouteParams } from '../router';
import type { AggFn, QueryDataPoint, CursorPaginated } from '../types';
import { getFields, getOrders, fetchOneCursorPage, postOneCursorPage, apiUrl, queryDataPoints, getTests } from '../api';
import type { MachineRunInfo } from '../types';
import { el, debounce, getAggFn, primaryOrderValue, TRACE_SEP } from '../utils';
import { getTestsuites } from '../router';
import { onCustomEvent, GRAPH_TABLE_HOVER, GRAPH_CHART_HOVER } from '../events';
import { renderMachineCombobox } from '../components/machine-combobox';
import { renderMetricSelector, filterMetricFields } from '../components/metric-selector';
import { createOrderPicker, fetchMachineOrderSet } from '../combobox';
import {
  type TimeSeriesTrace, type PinnedBaseline, type ChartHandle,
  createTimeSeriesChart,
} from '../components/time-series-chart';
import { createLegendTable, type LegendEntry, type LegendTableHandle } from '../components/legend-table';

const MAX_DISPLAYED_TESTS = 50;
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
// Per-test cache — keyed by 'machine::metric::test'
// ---------------------------------------------------------------------------

interface PerTestCache {
  points: QueryDataPoint[];
  complete: boolean;
}

const MAX_CACHE_ENTRIES = 500;
let perTestCache = new Map<string, PerTestCache>();
/** LRU access order — most recently accessed key at the end. */
let cacheAccessOrder: string[] = [];

/** Per-machine scaffolds (order values). */
let machineScaffolds = new Map<string, string[]>();
let fetchAbort: AbortController | null = null;
/** Cache for baseline data: key = `suite::machine::order::metric`, value = QueryDataPoint[] */
let baselineDataCache = new Map<string, QueryDataPoint[]>();
/** Per-suite order list cache for baseline order picker. */
let baselineOrderCache = new Map<string, { values: string[]; tags: Map<string, string | null> }>();
/** Machine-order filter set for the baseline order picker (null = loading or no machine). */
let blMachineOrders: Set<string> | null = null;

/** A cross-suite baseline reference line. */
export interface Baseline {
  suite: string;
  machine: string;
  order: string;
  tag: string | null;
}

function perTestKey(machine: string, metric: string, test: string): string {
  return `${machine}::${metric}::${test}`;
}

/** Touch a cache key in the LRU order and evict if over limit. */
function touchCache(key: string): void {
  const idx = cacheAccessOrder.indexOf(key);
  if (idx >= 0) cacheAccessOrder.splice(idx, 1);
  cacheAccessOrder.push(key);
  while (cacheAccessOrder.length > MAX_CACHE_ENTRIES) {
    const evict = cacheAccessOrder.shift()!;
    perTestCache.delete(evict);
  }
}

function abortFetches(): void {
  if (fetchAbort) { fetchAbort.abort(); fetchAbort = null; }
}

/** The currently-discovered test names (from the last discoverTests call). */
let discoveredTests: string[] = [];
/** Whether there are more tests than MAX_DISPLAYED_TESTS matching the filter. */
let discoveredTruncated = false;

// ---------------------------------------------------------------------------
// Module-scope UI state
// ---------------------------------------------------------------------------

let machineComboCleanup: (() => void) | null = null;
let blMachineCleanup: (() => void) | null = null;
let blOrderCleanup: (() => void) | null = null;
let chartHandle: ChartHandle | null = null;
let legendHandle: LegendTableHandle | null = null;
let manuallyHidden = new Set<string>();
/** Current visible trace names (updated on each render, used by legend callbacks). */
let currentVisibleTraceNames: string[] = [];
/** The active trace name set from the last chart render, used to skip no-op chart updates. */
let prevActiveTraceNames = new Set<string>();
/** Pending requestAnimationFrame ID for deferred chart updates. */
let pendingChartRAF: number | null = null;
/** Generation counter to cancel stale batched chart renders. */
let chartRenderGen = 0;
/** The currently selected suite — replaces the old closure-captured `ts`. */
let currentSuite = '';
/** Generation counter: incremented on suite change, checked by async callbacks. */
let suiteGeneration = 0;
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
  _testFilter: string,
  hidden: Set<string>,
): Set<string> {
  // Remove manually hidden
  return new Set(allTraceNames.filter(n => !hidden.has(n)));
}

export const graphPage: PageModule = {
  mount(container: HTMLElement, _params: RouteParams): void {
    // Suite is no longer from the route — it's a URL parameter or user selection.
    const urlParams = new URLSearchParams(window.location.search);
    const urlSuite = urlParams.get('suite') || '';
    // Create a fresh abort controller for all async fetches this mount cycle.
    fetchAbort = new AbortController();
    container.append(el('h2', { class: 'page-header' }, 'Graph'));

    // Parse URL state — URL is always the source of truth on mount.
    machines = urlParams.getAll('machine').filter(Boolean);
    let metric = urlParams.get('metric') || '';
    let testFilter = urlParams.get('test_filter') || '';
    let runAgg: AggFn = (['median', 'mean', 'min', 'max'] as AggFn[]).includes(urlParams.get('run_agg') as AggFn)
      ? urlParams.get('run_agg') as AggFn : 'median';
    let sampleAgg: AggFn = (['median', 'mean', 'min', 'max'] as AggFn[]).includes(urlParams.get('sample_agg') as AggFn)
      ? urlParams.get('sample_agg') as AggFn : 'median';
    // Baselines encoded as "suite::machine::order". The "::" separator is an
    // in-band delimiter — names containing "::" would be misparsed. This is
    // acceptable for an internal tool where such names are extremely unlikely.
    const baselineParams = urlParams.getAll('baseline');
    const baselines: Baseline[] = baselineParams.map(v => {
      const parts = v.split('::');
      return { suite: parts[0] || '', machine: parts[1] || '', order: parts[2] || '', tag: null };
    }).filter(b => b.suite && b.machine && b.order);

    // Progress + chart containers
    const progressContainer = el('div', {});
    const warningContainer = el('div', {});
    const chartContainer = el('div', {},
      el('p', { class: 'no-chart-data' }, 'No data to plot.'),
    );

    // ----- Controls Panel -----
    const controlsPanel = el('div', { class: 'controls-panel' });
    container.append(controlsPanel);

    // ----- Suite selector — required, all other controls disabled until selected -----
    const suiteGroup = el('div', { class: 'control-group' });
    suiteGroup.append(el('label', {}, 'Suite'));
    const suiteSelect = el('select', { class: 'suite-select' }) as HTMLSelectElement;
    const emptyOpt = el('option', { value: '' }, '-- Select suite --');
    suiteSelect.append(emptyOpt);
    const availSuites = getTestsuites();
    for (const name of availSuites) {
      const opt = el('option', { value: name }, name);
      if (name === urlSuite) (opt as HTMLOptionElement).selected = true;
      suiteSelect.append(opt);
    }
    // Auto-select if only one suite
    if (!urlSuite && availSuites.length === 1) {
      suiteSelect.value = availSuites[0];
    }
    currentSuite = suiteSelect.value;

    // ----- Controls Row 1: Suite, Metric, Test Filter, Aggregation -----
    const controlsRow = el('div', { class: 'graph-controls' });
    controlsRow.append(suiteGroup);
    controlsPanel.append(controlsRow);

    // Metric selector (loaded async — actual fetch deferred until suite is set)
    const metricGroup = el('div', {});
    metricGroup.append(el('span', { class: 'progress-label' }, 'Select a suite to load metrics...'));
    controlsRow.append(metricGroup);

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
      updateUrlState();
      if (machines.length > 0 && metric) doPlot();
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
      renderFromDiscoveredTests();
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
      renderFromDiscoveredTests();
      updateUrlState();
    });
    sampleAggGroup.append(sampleAggSelect);
    controlsRow.append(sampleAggGroup);

    // ----- Controls Row 2: Machines + Baselines (side by side) -----
    const secondRow = el('div', { class: 'graph-controls graph-controls-top' });
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
          machines = machines.filter(x => x !== m);
          machineScaffolds.delete(m);
          for (const key of [...perTestCache.keys()]) {
            if (key.startsWith(m + '::')) {
              perTestCache.delete(key);
              cacheAccessOrder = cacheAccessOrder.filter(k => k !== key);
            }
          }
          renderMachineChips();
          if (machines.length > 0 && metric) {
            doPlot();
          } else {
            // No machines left — show empty state
            renderFromDiscoveredTests();
          }
          updateUrlState();
        });
        chip.append(removeBtn);
        machineChipsEl.append(chip);
      }
    }

    const machineHandle = renderMachineCombobox(machineInputContainer, {
      testsuite: currentSuite,
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

    // Baselines (same row as Machines)
    const baselineGroup = el('div', { class: 'control-group' });
    baselineGroup.append(el('label', {}, 'Baselines'));
    const baselineChips = el('div', { class: 'chip-list', style: 'margin-top: 4px' });
    const baselineFormContainer = el('div', { class: 'baseline-form', style: 'display: none' });
    const addBaselineBtn = el('button', { class: 'add-baseline-btn' }, '+ Add baseline');

    // Baseline form: Suite, Machine, Order in a horizontal row
    const blSuiteSelect = el('select', { class: 'suite-select baseline-suite' }) as HTMLSelectElement;
    blSuiteSelect.append(el('option', { value: '' }, '-- Suite --'));
    for (const name of getTestsuites()) {
      blSuiteSelect.append(el('option', { value: name }, name));
    }
    const blMachineContainer = el('div', {});
    const blOrderContainer = el('div', {});
    let blSelectedMachine = '';

    function addCurrentBaseline(): void {
      const suite = blSuiteSelect.value;
      if (!suite || !blSelectedMachine || !blSelectedOrder) return;
      // Avoid duplicates
      if (baselines.find(b => b.suite === suite && b.machine === blSelectedMachine && b.order === blSelectedOrder)) return;
      baselines.push({ suite, machine: blSelectedMachine, order: blSelectedOrder, tag: null });
      renderBaselineChips();
      fetchAllBaselineData(discoveredTests).then(() => renderFromDiscoveredTests());
      updateUrlState();
      // Reset: keep form open for adding more, but clear selections
      blSelectedMachine = '';
      blSelectedOrder = '';
      blSuiteSelect.value = '';
      blSuiteSelect.dispatchEvent(new Event('change'));
    }

    // Track the selected order — set by onSelect callback from order search
    let blSelectedOrder = '';

    blSuiteSelect.addEventListener('change', () => {
      blSelectedMachine = '';
      blSelectedOrder = '';
      if (blMachineCleanup) { blMachineCleanup(); blMachineCleanup = null; }
      if (blOrderCleanup) { blOrderCleanup(); blOrderCleanup = null; }
      blMachineContainer.replaceChildren();
      blOrderContainer.replaceChildren();

      const suite = blSuiteSelect.value;
      if (!suite) return;

      const handle = renderMachineCombobox(blMachineContainer, {
        testsuite: suite,
        onSelect: async (name) => {
          blSelectedMachine = name;
          blSelectedOrder = '';
          blMachineOrders = null;
          if (blOrderCleanup) { blOrderCleanup(); blOrderCleanup = null; }
          blOrderContainer.replaceChildren();


          // Fetch order list and machine orders in parallel
          const orderListPromise = (async () => {
            if (baselineOrderCache.has(suite)) return;
            try {
              const orders = await getOrders(suite, fetchAbort?.signal);
              const values: string[] = [];
              const tags = new Map<string, string | null>();
              for (const o of orders) {
                const v = primaryOrderValue(o.fields);
                values.push(v);
                tags.set(v, o.tag ?? null);
              }
              baselineOrderCache.set(suite, { values, tags });
            } catch (err: unknown) {
              if (err instanceof DOMException && err.name === 'AbortError') return;
              baselineOrderCache.set(suite, { values: [], tags: new Map() });
            }
          })();
          const machineOrdersPromise = fetchMachineOrderSet(suite, name)
            .catch(() => null as Set<string> | null);

          await orderListPromise;

          // Create order picker with machine-order filtering
          const picker = createOrderPicker({
            id: 'baseline-order',
            getOrderData: () => {
              const d = baselineOrderCache.get(suite);
              return d ?? { values: [], tags: new Map() };
            },
            placeholder: 'Type to search orders...',
            onSelect: (value) => {
              blSelectedOrder = value;
              addCurrentBaseline();
            },
            getMachineOrders: () => blSelectedMachine ? (blMachineOrders ?? 'loading') : null,
          });
          blOrderContainer.append(picker.element);
          blOrderCleanup = picker.destroy;

          // Apply machine orders once ready (may already be resolved)
          const machineOrders = await machineOrdersPromise;
          blMachineOrders = machineOrders;
        },
        onClear: () => {
          blSelectedMachine = '';
          blSelectedOrder = '';
          blMachineOrders = null;
          if (blOrderCleanup) { blOrderCleanup(); blOrderCleanup = null; }
          blOrderContainer.replaceChildren();
        },
      });
      blMachineCleanup = handle.destroy;
    });

    addBaselineBtn.addEventListener('click', () => {
      baselineFormContainer.style.display = '';
      addBaselineBtn.style.display = 'none';
    });

    // Horizontal row for Suite → Machine → Order
    const formRow = el('div', { class: 'baseline-form-row' });
    formRow.append(blSuiteSelect, blMachineContainer, blOrderContainer);
    baselineFormContainer.append(formRow);
    baselineGroup.append(addBaselineBtn, baselineFormContainer, baselineChips);
    secondRow.append(baselineGroup);

    renderBaselineChips();

    function renderBaselineChips(): void {
      baselineChips.replaceChildren();
      for (const bl of baselines) {
        const label = bl.tag ? `${bl.suite}/${bl.machine}/${bl.order} (${bl.tag})` : `${bl.suite}/${bl.machine}/${bl.order}`;
        const chip = el('span', { class: 'chip' }, label);
        const removeBtn = el('button', { class: 'chip-remove' }, '\u00d7');
        removeBtn.addEventListener('click', () => {
          const idx = baselines.indexOf(bl);
          if (idx >= 0) baselines.splice(idx, 1);
          // Remove cached data for this baseline
          for (const key of [...baselineDataCache.keys()]) {
            if (key.startsWith(`${bl.suite}::${bl.machine}::${bl.order}::`)) {
              baselineDataCache.delete(key);
            }
          }
          renderBaselineChips();
          renderFromDiscoveredTests();
          updateUrlState();
        });
        chip.append(removeBtn);
        baselineChips.append(chip);
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

    // ----- Test discovery + targeted data loading -----

    /**
     * Discover test names matching the current filter for the selected
     * machines and metric. Calls GET /tests?machine=M&metric=Y&name_contains=...
     * per machine, takes the union, and caps at MAX_DISPLAYED_TESTS.
     */
    async function discoverTests(
      testsuite: string, machineList: string[], metricName: string,
      filter: string, signal?: AbortSignal,
    ): Promise<{ names: string[]; truncated: boolean }> {
      const allNames = new Set<string>();
      let anyTruncated = false;
      // Query each machine in parallel
      const results = await Promise.all(machineList.map(m =>
        getTests(testsuite, {
          machine: m,
          metric: metricName,
          nameContains: filter || undefined,
          limit: MAX_DISPLAYED_TESTS + 1,
        }, signal),
      ));
      for (const page of results) {
        for (const t of page.items) allNames.add(t.name);
        if (page.nextCursor) anyTruncated = true;
      }
      const sorted = [...allNames].sort((a, b) => a.localeCompare(b));
      if (sorted.length > MAX_DISPLAYED_TESTS) {
        return { names: sorted.slice(0, MAX_DISPLAYED_TESTS), truncated: true };
      }
      return { names: sorted, truncated: anyTruncated };
    }

    /**
     * Fetch data for uncached tests on a single machine. Issues one
     * paginated GET /query?machine=M&metric=Y&test=T1&test=T2&...
     * Distributes incoming points into per-test cache entries.
     */
    async function fetchUncachedTests(
      testsuite: string, machineName: string, metricName: string,
      testNames: string[], signal?: AbortSignal,
    ): Promise<void> {
      // Find which tests are not yet cached.
      const uncached = testNames.filter(t => {
        const key = perTestKey(machineName, metricName, t);
        const entry = perTestCache.get(key);
        return !entry || !entry.complete;
      });
      if (uncached.length === 0) return;

      // Initialize cache entries for uncached tests.
      for (const t of uncached) {
        const key = perTestKey(machineName, metricName, t);
        if (!perTestCache.has(key)) {
          perTestCache.set(key, { points: [], complete: false });
        }
        touchCache(key);
      }

      // Single paginated POST query for all uncached tests.
      const queryUrl = apiUrl(testsuite, 'query');
      let cursor: string | undefined;
      while (true) {
        if (signal?.aborted) return;
        const body: Record<string, unknown> = {
          machine: machineName,
          metric: metricName,
          test: uncached,
          sort: 'test,order',
          limit: parseInt(PAGE_LIMIT, 10),
        };
        if (cursor) body.cursor = cursor;

        const page = await postOneCursorPage<QueryDataPoint>(queryUrl, body, signal);

        // Distribute points into per-test caches.
        for (const pt of page.items) {
          const key = perTestKey(machineName, metricName, pt.test);
          const entry = perTestCache.get(key);
          if (entry) entry.points.push(pt);
        }

        if (!page.nextCursor) break;
        cursor = page.nextCursor;

        // Progressive render after each page.
        if (machines.includes(machineName) && metricName === metric) {
          renderFromDiscoveredTests(false);
        }
      }

      // Mark all uncached tests as complete.
      for (const t of uncached) {
        const key = perTestKey(machineName, metricName, t);
        const entry = perTestCache.get(key);
        if (entry) entry.complete = true;
      }
    }

    // ----- Render from discovered tests -----

    function renderFromDiscoveredTests(batch = true): void {
      if (discoveredTests.length === 0 || machines.length === 0 || !metric) {
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

      // Collect data from per-test caches for each machine.
      let anyHasData = false;
      let allComplete = true;
      let totalPoints = 0;

      // Build traces per machine.
      const allTraces: TimeSeriesTrace[] = [];
      const allTraceNames: string[] = [];

      // Assign colors by test name (same test on different machines = same color).
      const colorMap = new Map<string, string>();
      discoveredTests.forEach((name, i) => colorMap.set(name, assignColor(i)));

      for (let mi = 0; mi < machines.length; mi++) {
        const m = machines[mi];
        const symbol = assignSymbol(mi);

        for (const testName of discoveredTests) {
          const key = perTestKey(m, metric, testName);
          const entry = perTestCache.get(key);
          if (!entry || entry.points.length === 0) {
            if (!entry?.complete) allComplete = false;
            continue;
          }

          anyHasData = true;
          totalPoints += entry.points.length;
          if (!entry.complete) allComplete = false;

          const machineTraces = buildTraces(entry.points, runAgg, sampleAgg);
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
      }

      if (!anyHasData) {
        // No data yet — show empty chart with scaffold
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
        progressContainer.replaceChildren(
          el('span', { class: 'progress-label' }, 'Loading data...'),
        );
        return;
      }

      // Sort all trace names for consistent ordering.
      allTraceNames.sort((a, b) => a.localeCompare(b));
      currentVisibleTraceNames = allTraceNames;

      // Compute active set (remove manually hidden).
      const activeSet = computeActiveTests(allTraceNames, testFilter, manuallyHidden);

      // Filter traces to only active ones.
      const activeTraces = allTraces
        .filter(t => activeSet.has(traceName(t.testName, t.machine)))
        .sort((a, b) => traceName(a.testName, a.machine).localeCompare(traceName(b.testName, b.machine)));

      // --- Synchronous phase: legend table + progress ---

      const legendEntries: LegendEntry[] = allTraceNames.map(tn => {
        const testN = testNameFromTrace(tn);
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
      let legendMessage: string | undefined;
      if (discoveredTruncated) {
        legendMessage = `Showing first ${MAX_DISPLAYED_TESTS} of ${MAX_DISPLAYED_TESTS}+ matching tests. Refine the filter to see others.`;
      } else if (allTraceNames.length > 0) {
        legendMessage = `${discoveredTests.length} tests, ${allTraceNames.length} traces`;
      }

      if (legendHandle) {
        legendHandle.update(legendEntries, legendMessage);
      } else {
        legendHandle = createLegendTable(legendContainer, {
          entries: legendEntries,
          message: legendMessage,
          onToggle: (tn) => {
            if (manuallyHidden.has(tn)) {
              manuallyHidden.delete(tn);
            } else {
              manuallyHidden.add(tn);
            }
            renderFromDiscoveredTests();
          },
          onIsolate: (tn) => {
            const othersAllHidden = currentVisibleTraceNames.every(
              n => n === tn || manuallyHidden.has(n),
            );
            if (othersAllHidden) {
              manuallyHidden = new Set();
            } else {
              manuallyHidden = new Set(currentVisibleTraceNames.filter(n => n !== tn));
            }
            renderFromDiscoveredTests();
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

      // Collect all points for raw values callback.
      const allPoints: QueryDataPoint[] = [];
      for (const testName of discoveredTests) {
        for (const m of machines) {
          const entry = perTestCache.get(perTestKey(m, metric, testName));
          if (entry) for (const pt of entry.points) allPoints.push(pt);
        }
      }

      const refs = buildBaselinesFromData(baselines, baselineDataCache, metric, getAggFn(runAgg));
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
          baselines: refs.length > 0 ? refs : undefined,
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
        // Progressive data loading: render in a single deferred frame.
        if (activeTraces.length === 0) {
          renderAllTraces();
        } else {
          pendingChartRAF = requestAnimationFrame(renderAllTraces);
        }
      } else {
        // User-initiated change: render traces in batches.
        let batchEnd = 0;

        function renderNextBatch(): void {
          pendingChartRAF = null;
          if (myGen !== chartRenderGen) return;

          batchEnd = Math.min(batchEnd + CHART_BATCH_SIZE, activeTraces.length);
          const batchTraces = activeTraces.slice(0, batchEnd);

          const chartOpts = {
            traces: batchTraces,
            yAxisLabel: metric,
            baselines: refs.length > 0 ? refs : undefined,
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

    // ----- Baseline data fetching -----

    async function fetchAllBaselineData(testNames: string[]): Promise<void> {
      if (!metric || baselines.length === 0 || testNames.length === 0) return;
      const myGen = suiteGeneration;
      const signal = fetchAbort?.signal;

      for (const bl of baselines) {
        const blCacheKey = `${bl.suite}::${bl.machine}::${bl.order}::${metric}`;
        if (baselineDataCache.has(blCacheKey)) continue;

        try {
          const points = await queryDataPoints(bl.suite, {
            machine: bl.machine,
            metric,
            order: bl.order,
            test: testNames,
          }, signal);
          if (myGen !== suiteGeneration) return;
          baselineDataCache.set(blCacheKey, points);
        } catch {
          // Baseline data is optional — silently ignore errors
        }
      }
    }

    // ----- Scaffold fetching (per machine) -----

    async function fetchScaffold(testsuite: string, machineName: string): Promise<void> {
      if (machineScaffolds.has(machineName)) return;
      const signal = fetchAbort?.signal;
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

      const plotMetric = metric;
      const plotFilter = testFilter;
      const plotMachines = [...machines];

      // Abort any in-flight fetches from a previous doPlot call.
      abortFetches();
      fetchAbort = new AbortController();
      const signal = fetchAbort.signal;

      (async () => {
        try {
          // 1. Fetch scaffolds for any machines that don't have one yet.
          await Promise.all(plotMachines.map(m => fetchScaffold(currentSuite, m)));

          // Render empty chart with scaffold while loading.
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
              el('span', { class: 'progress-label' }, 'Discovering tests...'),
            );
          }

          // 2. Discover matching test names.
          const { names, truncated } = await discoverTests(
            currentSuite, plotMachines, plotMetric, plotFilter, signal);
          if (signal.aborted || plotMetric !== metric) return;
          discoveredTests = names;
          discoveredTruncated = truncated;
          manuallyHidden = new Set(); // Reset toggles on new discovery.
          baselineDataCache.clear(); // Baseline data is test-scoped; re-fetch for new tests.

          // Render immediately from cache (tests that are already cached show instantly).
          renderFromDiscoveredTests(false);

          // 3. Fetch uncached test data for each machine.
          await Promise.all(plotMachines.map(m =>
            fetchUncachedTests(currentSuite, m, plotMetric, names, signal)));
          if (signal.aborted || plotMetric !== metric) return;

          // Final render with all data complete.
          renderFromDiscoveredTests(false);

          // 4. Fetch baseline data.
          if (baselines.length > 0) {
            await fetchAllBaselineData(names);
            if (!signal.aborted && plotMetric === metric) {
              renderFromDiscoveredTests(false);
            }
          }
        } catch (e: unknown) {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          warningContainer.replaceChildren(
            el('p', { class: 'error-banner' }, `Failed to load data: ${e}`),
          );
        }
      })();

      updateUrlState();
    }

    function updateUrlState(): void {
      const qs = new URLSearchParams();
      qs.set('suite', currentSuite);
      for (const m of machines) qs.append('machine', m);
      qs.set('metric', metric);
      if (testFilter) qs.set('test_filter', testFilter);
      if (runAgg !== 'median') qs.set('run_agg', runAgg);
      if (sampleAgg !== 'median') qs.set('sample_agg', sampleAgg);
      for (const bl of baselines) qs.append('baseline', `${bl.suite}::${bl.machine}::${bl.order}`);
      window.history.replaceState(null, '', window.location.pathname + '?' + qs.toString());
    }

    // ----- Suite change handler -----
    suiteSelect.addEventListener('change', () => {
      const newSuite = suiteSelect.value;
      if (newSuite === currentSuite) return;
      currentSuite = newSuite;
      suiteGeneration++;

      // Abort all in-flight fetches
      abortFetches();

      // Clear ALL module-level state
      machines = [];
      perTestCache = new Map();
      cacheAccessOrder = [];
      discoveredTests = [];
      discoveredTruncated = false;
      machineScaffolds = new Map();
      baselineDataCache.clear();
      baselineOrderCache.clear();
      blMachineOrders = null;
      manuallyHidden = new Set();
      currentVisibleTraceNames = [];
      prevActiveTraceNames = new Set();
      baselines.length = 0;
      if (pendingChartRAF !== null) { cancelAnimationFrame(pendingChartRAF); pendingChartRAF = null; }
      chartRenderGen = 0;

      // Destroy UI components
      if (chartHandle) { chartHandle.destroy(); chartHandle = null; }
      if (legendHandle) { legendHandle.destroy(); legendHandle = null; }
      if (machineComboCleanup) { machineComboCleanup(); machineComboCleanup = null; }
      if (blMachineCleanup) { blMachineCleanup(); blMachineCleanup = null; }
      if (blOrderCleanup) { blOrderCleanup(); blOrderCleanup = null; }

      // Clear controls containers
      machineChipsEl.replaceChildren();
      baselineChips.replaceChildren();
      // Reset baseline form
      baselineFormContainer.style.display = 'none';
      addBaselineBtn.style.display = '';
      blSuiteSelect.value = '';
      blMachineContainer.replaceChildren();
      blOrderContainer.replaceChildren();
      blSelectedMachine = '';
      blSelectedOrder = '';
      chartContainer.replaceChildren(el('p', { class: 'no-chart-data' }, 'No data to plot.'));
      legendContainer.replaceChildren();
      progressContainer.replaceChildren();
      warningContainer.replaceChildren();

      if (!newSuite) {
        updateUrlState();
        return;
      }

      // Re-create machine combobox for new suite
      machineInputContainer.replaceChildren();
      const newMachineHandle = renderMachineCombobox(machineInputContainer, {
        testsuite: currentSuite,
        onSelect: (name) => {
          if (!machines.includes(name)) {
            machines.push(name);
            renderMachineChips();
            newMachineHandle.clear();
            if (metric) doPlot();
            updateUrlState();
          }
        },
      });
      machineComboCleanup = newMachineHandle.destroy;

      // Re-fetch fields for new suite
      fetchAbort = new AbortController();
      loadFieldsForSuite(currentSuite);

      updateUrlState();
    });
    suiteGroup.append(suiteSelect);

    // Fetch initial fields for the selected suite (deferred to here so
    // currentSuite is set correctly from the suite selector).
    function loadFieldsForSuite(suite: string): void {
      const myGen = suiteGeneration;
      metricGroup.replaceChildren(el('span', { class: 'progress-label' }, 'Loading metrics...'));
      getFields(suite).then(fields => {
        if (myGen !== suiteGeneration) return;
        metricGroup.replaceChildren();
        const initial = renderMetricSelector(metricGroup, filterMetricFields(fields), (m) => {
          metric = m;
          updateUrlState();
          if (machines.length > 0) doPlot();
        }, metric || undefined, { placeholder: true });
        if (!metric) metric = initial;
      }).catch(() => {
        if (myGen !== suiteGeneration) return;
        metricGroup.replaceChildren(el('p', { class: 'error-banner' }, 'Failed to load fields'));
      });
    }
    if (currentSuite) {
      loadFieldsForSuite(currentSuite);
    }

    // Auto-plot if machines and metric provided via URL
    if (machines.length > 0 && metric) {
      doPlot();
    }
  },

  unmount(): void {
    if (machineComboCleanup) { machineComboCleanup(); machineComboCleanup = null; }
    if (blMachineCleanup) { blMachineCleanup(); blMachineCleanup = null; }
    if (blOrderCleanup) { blOrderCleanup(); blOrderCleanup = null; }
    abortFetches();
    if (pendingChartRAF !== null) { cancelAnimationFrame(pendingChartRAF); pendingChartRAF = null; }
    if (chartHandle) { chartHandle.destroy(); chartHandle = null; }
    if (legendHandle) { legendHandle.destroy(); legendHandle = null; }
    if (cleanupTableHover) { cleanupTableHover(); cleanupTableHover = null; }
    if (cleanupChartHover) { cleanupChartHover(); cleanupChartHover = null; }
    manuallyHidden = new Set();
    currentVisibleTraceNames = [];
    prevActiveTraceNames = new Set();
    chartRenderGen = 0;
    currentSuite = '';
    suiteGeneration = 0;
    discoveredTests = [];
    discoveredTruncated = false;
    baselineDataCache.clear();
    baselineOrderCache.clear();
    blMachineOrders = null;
    // Intentionally preserve perTestCache and machineScaffolds across
    // unmount/remount so that navigating back renders instantly from
    // cache. The machines list is restored from URL on mount.
  },
};

/**
 * Group raw query data points into traces, applying aggregation.
 * Exported for testing.
 */
export function buildTraces(
  points: QueryDataPoint[],
  runAgg: AggFn,
  _sampleAgg: AggFn,
): TimeSeriesTrace[] {
  // Group by test name
  const testMap = new Map<string, QueryDataPoint[]>();
  for (const pt of points) {
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

    // Machine is set by the caller (renderFromDiscoveredTests) after buildTraces returns
    traces.push({ testName, machine: '', points: tracePoints });
  }

  traces.sort((a, b) => a.testName.localeCompare(b.testName));
  return traces;
}

/**
 * Build PinnedBaseline objects from baseline data cache, applying aggregation.
 * Exported for testing.
 */
export function buildBaselinesFromData(
  baselines: Array<{ suite: string; machine: string; order: string; tag: string | null }>,
  baselineDataCache: Map<string, QueryDataPoint[]>,
  metric: string,
  aggFn: (values: number[]) => number,
): PinnedBaseline[] {
  return baselines.map((bl, i) => {
    const cacheKey = `${bl.suite}::${bl.machine}::${bl.order}::${metric}`;
    const points = baselineDataCache.get(cacheKey) ?? [];

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

    const label = bl.tag
      ? `${bl.suite}/${bl.machine}/${bl.order} (${bl.tag})`
      : `${bl.suite}/${bl.machine}/${bl.order}`;

    return {
      label,
      tag: bl.tag,
      values,
      color: PIN_COLORS[i % PIN_COLORS.length],
    };
  });
}
