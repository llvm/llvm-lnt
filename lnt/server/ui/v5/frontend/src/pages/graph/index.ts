// pages/graph/index.ts — Graph page orchestrator.
// Wires state, cache, controls, baselines, chart, and table together.

import type { PageModule, RouteParams } from '../../router';
import type { AggFn } from '../../types';
import { fetchOneCursorPage, postOneCursorPage, apiUrl, getTestSuiteInfoCached } from '../../api';
import { el, getAggFn, TRACE_SEP, resolveDisplayMap, matchesFilter } from '../../utils';
import { getTestsuites } from '../../router';
import { onCustomEvent, GRAPH_TABLE_HOVER, GRAPH_CHART_HOVER, GRAPH_CHART_DBLCLICK } from '../../events';

import { decodeGraphState, replaceGraphUrl, type BaselineRef, type RegressionAnnotationMode } from './state';
import { GraphDataCache } from './data-cache';
import {
  buildChartData, buildBaselinesFromData, buildRegressionOverlays,
  buildRawValuesCallback, buildColorMap, assignSymbolChar,
} from './traces';
import { createControls, type ControlsHandle } from './controls';
import { createBaselinePanel, type BaselinePanelHandle } from './baselines';
import { createTimeSeriesChart, type ChartHandle } from './time-series-chart';
import {
  createTestSelectionTable, type TestSelectionTableHandle, type TestSelectionEntry,
} from './test-selection-table';

// ---------------------------------------------------------------------------
// Module-level state — survives unmount/remount for instant back-nav
// ---------------------------------------------------------------------------

let cache = new GraphDataCache({ apiUrl, fetchOneCursorPage, postOneCursorPage });
/** Full unfiltered test list across all machines (for stable color assignment). */
let allDiscoveredTests: string[] = [];
/** Filtered test list (for table display). */
let allMatchingTests: string[] = [];
/** User's explicit test selection. */
let selectedTests = new Set<string>();
/** Current suite for cache scope. */
let currentSuite = '';
/** Selected machines. */
let machines: string[] = [];
/** Current metric. */
let metric = '';
/** Resolved display values for baseline commits (survives unmount/remount). */
let baselineResolvedMap = new Map<string, string>();

// ---------------------------------------------------------------------------
// Helper: extract test name from trace name
// ---------------------------------------------------------------------------

function testNameFromTrace(tn: string): string {
  const idx = tn.lastIndexOf(TRACE_SEP);
  return idx >= 0 ? tn.slice(0, idx) : tn;
}

// Module-level cleanup function — set by mount(), called by unmount()
let cleanupFn: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Page module
// ---------------------------------------------------------------------------

export const graphPage: PageModule = {
  mount(container: HTMLElement, _params: RouteParams): void {
    // ---- Parse URL state ----
    const state = decodeGraphState(window.location.search);
    currentSuite = state.suite;
    machines = state.machines;
    metric = state.metric;
    let testFilter = state.testFilter;
    let runAgg = state.runAgg;
    let sampleAgg = state.sampleAgg;
    const baselines: BaselineRef[] = [...state.baselines];
    let regressionMode: RegressionAnnotationMode = state.regressionMode;

    // ---- Transient state (per-mount) ----
    let loadingTests = new Set<string>();
    let chartHandle: ChartHandle | null = null;
    let tableHandle: TestSelectionTableHandle | null = null;
    let controlsHandle: ControlsHandle | null = null;
    let baselinePanelHandle: BaselinePanelHandle | null = null;
    let pendingChartRAF: number | null = null;
    let chartRenderGen = 0;
    let suiteGeneration = 0;
    let plotGeneration = 0;
    let selectionAbort: AbortController | null = null;
    const machineAborts = new Map<string, AbortController>();
    let globalAbort = new AbortController();
    let commitFields: Array<{ name: string; display?: boolean }> = [];
    let currentDisplayMap = new Map<string, string>();
    /** Cached scaffold union — only recomputed when machines or scaffolds change. */
    let cachedCategoryOrder: string[] | undefined;
    /** Cached color map — only recomputed when allDiscoveredTests changes. */
    let cachedColorMap = new Map<string, string>();
    let cleanupTableHover: (() => void) | null = null;
    let cleanupChartHover: (() => void) | null = null;
    let cleanupChartDblClick: (() => void) | null = null;

    function getSignal(): AbortSignal { return globalAbort.signal; }

    function getMachineSignal(machine: string): AbortSignal {
      let ctrl = machineAborts.get(machine);
      if (!ctrl || ctrl.signal.aborted) {
        ctrl = new AbortController();
        machineAborts.set(machine, ctrl);
      }
      return ctrl.signal;
    }

    function abortMachine(machine: string): void {
      const ctrl = machineAborts.get(machine);
      if (ctrl) { ctrl.abort(); machineAborts.delete(machine); }
    }

    function abortInFlight(): void {
      for (const [, ctrl] of machineAborts) ctrl.abort();
      machineAborts.clear();
      if (selectionAbort) { selectionAbort.abort(); selectionAbort = null; }
    }

    function abortAll(): void {
      globalAbort.abort();
      globalAbort = new AbortController();
      abortInFlight();
    }

    // ---- URL state management ----
    function updateUrlState(): void {
      replaceGraphUrl({
        suite: currentSuite,
        machines,
        metric,
        testFilter,
        runAgg,
        sampleAgg,
        baselines,
        regressionMode,
      });
    }

    // ---- Baseline display resolution ----

    function combinedDisplayMap(): Map<string, string> {
      if (baselineResolvedMap.size === 0) return currentDisplayMap;
      const merged = new Map(currentDisplayMap);
      for (const [k, v] of baselineResolvedMap) merged.set(k, v);
      return merged;
    }

    async function resolveBaselineDisplayValues(): Promise<void> {
      if (baselines.length === 0) return;
      const gen = suiteGeneration;
      const known = combinedDisplayMap();
      const bySuite = new Map<string, string[]>();
      for (const bl of baselines) {
        if (known.has(bl.commit)) continue;
        const list = bySuite.get(bl.suite) ?? [];
        list.push(bl.commit);
        bySuite.set(bl.suite, list);
      }
      if (bySuite.size === 0) {
        baselinePanelHandle?.updateChips(baselines, known);
        return;
      }
      const results = await Promise.all(
        [...bySuite.entries()].map(([suite, commits]) =>
          resolveDisplayMap(suite, commits, getSignal())
        ),
      );
      if (gen !== suiteGeneration) return;
      for (const dm of results) {
        for (const [k, v] of dm) baselineResolvedMap.set(k, v);
      }
      baselinePanelHandle?.updateChips(baselines, combinedDisplayMap());
    }

    // ---- DOM skeleton ----
    container.append(el('h2', { class: 'page-header' }, 'Graph'));
    const errorBanner = el('div', { class: 'error-banner', style: 'display: none' });
    const progressEl = el('p', { class: 'progress-label', style: 'display: none' },
      'Discovering tests...');
    const chartContainer = el('div', {},
      el('p', { class: 'no-chart-data' }, 'No data to plot.'),
    );
    const tableContainer = el('div', { class: 'test-table-container' });

    // ---- Controls ----
    const suites = getTestsuites();
    controlsHandle = createControls(state, suites, {
      onSuiteChange: handleSuiteChange,
      onMachineAdd: handleMachineAdd,
      onMachineRemove: handleMachineRemove,
      onMetricChange: handleMetricChange,
      onFilterChange: handleFilterChange,
      onRunAggChange(agg: AggFn) {
        runAgg = agg;
        renderFromSelection();
        updateUrlState();
      },
      onSampleAggChange(agg: AggFn) {
        sampleAgg = agg;
        renderFromSelection();
        updateUrlState();
      },
      onRegressionModeChange(mode: RegressionAnnotationMode) {
        regressionMode = mode;
        handleRegressionModeChange();
        updateUrlState();
      },
    });
    container.append(controlsHandle.getElement());

    // ---- Baseline panel (embedded in controls row 1) ----
    baselinePanelHandle = createBaselinePanel(baselines, combinedDisplayMap(), suites, {
      onBaselineAdd: handleBaselineAdd,
      onBaselineRemove: handleBaselineRemove,
      getCommitFields: (suite: string) => {
        return suite === currentSuite ? commitFields : [];
      },
      getBaselineCommits: (suite, machine, signal) =>
        cache.getBaselineCommits(suite, machine, signal),
    });
    controlsHandle.embedInRow1(baselinePanelHandle.getElement());

    if (baselines.length > 0) {
      resolveBaselineDisplayValues().catch(() => {});
    }

    container.append(errorBanner, progressEl, chartContainer, tableContainer);

    // ---- Hover sync ----
    cleanupTableHover = onCustomEvent<string | null>(GRAPH_TABLE_HOVER, (testName) => {
      if (!chartHandle) return;
      if (!testName) {
        chartHandle.hoverTrace(null);
        return;
      }
      // Highlight all machines' traces for this test
      const traceNames = machines.map(m => `${testName}${TRACE_SEP}${m}`);
      chartHandle.hoverTrace(traceNames);
    });

    cleanupChartHover = onCustomEvent<string | null>(GRAPH_CHART_HOVER, (traceName) => {
      if (!tableHandle) return;
      const testName = traceName ? testNameFromTrace(traceName) : null;
      tableHandle.highlightRow(testName);
    });

    cleanupChartDblClick = onCustomEvent<string>(GRAPH_CHART_DBLCLICK, (testName) => {
      if (!testName) return;
      handleSelectionChange(new Set([testName]));
    });

    // ---- Data pipeline functions ----

    /** Full reconfigure: fetch scaffolds, discover tests, populate table. */
    async function doPlot(): Promise<void> {
      if (!currentSuite || machines.length === 0 || !metric) return;

      plotGeneration++;
      abortInFlight();
      progressEl.style.display = 'none';

      const gen = plotGeneration;

      try {
        // 1. Fetch scaffolds for all machines in parallel
        await Promise.all(machines.map(m =>
          cache.getScaffold(currentSuite, m, getMachineSignal(m)),
        ));
        if (gen !== plotGeneration) return;

        progressEl.style.display = '';

        // 2. Discover tests for ALL machines in parallel, then union
        const perMachine = await Promise.all(machines.map(m =>
          cache.discoverTests(currentSuite, m, metric, getMachineSignal(m)),
        ));
        if (gen !== plotGeneration) return;
        progressEl.style.display = 'none';

        // Union all test lists, sorted alphabetically
        const testSet = new Set<string>();
        for (const list of perMachine) {
          for (const name of list) testSet.add(name);
        }
        allDiscoveredTests = [...testSet].sort((a, b) => a.localeCompare(b));

        // Cache color map (stable: only changes when allDiscoveredTests changes)
        cachedColorMap = buildColorMap(allDiscoveredTests);

        // Cache scaffold union (only changes when machines or scaffolds change)
        const union = cache.scaffoldUnion(currentSuite, machines, commitFields);
        if (union) {
          currentDisplayMap = union.displayMap;
          cachedCategoryOrder = union.commits;
        } else {
          cachedCategoryOrder = undefined;
        }

        // Refresh baseline chips with scaffold-derived display values
        if (baselines.length > 0) {
          baselinePanelHandle?.updateChips(baselines, combinedDisplayMap());
        }

        // Apply filter
        applyFilter();

        // Restore previous selections that are still valid
        const validSelected = new Set<string>();
        for (const t of selectedTests) {
          if (testSet.has(t)) validSelected.add(t);
        }
        selectedTests = validSelected;

        // Render table and chart
        renderFromSelection();

        // Fetch data for selected tests
        if (selectedTests.size > 0) {
          await handleSelectionChange(selectedTests);
        }
      } catch (e) {
        progressEl.style.display = 'none';
        if (e instanceof DOMException && e.name === 'AbortError') return;
        showError(`Failed to load data: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    function applyFilter(): void {
      if (testFilter) {
        allMatchingTests = allDiscoveredTests.filter(t => matchesFilter(t, testFilter));
      } else {
        allMatchingTests = [...allDiscoveredTests];
      }
    }

    function handleFilterChange(filter: string): void {
      testFilter = filter;
      updateUrlState();
      if (machines.length === 0 || !metric) return;

      applyFilter();

      // Prune selection to matching tests
      const matchingSet = new Set(allMatchingTests);
      const newSelected = new Set<string>();
      for (const t of selectedTests) {
        if (matchingSet.has(t)) newSelected.add(t);
      }
      selectedTests = newSelected;

      renderFromSelection();
    }

    async function handleSelectionChange(newSelected: Set<string>): Promise<void> {
      if (selectionAbort) selectionAbort.abort();
      selectionAbort = new AbortController();
      const selSignal = selectionAbort.signal;
      loadingTests = new Set();

      selectedTests = newSelected;
      const gen = plotGeneration;

      // Identify uncached tests (check all machines, not just the first)
      const uncached: string[] = [];
      for (const t of selectedTests) {
        if (machines.some(m => !cache.isComplete(currentSuite, m, metric, t))) {
          uncached.push(t);
        }
      }

      // Always rebuild the table so checkboxes reflect the new selection,
      // even when every selected test is already cached.
      renderFromSelection();

      if (uncached.length > 0) {
        for (const t of uncached) loadingTests.add(t);
        renderFromSelection();

        try {
          // Fetch data for each machine in parallel
          await Promise.all(machines.map(m =>
            cache.ensureTestData(currentSuite, m, metric, uncached, {
              signal: selSignal,
              onProgress: () => scheduleChartUpdate(),
            }),
          ));
          if (gen !== plotGeneration || selSignal.aborted) return;

          for (const t of uncached) loadingTests.delete(t);

          // Fetch baseline data for newly-selected tests (in parallel)
          await Promise.all(baselines.map(bl =>
            cache.getBaselineData(bl.suite, bl.machine, bl.commit, metric, uncached, selSignal),
          ));
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          loadingTests = new Set();
        }

        if (gen !== plotGeneration || selSignal.aborted) return;
        renderFromSelection();
      }

      scheduleChartUpdate();
    }

    /** RAF-batched chart render. Does NOT rebuild the table. */
    function scheduleChartUpdate(): void {
      chartRenderGen++;
      const gen = chartRenderGen;
      if (pendingChartRAF !== null) cancelAnimationFrame(pendingChartRAF);

      pendingChartRAF = requestAnimationFrame(() => {
        pendingChartRAF = null;
        if (gen !== chartRenderGen) return; // stale
        if (!currentSuite || !metric) return;

        // Build traces from cache
        const { traces, rawValuesIndex } = buildChartData({
          selectedTests,
          machines,
          metric,
          runAgg,
          sampleAgg,
          readCachedTestData: (s, m, met, t) => cache.readCachedTestData(s, m, met, t),
          suite: currentSuite,
          colorMap: cachedColorMap,
        });

        // Build baselines
        const pinnedBaselines = buildBaselinesFromData(
          baselines,
          (s, m, c, met) => cache.readCachedBaselineData(s, m, c, met),
          metric,
          getAggFn(runAgg),
          combinedDisplayMap(),        );

        // Build regression overlays
        let overlays = undefined;
        if (regressionMode !== 'off') {
          const regs = cache.readCachedRegressions(currentSuite, regressionMode === 'active' ? 'active' : 'all');
          if (regs) {
            overlays = buildRegressionOverlays(regs, currentDisplayMap);
          }
        }

        // Use cached scaffold (computed in doPlot, doesn't change during loading)
        const chartOpts = {
          traces,
          yAxisLabel: metric,
          baselines: pinnedBaselines.length > 0 ? pinnedBaselines : undefined,
          categoryOrder: cachedCategoryOrder,
          displayMap: currentDisplayMap.size > 0 ? currentDisplayMap : undefined,
          getRawValues: buildRawValuesCallback(rawValuesIndex),
          overlays,
        };

        if (chartHandle) {
          chartHandle.update(chartOpts);
        } else {
          chartHandle = createTimeSeriesChart(chartContainer, chartOpts);
        }
      });
    }

    /** Rebuild table + schedule chart update. */
    function renderFromSelection(): void {
      const entries: TestSelectionEntry[] = allMatchingTests.map(testName => ({
        testName,
        selected: selectedTests.has(testName),
        color: cachedColorMap.get(testName),
        symbolChar: selectedTests.has(testName) ? assignSymbolChar(0) : undefined,
        loading: loadingTests.has(testName),
      }));

      const selCount = selectedTests.size;
      const totalCount = allMatchingTests.length;
      const loadingCount = loadingTests.size;
      let message = `${selCount} of ${totalCount} tests selected`;
      if (loadingCount > 0) message += ', loading...';

      if (tableHandle) {
        tableHandle.update(entries, message);
      } else {
        tableHandle = createTestSelectionTable(tableContainer, {
          entries,
          onSelectionChange(selected: Set<string>) {
            handleSelectionChange(selected);
          },
          message,
        });
      }

      scheduleChartUpdate();
    }

    // ---- Event handlers ----

    function handleSuiteChange(suite: string): void {
      suiteGeneration++;
      abortAll();
      cache.clearSuite();

      currentSuite = suite;
      machines = [];
      metric = '';
      testFilter = '';
      allDiscoveredTests = [];
      allMatchingTests = [];
      selectedTests = new Set();
      loadingTests = new Set();
      commitFields = [];
      currentDisplayMap = new Map();
      baselineResolvedMap = new Map();
      regressionMode = 'off';

      if (chartHandle) { chartHandle.destroy(); chartHandle = null; }
      if (tableHandle) { tableHandle.destroy(); tableHandle = null; }
      chartContainer.replaceChildren(el('p', { class: 'no-chart-data' }, 'No data to plot.'));
      tableContainer.replaceChildren();
      progressEl.style.display = 'none';

      controlsHandle?.setSuite(suite);
      controlsHandle?.updateMachineChips([]);
      controlsHandle?.setEnabled(!!suite);
      controlsHandle?.setRegressionMode('off');
      baselinePanelHandle?.reset();

      if (suite) {
        loadSuiteFields(suite);
      }

      updateUrlState();
    }

    function handleMachineAdd(name: string): void {
      if (machines.includes(name)) return;
      machines.push(name);
      controlsHandle?.updateMachineChips(machines);
      updateUrlState();
      if (metric) doPlot();
    }

    function handleMachineRemove(name: string): void {
      abortMachine(name);
      machines = machines.filter(m => m !== name);
      controlsHandle?.updateMachineChips(machines);
      updateUrlState();
      if (machines.length > 0 && metric) {
        doPlot();
      } else {
        progressEl.style.display = 'none';
        renderFromSelection();
      }
    }

    function handleMetricChange(newMetric: string): void {
      metric = newMetric;
      updateUrlState();
      // Clear test data when metric changes (different metric, different data)
      allDiscoveredTests = [];
      allMatchingTests = [];
      selectedTests = new Set();
      loadingTests = new Set();
      if (tableHandle) { tableHandle.destroy(); tableHandle = null; }
      tableContainer.replaceChildren();
      progressEl.style.display = 'none';
      if (machines.length > 0 && metric) doPlot();
    }

    function handleBaselineAdd(bl: BaselineRef): void {
      if (baselines.some(b => b.suite === bl.suite && b.machine === bl.machine && b.commit === bl.commit)) return;
      baselines.push(bl);
      baselinePanelHandle?.updateChips(baselines, combinedDisplayMap());
      updateUrlState();

      resolveBaselineDisplayValues().catch(() => {});

      // Fetch baseline data for current selection
      if (metric && selectedTests.size > 0) {
        cache.getBaselineData(bl.suite, bl.machine, bl.commit, metric, [...selectedTests], getSignal())
          .then(() => scheduleChartUpdate())
          .catch(e => {
            if (e instanceof DOMException && e.name === 'AbortError') return;
          });
      }
    }

    function handleBaselineRemove(bl: BaselineRef): void {
      const idx = baselines.findIndex(b => b.suite === bl.suite && b.machine === bl.machine && b.commit === bl.commit);
      if (idx >= 0) baselines.splice(idx, 1);
      baselinePanelHandle?.updateChips(baselines, combinedDisplayMap());
      updateUrlState();
      scheduleChartUpdate();
    }

    async function handleRegressionModeChange(): Promise<void> {
      if (regressionMode === 'off') {
        scheduleChartUpdate();
        return;
      }
      if (!currentSuite) return;
      const gen = suiteGeneration;
      try {
        const mode = regressionMode === 'active' ? 'active' as const : 'all' as const;
        await cache.getRegressions(currentSuite, mode, getSignal());
        if (gen !== suiteGeneration) return;
        scheduleChartUpdate();
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        // Silently ignore regression fetch failures
      }
    }

    async function loadSuiteFields(suite: string): Promise<void> {
      const gen = suiteGeneration;
      try {
        const info = await getTestSuiteInfoCached(suite, getSignal());
        if (gen !== suiteGeneration) return;
        commitFields = info.schema.commit_fields || [];
        controlsHandle?.updateMetricSelector(info.schema.metrics, metric);
        controlsHandle?.setEnabled(true);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        showError('Failed to load suite fields');
      }
    }

    function showError(msg: string): void {
      errorBanner.textContent = msg;
      errorBanner.style.display = '';
      setTimeout(() => { errorBanner.style.display = 'none'; }, 5000);
    }

    // ---- Initial load ----
    if (currentSuite) {
      loadSuiteFields(currentSuite).then(() => {
        if (machines.length > 0 && metric) doPlot();
      });
    }

    // ---- Store cleanup for unmount ----
    cleanupFn = () => {
      abortAll();
      if (chartHandle) { chartHandle.destroy(); chartHandle = null; }
      if (tableHandle) { tableHandle.destroy(); tableHandle = null; }
      if (controlsHandle) { controlsHandle.destroy(); controlsHandle = null; }
      if (baselinePanelHandle) { baselinePanelHandle.destroy(); baselinePanelHandle = null; }
      if (cleanupTableHover) { cleanupTableHover(); cleanupTableHover = null; }
      if (cleanupChartHover) { cleanupChartHover(); cleanupChartHover = null; }
      if (cleanupChartDblClick) { cleanupChartDblClick(); cleanupChartDblClick = null; }
      if (pendingChartRAF !== null) { cancelAnimationFrame(pendingChartRAF); pendingChartRAF = null; }
      loadingTests = new Set();
      // Preserve: cache, allDiscoveredTests, allMatchingTests, selectedTests, machines, metric, currentSuite
    };
  },

  unmount(): void {
    if (cleanupFn) { cleanupFn(); cleanupFn = null; }
  },
};
