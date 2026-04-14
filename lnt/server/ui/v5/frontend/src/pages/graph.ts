// pages/graph.ts — Time-series graph page with explicit test selection and on-demand loading.

import type { PageModule, RouteParams } from '../router';
import type { AggFn, QueryDataPoint } from '../types';
import { getFields, getCommits, fetchOneCursorPage, postOneCursorPage, apiUrl } from '../api';
import { el, debounce, getAggFn, TRACE_SEP, machineColor } from '../utils';
import { getTestsuites } from '../router';
import { onCustomEvent, GRAPH_TABLE_HOVER, GRAPH_CHART_HOVER } from '../events';
import { renderMachineCombobox } from '../components/machine-combobox';
import { renderMetricSelector, renderEmptyMetricSelector, filterMetricFields } from '../components/metric-selector';
import { createCommitPicker, fetchMachineCommitSet } from '../combobox';
import {
  type TimeSeriesTrace, type PinnedBaseline, type ChartHandle,
  createTimeSeriesChart,
} from '../components/time-series-chart';
import {
  createTestSelectionTable, type TestSelectionEntry, type TestSelectionTableHandle,
} from '../components/test-selection-table';
import { GraphDataCache } from './graph-data-cache';

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
let selectionAbort: AbortController | null = null;
/** Per-suite commit list cache for baseline commit picker. */
let baselineCommitCache = new Map<string, string[]>();
/** Machine-commit filter set for the baseline commit picker (null = loading or no machine). */
let blMachineCommits: Set<string> | null = null;

/** A cross-suite baseline reference line. */
export interface Baseline {
  suite: string;
  machine: string;
  commit: string;
}

// ---------------------------------------------------------------------------
// Module-scope state — some preserved across unmount/remount
// ---------------------------------------------------------------------------

/** All test names matching the current filter (no cap). Preserved across unmount. */
let allMatchingTests: string[] = [];
/** User's explicit test selection. Preserved across unmount. */
let selectedTests = new Set<string>();
/** Tests with in-flight data fetches. Reset on unmount. */
let loadingTests = new Set<string>();

let machineComboCleanup: (() => void) | null = null;
let blMachineCleanup: (() => void) | null = null;
let blCommitCleanup: (() => void) | null = null;
let chartHandle: ChartHandle | null = null;
let tableHandle: TestSelectionTableHandle | null = null;
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
    // Baselines encoded as "suite::machine::commit".
    const baselineParams = urlParams.getAll('baseline');
    const baselines: Baseline[] = baselineParams.map(v => {
      const parts = v.split('::');
      return { suite: parts[0] || '', machine: parts[1] || '', commit: parts[2] || '' };
    }).filter(b => b.suite && b.machine && b.commit);

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
    renderEmptyMetricSelector(metricGroup);

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
      renderFromSelection();
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
      renderFromSelection();
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
            renderFromSelection();
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

    // Baseline form: Suite, Machine, Commit in a horizontal row
    const blSuiteSelect = el('select', { class: 'suite-select baseline-suite' }) as HTMLSelectElement;
    blSuiteSelect.append(el('option', { value: '' }, '-- Suite --'));
    for (const name of getTestsuites()) {
      blSuiteSelect.append(el('option', { value: name }, name));
    }
    const blMachineContainer = el('div', {});
    const blCommitContainer = el('div', {});
    let blSelectedMachine = '';

    function addCurrentBaseline(): void {
      const suite = blSuiteSelect.value;
      if (!suite || !blSelectedMachine || !blSelectedCommit) return;
      // Avoid duplicates
      if (baselines.find(b => b.suite === suite && b.machine === blSelectedMachine && b.commit === blSelectedCommit)) return;
      baselines.push({ suite, machine: blSelectedMachine, commit: blSelectedCommit });
      renderBaselineChips();
      // Fetch baseline data for SELECTED tests and re-render
      if (metric && selectedTests.size > 0) {
        const bl = baselines[baselines.length - 1];
        cache.getBaselineData(bl.suite, bl.machine, bl.commit, metric, [...selectedTests], fetchAbort?.signal)
          .then(() => renderFromSelection())
          .catch(() => { /* baseline data is optional */ });
      }
      updateUrlState();
      // Reset: keep form open for adding more, but clear selections
      blSelectedMachine = '';
      blSelectedCommit = '';
      blSuiteSelect.value = '';
      blSuiteSelect.dispatchEvent(new Event('change'));
    }

    // Track the selected commit — set by onSelect callback from commit search
    let blSelectedCommit = '';

    blSuiteSelect.addEventListener('change', () => {
      blSelectedMachine = '';
      blSelectedCommit = '';
      if (blMachineCleanup) { blMachineCleanup(); blMachineCleanup = null; }
      if (blCommitCleanup) { blCommitCleanup(); blCommitCleanup = null; }
      blMachineContainer.replaceChildren();
      blCommitContainer.replaceChildren();

      const suite = blSuiteSelect.value;
      if (!suite) return;

      const handle = renderMachineCombobox(blMachineContainer, {
        testsuite: suite,
        onSelect: async (name) => {
          blSelectedMachine = name;
          blSelectedCommit = '';
          blMachineCommits = null;
          if (blCommitCleanup) { blCommitCleanup(); blCommitCleanup = null; }
          blCommitContainer.replaceChildren();

          // Fetch commit list and machine commits in parallel
          const commitListPromise = (async () => {
            if (baselineCommitCache.has(suite)) return;
            try {
              const commits = await getCommits(suite, fetchAbort?.signal);
              const values: string[] = [];
              for (const o of commits) {
                values.push(o.commit);
              }
              baselineCommitCache.set(suite, values);
            } catch (err: unknown) {
              if (err instanceof DOMException && err.name === 'AbortError') return;
              baselineCommitCache.set(suite, []);
            }
          })();
          const machineOrdersPromise = fetchMachineCommitSet(suite, name)
            .catch(() => null as Set<string> | null);

          await commitListPromise;

          // Create order picker with machine-commit filtering
          const picker = createCommitPicker({
            id: 'baseline-order',
            getCommitData: () => {
              const values = baselineCommitCache.get(suite);
              return { values: values ?? [] };
            },
            placeholder: 'Type to search commits...',
            onSelect: (value) => {
              blSelectedCommit = value;
              addCurrentBaseline();
            },
            getMachineCommits: () => blSelectedMachine ? (blMachineCommits ?? 'loading') : null,
          });
          blCommitContainer.append(picker.element);
          blCommitCleanup = picker.destroy;

          // Apply machine orders once ready (may already be resolved)
          const machineOrders = await machineOrdersPromise;
          blMachineCommits = machineOrders;
        },
        onClear: () => {
          blSelectedMachine = '';
          blSelectedCommit = '';
          blMachineCommits = null;
          if (blCommitCleanup) { blCommitCleanup(); blCommitCleanup = null; }
          blCommitContainer.replaceChildren();
        },
      });
      blMachineCleanup = handle.destroy;
    });

    addBaselineBtn.addEventListener('click', () => {
      baselineFormContainer.style.display = '';
      addBaselineBtn.style.display = 'none';
    });

    // Horizontal row for Suite → Machine → Commit
    const formRow = el('div', { class: 'baseline-form-row' });
    formRow.append(blSuiteSelect, blMachineContainer, blCommitContainer);
    baselineFormContainer.append(formRow);
    baselineGroup.append(addBaselineBtn, baselineFormContainer, baselineChips);
    firstRow.append(baselineGroup);

    renderBaselineChips();

    function renderBaselineChips(): void {
      baselineChips.replaceChildren();
      for (const bl of baselines) {
        const label = `${bl.suite}/${bl.machine}/${bl.commit}`;
        const chip = el('span', { class: 'chip' }, label);
        const removeBtn = el('button', { class: 'chip-remove' }, '\u00d7');
        removeBtn.addEventListener('click', () => {
          const idx = baselines.indexOf(bl);
          if (idx >= 0) baselines.splice(idx, 1);
          renderBaselineChips();
          renderFromSelection();
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
    const tableContainer = el('div', { class: 'test-selection-container' });
    container.append(tableContainer);

    // ----- Hover sync -----
    cleanupTableHover = onCustomEvent<string | null>(GRAPH_TABLE_HOVER, (testName) => {
      if (!chartHandle) return;
      if (!testName) { chartHandle.hoverTrace(null); return; }
      // Map bare test name to trace name for the first machine
      if (machines.length > 0) {
        chartHandle.hoverTrace(traceName(testName, machines[0]));
      }
    });
    cleanupChartHover = onCustomEvent<string | null>(GRAPH_CHART_HOVER, (tn) => {
      if (!tableHandle) return;
      if (!tn) { tableHandle.highlightRow(null); return; }
      // Extract test name from trace name and highlight the row
      tableHandle.highlightRow(testNameFromTrace(tn));
    });

    // ----- Test discovery (inline filter, no cap) -----

    async function discoverTests(
      suite: string, machineList: string[], metricName: string,
      filter: string, signal?: AbortSignal,
    ): Promise<string[]> {
      const perMachine = await Promise.all(
        machineList.map(m => cache.getTestNames(suite, m, metricName, signal)),
      );
      const union = [...new Set(perMachine.flat())].sort((a, b) => a.localeCompare(b));
      if (!filter) return union;
      const lower = filter.toLowerCase();
      return union.filter(name => name.toLowerCase().includes(lower));
    }

    // ----- Filter change handler -----

    async function handleFilterChange(): Promise<void> {
      filterAbort?.abort();
      filterAbort = new AbortController();
      const sig = filterAbort.signal;

      try {
        allMatchingTests = await discoverTests(
          currentSuite, machines, metric, testFilter, sig);
        if (sig.aborted) return;

        // Prune selections to only tests still matching the filter
        const matchSet = new Set(allMatchingTests);
        for (const t of selectedTests) {
          if (!matchSet.has(t)) selectedTests.delete(t);
        }

        renderFromSelection();
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
      }
    }

    // ----- Selection change handler -----

    async function handleSelectionChange(newSelected: Set<string>): Promise<void> {
      selectionAbort?.abort();
      selectionAbort = new AbortController();
      const sig = selectionAbort.signal;

      selectedTests = newSelected;
      // Clear stale loading entries from any previous aborted call.
      // The new set() is synchronous, so there's no race with the new call.
      loadingTests = new Set();

      // Find tests needing data fetch
      const needFetch: string[] = [];
      for (const testName of selectedTests) {
        for (const m of machines) {
          if (!cache.isComplete(currentSuite, m, metric, testName)) {
            needFetch.push(testName);
            break;
          }
        }
      }

      // Show loading state immediately
      for (const t of needFetch) loadingTests.add(t);
      renderFromSelection();

      if (needFetch.length > 0) {
        try {
          // Batch fetch for all machines
          await Promise.all(machines.map(m =>
            cache.ensureTestData(currentSuite, m, metric, needFetch, {
              signal: sig,
              onProgress: () => scheduleChartUpdate(),
            })
          ));
          if (sig.aborted) return;

          // Fetch baseline data for selected tests
          if (baselines.length > 0) {
            await Promise.all(baselines.map(bl =>
              cache.getBaselineData(bl.suite, bl.machine, bl.commit, metric,
                [...selectedTests], sig),
            ));
          }
        } catch (e: unknown) {
          if (e instanceof DOMException && e.name === 'AbortError') return;
        }
        for (const t of needFetch) loadingTests.delete(t);
        if (!sig.aborted) renderFromSelection();
      }
    }

    // ----- Build chart data from selection -----

    function buildColorMap(): Map<string, string> {
      const colorMap = new Map<string, string>();
      allMatchingTests.forEach((name, i) => colorMap.set(name, machineColor(i)));
      return colorMap;
    }

    function buildChartData(colorMap: Map<string, string>): {
      traces: TimeSeriesTrace[];
      allPoints: QueryDataPoint[];
    } {
      const allTraces: TimeSeriesTrace[] = [];
      const allPoints: QueryDataPoint[] = [];

      const selectedSorted = [...selectedTests].sort((a, b) => a.localeCompare(b));

      for (let mi = 0; mi < machines.length; mi++) {
        const m = machines[mi];
        const symbol = assignSymbol(mi);

        for (const testName of selectedSorted) {
          const points = cache.readCachedTestData(currentSuite, m, metric, testName);
          if (points.length === 0) continue;

          for (const pt of points) allPoints.push(pt);

          const machineTraces = buildTraces(points, runAgg, sampleAgg);
          for (const t of machineTraces) {
            allTraces.push({
              ...t,
              machine: m,
              color: colorMap.get(t.testName),
              markerSymbol: symbol,
            });
          }
        }
      }

      allTraces.sort((a, b) =>
        traceName(a.testName, a.machine).localeCompare(traceName(b.testName, b.machine)));

      return { traces: allTraces, allPoints };
    }

    /** Schedule a deferred chart update from the current selection's cached data. */
    function scheduleChartUpdate(): void {
      if (selectedTests.size === 0 || machines.length === 0 || !metric) return;

      const colorMap = buildColorMap();
      const { traces: activeTraces, allPoints } = buildChartData(colorMap);

      chartRenderGen++;
      const myGen = chartRenderGen;
      if (pendingChartRAF !== null) {
        cancelAnimationFrame(pendingChartRAF);
        pendingChartRAF = null;
      }

      const refs = buildBaselinesFromData(baselines,
        (s, m, o, met) => cache.readCachedBaselineData(s, m, o, met), metric, getAggFn(runAgg));
      const scaffold = cache.scaffoldUnion(currentSuite, machines);

      const rawValuesCallback = (testName: string, machineName: string, commitValue: string): number[] => {
        const values: number[] = [];
        for (const pt of allPoints) {
          if (pt.test === testName && pt.machine === machineName && pt.commit === commitValue) {
            values.push(pt.value);
          }
        }
        return values;
      };

      function doUpdate(): void {
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
        doUpdate();
      } else {
        pendingChartRAF = requestAnimationFrame(doUpdate);
      }
    }

    // ----- Render from selection (full table + chart update) -----

    function renderFromSelection(): void {
      // Build table entries from all matching tests
      const colorMap = buildColorMap();

      const tableEntries: TestSelectionEntry[] = allMatchingTests.map(testName => ({
        testName,
        selected: selectedTests.has(testName),
        color: selectedTests.has(testName) ? colorMap.get(testName) : undefined,
        loading: loadingTests.has(testName),
      }));

      // Message
      const loadingCount = loadingTests.size;
      let msg = `${selectedTests.size} of ${allMatchingTests.length} tests selected`;
      if (loadingCount > 0) msg += `, loading...`;

      // Update or create table
      if (tableHandle) {
        tableHandle.update(tableEntries, msg);
      } else {
        tableHandle = createTestSelectionTable(tableContainer, {
          entries: tableEntries,
          message: msg,
          onSelectionChange: handleSelectionChange,
        });
      }

      // Progress
      progressContainer.replaceChildren();

      // Build and render chart
      if (selectedTests.size === 0 || machines.length === 0 || !metric) {
        // Empty chart with scaffold
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

      scheduleChartUpdate();
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
      if (selectionAbort) { selectionAbort.abort(); selectionAbort = null; }
      fetchAbort = new AbortController();
      const signal = fetchAbort.signal;

      (async () => {
        try {
          // 1. Fetch scaffolds for any machines that don't have one yet.
          await Promise.all(plotMachines.map(m => cache.getScaffold(currentSuite, m, signal)));

          // Render empty chart with scaffold while discovering tests.
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

          // 2. Discover ALL test names (no cap).
          allMatchingTests = await discoverTests(
            currentSuite, plotMachines, plotMetric, plotFilter, signal);
          if (signal.aborted || plotMetric !== metric) return;

          // Prune selections to tests still present after re-discovery.
          const newMatchSet = new Set(allMatchingTests);
          for (const t of selectedTests) {
            if (!newMatchSet.has(t)) selectedTests.delete(t);
          }
          loadingTests = new Set();

          // 3. Render table (preserving selection) and fetch data for
          // selected tests on any new/uncached machines.
          progressContainer.replaceChildren();
          renderFromSelection();

          if (selectedTests.size > 0) {
            handleSelectionChange(new Set(selectedTests));
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
      for (const bl of baselines) qs.append('baseline', `${bl.suite}::${bl.machine}::${bl.commit}`);
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
      if (selectionAbort) { selectionAbort.abort(); selectionAbort = null; }

      // Clear ALL module-level state
      machines = [];
      cache.clear();
      allMatchingTests = [];
      selectedTests = new Set();
      loadingTests = new Set();
      baselineCommitCache.clear();
      blMachineCommits = null;
      baselines.length = 0;
      if (pendingChartRAF !== null) { cancelAnimationFrame(pendingChartRAF); pendingChartRAF = null; }
      chartRenderGen = 0;

      // Destroy UI components
      if (chartHandle) { chartHandle.destroy(); chartHandle = null; }
      if (tableHandle) { tableHandle.destroy(); tableHandle = null; }
      if (machineComboCleanup) { machineComboCleanup(); machineComboCleanup = null; }
      if (blMachineCleanup) { blMachineCleanup(); blMachineCleanup = null; }
      if (blCommitCleanup) { blCommitCleanup(); blCommitCleanup = null; }

      // Clear controls containers
      machineChipsEl.replaceChildren();
      baselineChips.replaceChildren();
      // Reset baseline form
      baselineFormContainer.style.display = 'none';
      addBaselineBtn.style.display = '';
      blSuiteSelect.value = '';
      blMachineContainer.replaceChildren();
      blCommitContainer.replaceChildren();
      blSelectedMachine = '';
      blSelectedCommit = '';
      chartContainer.replaceChildren(el('p', { class: 'no-chart-data' }, 'No data to plot.'));
      tableContainer.replaceChildren();
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

    // Fetch initial fields for the selected suite
    function loadFieldsForSuite(suite: string): void {
      const myGen = suiteGeneration;
      metricGroup.replaceChildren();
      renderEmptyMetricSelector(metricGroup);
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
    if (blCommitCleanup) { blCommitCleanup(); blCommitCleanup = null; }
    abortFetches();
    if (filterAbort) { filterAbort.abort(); filterAbort = null; }
    if (selectionAbort) { selectionAbort.abort(); selectionAbort = null; }
    if (pendingChartRAF !== null) { cancelAnimationFrame(pendingChartRAF); pendingChartRAF = null; }
    if (chartHandle) { chartHandle.destroy(); chartHandle = null; }
    if (tableHandle) { tableHandle.destroy(); tableHandle = null; }
    if (cleanupTableHover) { cleanupTableHover(); cleanupTableHover = null; }
    if (cleanupChartHover) { cleanupChartHover(); cleanupChartHover = null; }
    // Reset transient UI state
    loadingTests = new Set();
    chartRenderGen = 0;
    currentSuite = '';
    suiteGeneration = 0;
    baselineCommitCache.clear();
    blMachineCommits = null;
    // Intentionally preserve selectedTests, allMatchingTests, and cache across
    // unmount/remount so that navigating back renders instantly from cache.
    // machines is restored from URL on mount.
  },
};

/**
 * Group raw query data points into traces, applying aggregation.
 * Exported for testing.
 */
export function buildTraces(
  points: QueryDataPoint[],
  runAgg: AggFn,
  sampleAgg: AggFn,
): TimeSeriesTrace[] {
  // Group by test name
  const testMap = new Map<string, QueryDataPoint[]>();
  for (const pt of points) {
    let arr = testMap.get(pt.test);
    if (!arr) { arr = []; testMap.set(pt.test, arr); }
    arr.push(pt);
  }

  const runAggFn = getAggFn(runAgg);
  const sampleAggFn = getAggFn(sampleAgg);
  const traces: TimeSeriesTrace[] = [];

  for (const [testName, testPoints] of testMap) {
    // Group by commit value
    const commitMap = new Map<string, QueryDataPoint[]>();
    for (const pt of testPoints) {
      const ov = pt.commit;
      let arr = commitMap.get(ov);
      if (!arr) { arr = []; commitMap.set(ov, arr); }
      arr.push(pt);
    }

    const tracePoints: TimeSeriesTrace['points'] = [];
    for (const [commitValue, commitPoints] of commitMap) {
      // Step 1: group by run_uuid
      const byRun = new Map<string, number[]>();
      for (const pt of commitPoints) {
        let arr = byRun.get(pt.run_uuid);
        if (!arr) { arr = []; byRun.set(pt.run_uuid, arr); }
        arr.push(pt.value);
      }
      // Step 2: aggregate samples within each run
      const perRunValues = [...byRun.values()].map(v => sampleAggFn(v));
      // Step 3: aggregate across runs
      tracePoints.push({
        commit: commitValue,
        value: runAggFn(perRunValues),
        runCount: byRun.size,
        submitted_at: commitPoints[0].submitted_at,
      });
    }

    // Machine is set by the caller after buildTraces returns
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
  baselines: Array<{ suite: string; machine: string; commit: string }>,
  getPoints: (suite: string, machine: string, order: string, metric: string) => QueryDataPoint[],
  metric: string,
  aggFn: (values: number[]) => number,
): PinnedBaseline[] {
  return baselines.map((bl) => {
    const points = getPoints(bl.suite, bl.machine, bl.commit, metric);

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

    const label = `${bl.suite}/${bl.machine}/${bl.commit}`;

    return {
      label,
      values,
    };
  });
}
