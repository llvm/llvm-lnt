// pages/graph.ts — Time-series graph page with lazy loading and client-side caching.

import type { PageModule, RouteParams } from '../router';
import type { AggFn, QueryDataPoint } from '../types';
import { getFields, getOrders, fetchOneCursorPage, postOneCursorPage, apiUrl } from '../api';
import { el, debounce, getAggFn, primaryOrderValue, TRACE_SEP, PLOTLY_COLORS, machineColor } from '../utils';
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
import { GraphDataCache, filterTestNames } from './graph-data-cache';

const MAX_DISPLAYED_TESTS = 50;
const MACHINE_SYMBOLS = [
  'circle', 'triangle-up', 'square', 'diamond', 'x',
  'cross', 'star', 'pentagon', 'hexagon', 'hexagram',
];
/** Unicode characters matching MACHINE_SYMBOLS for display in chips and legend. */
const SYMBOL_CHARS = ['●', '▲', '■', '◆', '✕', '+', '★', '⬠', '⬡', '✡'];

// ---------------------------------------------------------------------------
// Module-level cache — survives unmount/remount for instant back-nav
// ---------------------------------------------------------------------------

let cache = new GraphDataCache({ apiUrl, fetchOneCursorPage, postOneCursorPage });
let fetchAbort: AbortController | null = null;
let filterAbort: AbortController | null = null;
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

function abortFetches(): void {
  if (fetchAbort) { fetchAbort.abort(); fetchAbort = null; }
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

    // ----- Controls Row 1: Suite, Machines, Baselines (data sources) -----
    const firstRow = el('div', { class: 'graph-controls graph-controls-top side' });
    firstRow.append(suiteGroup);
    controlsPanel.append(firstRow);

    // Metric selector (loaded async — actual fetch deferred until suite is set)
    const metricGroup = el('div', {});
    metricGroup.append(el('span', { class: 'progress-label' }, 'Select a suite to load metrics...'));

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
      if (machines.length > 0 && metric) handleFilterChange();
    }, 200) as EventListener);
    filterGroup.append(filterInput);

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

    // Machine chip input (in row 1)
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
          renderMachineChips();
          if (machines.length > 0 && metric) {
            doPlot();
          } else {
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
    firstRow.append(machineGroup);

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
      // Fetch baseline data and re-render
      if (metric && discoveredTests.length > 0) {
        const bl = baselines[baselines.length - 1];
        cache.getBaselineData(bl.suite, bl.machine, bl.order, metric, discoveredTests, fetchAbort?.signal)
          .then(() => renderFromDiscoveredTests())
          .catch(() => { /* baseline data is optional */ });
      }
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
    firstRow.append(baselineGroup);

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
          renderBaselineChips();
          renderFromDiscoveredTests();
          updateUrlState();
        });
        chip.append(removeBtn);
        baselineChips.append(chip);
      }
    }

    // ----- Controls Row 2: Metric, Aggregation, Test Filter (viewing) -----
    const secondRow = el('div', { class: 'graph-controls' });
    secondRow.append(metricGroup, runAggGroup, sampleAggGroup, filterGroup);
    controlsPanel.append(secondRow);

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

    // ----- Filter change handler -----

    async function discoverAndFilter(
      suite: string, machineList: string[], metricName: string,
      filter: string, signal?: AbortSignal,
    ): Promise<{ names: string[]; truncated: boolean }> {
      const perMachine = await Promise.all(
        machineList.map(m => cache.getTestNames(suite, m, metricName, signal)),
      );
      const union = [...new Set(perMachine.flat())].sort((a, b) => a.localeCompare(b));
      return filterTestNames(union, filter, MAX_DISPLAYED_TESTS);
    }

    async function handleFilterChange(): Promise<void> {
      filterAbort?.abort();
      filterAbort = new AbortController();
      const sig = filterAbort.signal;

      try {
        const { names, truncated } = await discoverAndFilter(
          currentSuite, machines, metric, testFilter, sig);
        if (sig.aborted) return;
        discoveredTests = names;
        discoveredTruncated = truncated;

        // Render immediately from cache
        renderFromDiscoveredTests();

        // Fetch data for newly visible tests (no-op if already cached)
        await Promise.all(machines.map(m =>
          cache.ensureTestData(currentSuite, m, metric, names, { signal: sig })
        ));
        if (sig.aborted) return;

        // Fetch baselines for new tests (re-fetches if test list expanded)
        await Promise.all(baselines.map(bl =>
          cache.getBaselineData(bl.suite, bl.machine, bl.order, metric, names, sig),
        ));
        if (sig.aborted) return;

        renderFromDiscoveredTests();
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
      }
    }

    // ----- Render from discovered tests -----

    function renderFromDiscoveredTests(): void {
      if (discoveredTests.length === 0 || machines.length === 0 || !metric) {
        // No data yet — show empty chart with scaffold if available, clear legend
        progressContainer.replaceChildren();
        if (legendHandle) { legendHandle.update([], undefined); }
        const scaffold = cache.scaffoldUnion(currentSuite, machines);
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

      // Collect data from cache for each machine.
      let anyHasData = false;
      let allComplete = true;
      let totalPoints = 0;

      // Build traces per machine.
      const allTraces: TimeSeriesTrace[] = [];
      const allTraceNames: string[] = [];

      // Assign colors by test name (same test on different machines = same color).
      const colorMap = new Map<string, string>();
      discoveredTests.forEach((name, i) => colorMap.set(name, machineColor(i)));

      // Collect all points for raw values callback.
      const allPoints: QueryDataPoint[] = [];

      for (let mi = 0; mi < machines.length; mi++) {
        const m = machines[mi];
        const symbol = assignSymbol(mi);

        for (const testName of discoveredTests) {
          const points = cache.readCachedTestData(currentSuite, m, metric, testName);
          if (points.length === 0) {
            if (!cache.isComplete(currentSuite, m, metric, testName)) allComplete = false;
            continue;
          }

          anyHasData = true;
          totalPoints += points.length;
          if (!cache.isComplete(currentSuite, m, metric, testName)) allComplete = false;
          for (const pt of points) allPoints.push(pt);

          const machineTraces = buildTraces(points, runAgg, sampleAgg);
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
        const scaffold = cache.scaffoldUnion(currentSuite, machines);
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
      chartRenderGen++;
      const myGen = chartRenderGen;
      if (pendingChartRAF !== null) {
        cancelAnimationFrame(pendingChartRAF);
        pendingChartRAF = null;
      }

      const refs = buildBaselinesFromData(baselines,
        (s, m, o, met) => cache.readCachedBaselineData(s, m, o, met), metric, getAggFn(runAgg));
      const scaffold = cache.scaffoldUnion(currentSuite, machines);

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

      if (activeTraces.length === 0) {
        renderAllTraces();
      } else {
        pendingChartRAF = requestAnimationFrame(renderAllTraces);
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

      // Abort any in-flight fetches from a previous doPlot or filter call.
      abortFetches();
      if (filterAbort) { filterAbort.abort(); filterAbort = null; }
      fetchAbort = new AbortController();
      const signal = fetchAbort.signal;

      (async () => {
        try {
          // 1. Fetch scaffolds for any machines that don't have one yet.
          await Promise.all(plotMachines.map(m => cache.getScaffold(currentSuite, m, signal)));

          // Render empty chart with scaffold while loading.
          const scaffold = cache.scaffoldUnion(currentSuite, plotMachines);
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

          // 2. Discover test names (fetch ALL, filter locally).
          const { names, truncated } = await discoverAndFilter(
            currentSuite, plotMachines, plotMetric, plotFilter, signal);
          if (signal.aborted || plotMetric !== metric) return;
          discoveredTests = names;
          discoveredTruncated = truncated;
          manuallyHidden = new Set();

          // Render immediately from cache (tests that are already cached show instantly).
          renderFromDiscoveredTests();

          // 3. Fetch uncached test data for each machine.
          await Promise.all(plotMachines.map(m =>
            cache.ensureTestData(currentSuite, m, plotMetric, names, {
              signal, onProgress: () => renderFromDiscoveredTests(),
            })));
          if (signal.aborted || plotMetric !== metric) return;

          // Final render with all data complete.
          renderFromDiscoveredTests();

          // 4. Fetch baseline data.
          if (baselines.length > 0) {
            await Promise.all(baselines.map(bl =>
              cache.getBaselineData(bl.suite, bl.machine, bl.order, plotMetric, names, signal),
            ));
            if (!signal.aborted && plotMetric === metric) {
              renderFromDiscoveredTests();
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
      if (filterAbort) { filterAbort.abort(); filterAbort = null; }

      // Clear ALL module-level state
      machines = [];
      cache.clear();
      discoveredTests = [];
      discoveredTruncated = false;
      baselineOrderCache.clear();
      blMachineOrders = null;
      manuallyHidden = new Set();
      currentVisibleTraceNames = [];
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
    if (filterAbort) { filterAbort.abort(); filterAbort = null; }
    if (pendingChartRAF !== null) { cancelAnimationFrame(pendingChartRAF); pendingChartRAF = null; }
    if (chartHandle) { chartHandle.destroy(); chartHandle = null; }
    if (legendHandle) { legendHandle.destroy(); legendHandle = null; }
    if (cleanupTableHover) { cleanupTableHover(); cleanupTableHover = null; }
    if (cleanupChartHover) { cleanupChartHover(); cleanupChartHover = null; }
    manuallyHidden = new Set();
    currentVisibleTraceNames = [];
    chartRenderGen = 0;
    currentSuite = '';
    suiteGeneration = 0;
    discoveredTests = [];
    discoveredTruncated = false;
    baselineOrderCache.clear();
    blMachineOrders = null;
    // Intentionally preserve cache across unmount/remount so that
    // navigating back renders instantly from cache. The machines list
    // is restored from URL on mount.
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
  getPoints: (suite: string, machine: string, order: string, metric: string) => QueryDataPoint[],
  metric: string,
  aggFn: (values: number[]) => number,
): PinnedBaseline[] {
  return baselines.map((bl, i) => {
    const points = getPoints(bl.suite, bl.machine, bl.order, metric);

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
    };
  });
}
