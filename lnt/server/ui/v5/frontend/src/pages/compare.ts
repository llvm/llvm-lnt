// pages/compare.ts — Compare page module for the SPA.
//
// Absorbs the existing comparison code (comparison.ts, selection.ts, table.ts,
// chart.ts) into the SPA as a page module. The mount() function replaces what
// the old standalone main.ts init() did.
//
// Per-run sample caching: fetched samples are cached by run UUID. Changing the
// metric, aggregation, or noise re-aggregates from cache without API calls.
// Only new run UUIDs (from order/machine changes) trigger fetches.
//
// Cross-suite support: each side can independently select a test suite.
// Samples are fetched from the side's suite. The comparison joins on test name.

import type { PageModule, RouteParams } from '../router';
import type { ComparisonRow, SampleInfo } from '../types';
import { getTestsuites } from '../router';
import { getSamples } from '../api';
import {
  CHART_ZOOM, CHART_HOVER, TABLE_HOVER,
  TEST_FILTER_CHANGE, SETTINGS_CHANGE,
  onCustomEvent,
} from '../events';
import { getState, applyUrlState } from '../state';
import {
  initSelection, fetchSideData, getMetricFields, renderSelectionPanel,
} from '../selection';
import {
  aggregateSamplesWithinRun, aggregateAcrossRuns, computeComparison,
} from '../comparison';
import { renderTable, filterToTests, highlightRow, resetTable } from '../table';
import { renderChart, highlightPoint, destroyChart } from '../chart';
import { el } from '../utils';

/** Cleanup functions for document-level event listeners. */
let eventCleanups: Array<() => void> = [];
/** AbortController for in-flight sample fetches. */
let fetchController: AbortController | null = null;
/** Per-run sample cache: run UUID → samples. */
let sampleCache = new Map<string, SampleInfo[]>();
/** Tests manually hidden by the user (click toggle) or by hideNoise. */
let manuallyHidden = new Set<string>();

export const comparePage: PageModule = {
  mount(container: HTMLElement, _params: RouteParams): void {
    // Restore state from URL query params
    applyUrlState(window.location.search);

    const header = el('h2', { class: 'page-header' }, 'Compare');
    container.append(header);

    // Containers
    const selectionContainer = el('div', {});
    const progressContainer = el('div', {});
    const errorContainer = el('div', {});
    const chartContainer = el('div', { class: 'chart-container' },
      el('p', { class: 'no-chart-data' }, 'No data to chart.'),
    );
    const tableContainer = el('div', { class: 'table-container' });

    let lastRows: ComparisonRow[] = [];

    // ----- Compute effective hidden set and render -----

    /** A test is hidden if it's manually hidden OR (noise + hideNoise checked). */
    function computeEffectiveHidden(): Set<string> {
      const state = getState();
      const effective = new Set(manuallyHidden);
      if (state.hideNoise) {
        for (const r of lastRows) {
          if (r.status === 'noise') effective.add(r.test);
        }
      }
      return effective;
    }

    function renderTableAndChart(): void {
      const effectiveHidden = computeEffectiveHidden();
      const visibleRows = lastRows.filter(r => !effectiveHidden.has(r.test));
      renderTable(tableContainer, lastRows, {
        hiddenTests: effectiveHidden,
        onToggle: (test) => {
          if (manuallyHidden.has(test)) {
            manuallyHidden.delete(test);
          } else {
            manuallyHidden.add(test);
          }
          renderTableAndChart();
        },
        onIsolate: (test) => {
          const effectiveNow = computeEffectiveHidden();
          const state = getState();
          const lf = state.testFilter ? state.testFilter.toLowerCase() : '';
          const visibleTests = lastRows
            .filter(r => r.sidePresent === 'both' && !effectiveNow.has(r.test)
              && (!lf || r.test.toLowerCase().includes(lf)))
            .map(r => r.test);

          if (visibleTests.length === 1 && visibleTests[0] === test) {
            // Already isolated — restore all
            manuallyHidden = new Set();
          } else {
            // Hide all visible except the target
            manuallyHidden = new Set(
              lastRows
                .filter(r => r.sidePresent === 'both' && r.test !== test
                  && (!lf || r.test.toLowerCase().includes(lf)))
                .map(r => r.test),
            );
          }
          renderTableAndChart();
        },
      });
      renderChart(chartContainer, visibleRows, true);
    }

    // ----- Recompute from cache (no API calls) -----

    function recomputeFromCache(): void {
      const state = getState();
      if (!state.metric) return;

      const metricFields = getMetricFields();
      const metricField = metricFields.find(f => f.name === state.metric);
      const biggerIsBetter = metricField?.bigger_is_better ?? false;

      // Aggregate from cached samples
      const perRunA = state.sideA.runs
        .map(uuid => sampleCache.get(uuid))
        .filter((s): s is SampleInfo[] => s !== undefined)
        .map(s => aggregateSamplesWithinRun(s, state.metric, state.sampleAgg));

      const perRunB = state.sideB.runs
        .map(uuid => sampleCache.get(uuid))
        .filter((s): s is SampleInfo[] => s !== undefined)
        .map(s => aggregateSamplesWithinRun(s, state.metric, state.sampleAgg));

      const mapA = aggregateAcrossRuns(perRunA, state.sideA.runAgg);
      const mapB = aggregateAcrossRuns(perRunB, state.sideB.runAgg);

      const rows = computeComparison(mapA, mapB, biggerIsBetter, state.noise);
      lastRows = rows;

      renderTableAndChart();
    }

    // ----- Compare callback -----

    function doCompare(): void {
      const state = getState();
      if (state.sideA.runs.length === 0 || state.sideB.runs.length === 0 || !state.metric) {
        return;
      }

      errorContainer.replaceChildren();

      // Check which runs need fetching — separate by side for per-suite API calls
      const uncachedA = state.sideA.runs.filter(uuid => !sampleCache.has(uuid));
      const uncachedB = state.sideB.runs.filter(uuid => !sampleCache.has(uuid));

      if (uncachedA.length === 0 && uncachedB.length === 0) {
        // All data cached — recompute immediately without any API calls
        recomputeFromCache();
        return;
      }

      // Evict stale cache entries (old run UUIDs no longer selected)
      const allRunUuids = new Set([...state.sideA.runs, ...state.sideB.runs]);
      for (const uuid of sampleCache.keys()) {
        if (!allRunUuids.has(uuid)) sampleCache.delete(uuid);
      }

      // Abort any previous fetch
      if (fetchController) fetchController.abort();
      fetchController = new AbortController();
      const { signal } = fetchController;

      // Track per-run cumulative counts for accurate total across parallel fetches
      const perRunLoaded = new Map<string, number>();
      progressContainer.replaceChildren(
        el('span', { class: 'progress-label' }, 'Loading samples...'),
      );

      function updateSampleProgress(uuid: string, loaded: number): void {
        perRunLoaded.set(uuid, loaded);
        let total = 0;
        for (const n of perRunLoaded.values()) total += n;
        progressContainer.replaceChildren(
          el('span', { class: 'progress-label' }, `Loading ${total} samples...`),
        );
      }

      // Fetch uncached runs — each side uses its own suite
      const fetchPromises = [
        ...uncachedA.map(uuid =>
          getSamples(state.sideA.suite, uuid, signal, (loaded) => updateSampleProgress(uuid, loaded)).then(samples => {
            sampleCache.set(uuid, samples);
          }),
        ),
        ...uncachedB.map(uuid =>
          getSamples(state.sideB.suite, uuid, signal, (loaded) => updateSampleProgress(uuid, loaded)).then(samples => {
            sampleCache.set(uuid, samples);
          }),
        ),
      ];

      Promise.all(fetchPromises)
        .then(() => {
          progressContainer.replaceChildren();
          recomputeFromCache();
        })
        .catch((err: unknown) => {
          progressContainer.replaceChildren();
          if (err instanceof DOMException && err.name === 'AbortError') return;
          errorContainer.replaceChildren(
            el('p', { class: 'error-banner' }, `Comparison failed: ${err}`),
          );
        });
    }

    // ----- Initialize selection with testsuites list -----

    initSelection(getTestsuites(), doCompare);

    container.append(selectionContainer);
    renderSelectionPanel(selectionContainer);

    container.append(progressContainer, errorContainer, chartContainer, tableContainer);

    // Wire event listeners (all return cleanup functions)
    eventCleanups.push(
      onCustomEvent<Set<string> | null>(CHART_ZOOM, (tests) => {
        filterToTests(tests);
      }),
      onCustomEvent<string | null>(CHART_HOVER, (testName) => {
        highlightRow(testName);
      }),
      onCustomEvent<string | null>(TABLE_HOVER, (testName) => {
        highlightPoint(testName);
      }),
      onCustomEvent(SETTINGS_CHANGE, () => {
        // Noise % or hideNoise changed. Recompute from cache so status
        // classifications update with the new threshold. hideNoise is
        // applied as a separate filter in computeEffectiveHidden().
        const state = getState();
        if (state.sideA.runs.length > 0 && state.sideB.runs.length > 0 && state.metric) {
          recomputeFromCache();
        } else if (lastRows.length > 0) {
          renderTableAndChart();
        }
      }),
      onCustomEvent(TEST_FILTER_CHANGE, () => {
        if (lastRows.length > 0) {
          renderTableAndChart();
        }
      }),
    );

    // If URL state has suites, trigger per-side data loading
    const state = getState();
    if (state.sideA.suite) fetchSideData('a', state.sideA.suite);
    if (state.sideB.suite) fetchSideData('b', state.sideB.suite);
  },

  unmount(): void {
    // Remove document-level event listeners
    for (const cleanup of eventCleanups) cleanup();
    eventCleanups = [];

    // Abort in-flight sample fetches
    if (fetchController) {
      fetchController.abort();
      fetchController = null;
    }

    // Clear state
    sampleCache.clear();
    manuallyHidden = new Set();

    // Clean up modules with mutable state
    destroyChart();
    resetTable();
  },
};
