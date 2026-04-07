// pages/graph.ts — Time-series graph page with lazy loading and client-side caching.

import type { PageModule, RouteParams } from '../router';
import type { AggFn, QueryDataPoint } from '../types';
import { getFields, fetchOneCursorPage, apiUrl, queryDataPoints } from '../api';
import type { MachineRunInfo } from '../types';
import { el, debounce, getAggFn, primaryOrderValue, TRACE_SEP } from '../utils';
import { getTestsuites } from '../router';
import { onCustomEvent, GRAPH_TABLE_HOVER, GRAPH_CHART_HOVER } from '../events';
import { renderMachineCombobox } from '../components/machine-combobox';
import { renderMetricSelector, filterMetricFields } from '../components/metric-selector';
import { renderOrderSearch } from '../components/order-search';
import {
  type TimeSeriesTrace, type PinnedBaseline, type ChartHandle,
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
/** Cache for baseline data: key = `suite::machine::order::metric`, value = QueryDataPoint[] */
let baselineDataCache = new Map<string, QueryDataPoint[]>();

/** A cross-suite baseline reference line. */
export interface Baseline {
  suite: string;
  machine: string;
  order: string;
  tag: string | null;
}

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
let blMachineCleanup: (() => void) | null = null;
let blOrderCleanup: (() => void) | null = null;
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
  mount(container: HTMLElement, _params: RouteParams): void {
    // Suite is no longer from the route — it's a URL parameter or user selection.
    const urlParams = new URLSearchParams(window.location.search);
    const urlSuite = urlParams.get('suite') || '';
    // Create a fresh abort controller for scaffold fetches this mount cycle.
    scaffoldAbort = new AbortController();
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

    // ----- Controls Row 2: Machines + Baselines (side by side) -----
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

    // Baseline form: Suite → Machine → Order → Add
    const blSuiteSelect = el('select', { class: 'suite-select baseline-suite' }) as HTMLSelectElement;
    blSuiteSelect.append(el('option', { value: '' }, '-- Suite --'));
    for (const name of getTestsuites()) {
      blSuiteSelect.append(el('option', { value: name }, name));
    }
    const blMachineContainer = el('div', {});
    const blOrderContainer = el('div', {});
    const blAddBtn = el('button', { class: 'baseline-add-btn', disabled: 'true' }, 'Add');
    let blSelectedMachine = '';
    let blSelectedOrder = '';
    let blSelectedTag: string | null = null;

    blSuiteSelect.addEventListener('change', () => {
      blSelectedMachine = '';
      blSelectedOrder = '';
      blSelectedTag = null;
      (blAddBtn as HTMLButtonElement).disabled = true;
      if (blMachineCleanup) { blMachineCleanup(); blMachineCleanup = null; }
      if (blOrderCleanup) { blOrderCleanup(); blOrderCleanup = null; }
      blMachineContainer.replaceChildren();
      blOrderContainer.replaceChildren();

      const suite = blSuiteSelect.value;
      if (!suite) return;

      const handle = renderMachineCombobox(blMachineContainer, {
        testsuite: suite,
        onSelect: (name) => {
          blSelectedMachine = name;
          blSelectedOrder = '';
          blSelectedTag = null;
          (blAddBtn as HTMLButtonElement).disabled = true;
          if (blOrderCleanup) { blOrderCleanup(); blOrderCleanup = null; }
          blOrderContainer.replaceChildren();
          const orderHandle = renderOrderSearch(blOrderContainer, {
            testsuite: suite,
            placeholder: 'Select order...',
            onSelect: (value) => {
              blSelectedOrder = value;
              blSelectedTag = null; // tag lookup could be added later
              (blAddBtn as HTMLButtonElement).disabled = false;
            },
          });
          blOrderCleanup = orderHandle.destroy;
        },
      });
      blMachineCleanup = handle.destroy;
    });

    blAddBtn.addEventListener('click', () => {
      const suite = blSuiteSelect.value;
      if (!suite || !blSelectedMachine || !blSelectedOrder) return;
      // Avoid duplicates
      if (baselines.find(b => b.suite === suite && b.machine === blSelectedMachine && b.order === blSelectedOrder)) return;
      baselines.push({ suite, machine: blSelectedMachine, order: blSelectedOrder, tag: blSelectedTag });
      renderBaselineChips();
      fetchAllBaselineData().then(() => renderFromAllCaches());
      updateUrlState();
      // Reset form
      blSuiteSelect.value = '';
      blSuiteSelect.dispatchEvent(new Event('change'));
      baselineFormContainer.style.display = 'none';
      addBaselineBtn.style.display = '';
    });

    addBaselineBtn.addEventListener('click', () => {
      baselineFormContainer.style.display = '';
      addBaselineBtn.style.display = 'none';
    });

    baselineFormContainer.append(
      el('div', { class: 'baseline-form-row' }, blSuiteSelect),
      el('div', { class: 'baseline-form-row' }, blMachineContainer),
      el('div', { class: 'baseline-form-row' }, blOrderContainer),
      blAddBtn,
    );
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
          renderFromAllCaches();
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

          // Fetch baseline data after loading completes
          if (!ctrl.signal.aborted && machines.includes(machineName) && metricName === metric) {
            await fetchAllBaselineData();
            if (!ctrl.signal.aborted && machines.includes(machineName) && metricName === metric) {
              renderFromAllCaches(false);
            }
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

      // Collect all chronological points for raw values callback
      const allPoints: QueryDataPoint[] = [];
      for (const { points } of allChronological) {
        for (const pt of points) allPoints.push(pt);
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
        // Progressive data loading: render all traces in a single deferred frame.
        // No batching here to avoid the batch sequence being repeatedly canceled
        // by rapid page arrivals.
        if (activeTraces.length === 0) {
          renderAllTraces();
        } else {
          pendingChartRAF = requestAnimationFrame(renderAllTraces);
        }
      } else {
        // User-initiated change (filter, toggle, aggregation, baselines):
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

    async function fetchAllBaselineData(): Promise<void> {
      if (!metric || baselines.length === 0) return;
      const myGen = suiteGeneration;
      const signal = scaffoldAbort?.signal;

      for (const bl of baselines) {
        const cacheKey = `${bl.suite}::${bl.machine}::${bl.order}::${metric}`;
        if (baselineDataCache.has(cacheKey)) continue;

        try {
          const points = await queryDataPoints(bl.suite, {
            machine: bl.machine,
            metric,
            afterOrder: bl.order,
            beforeOrder: bl.order,
          }, signal);
          if (myGen !== suiteGeneration) return;
          baselineDataCache.set(cacheKey, points);
        } catch {
          // Baseline data is optional — silently ignore errors
        }
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
        await Promise.all(plotMachines.map(m => fetchScaffold(currentSuite, m)));

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
                startLazyLoad(currentSuite, m, plotMetric);
              }
            } else if (!entry.loading) {
              startLazyLoad(currentSuite, m, plotMetric);
            }
          }
        }

        // Fetch baseline data for the current metric (may differ from what's
        // cached if the metric changed). This runs in parallel with lazy
        // loading and re-renders when complete.
        if (baselines.length > 0) {
          fetchAllBaselineData().then(() => {
            if (plotMetric === metric) renderFromAllCaches(false);
          });
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
      abortAllMetrics();
      if (scaffoldAbort) { scaffoldAbort.abort(); scaffoldAbort = null; }

      // Clear ALL module-level state
      machines = [];
      cache = new Map();
      machineScaffolds = new Map();
      baselineDataCache.clear();
      manuallyHidden = new Set();
      autoCapped = true;
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
      blSelectedTag = null;
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
      scaffoldAbort = new AbortController();
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
    currentSuite = '';
    suiteGeneration = 0;
    baselineDataCache.clear();
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
