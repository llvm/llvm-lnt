// pages/compare.ts — Compare page module for the SPA.
//
// Absorbs the existing comparison code (comparison.ts, selection.ts, table.ts,
// chart.ts) into the SPA as a page module. The mount() function replaces what
// the old standalone main.ts init() did.
//
// Per-run sample caching: fetched samples are cached by run UUID. Changing the
// metric, aggregation, or noise re-aggregates from cache without API calls.
// Only new run UUIDs (from commit/machine changes) trigger fetches.
//
// Cross-suite support: each side can independently select a test suite.
// Samples are fetched from the side's suite. The comparison joins on test name.

import type { PageModule, RouteParams } from '../router';
import type { ComparisonRow, SampleInfo, RegressionListItem } from '../types';
import { getTestsuites } from '../router';
import { getSamples, createRegression, addRegressionIndicators, getRegressions, getToken, authErrorMessage } from '../api';
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
import { el, truncate, debounce } from '../utils';

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
    /** Callback invoked after every table/chart render (used by regression panel). */
    let onAfterRender: (() => void) | null = null;

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
      if (onAfterRender) onAfterRender();
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

    // ----- "Add to Regression" panel -----
    const hasToken = !!getToken();
    const regressionPanel = el('details', { class: 'add-to-regression-panel' });
    // Panel is hidden initially; shown only when both sides have a suite
    regressionPanel.style.display = 'none';
    container.append(regressionPanel);

    if (hasToken) {
      const summary = el('summary', {}, 'Add to Regression');
      regressionPanel.append(summary);

      const content = el('div', { class: 'add-to-regression-content' });
      regressionPanel.append(content);

      const mismatchMsg = el('p', { class: 'regression-label-muted' },
        'Regressions can only be created within a single test suite.');
      mismatchMsg.style.display = 'none';
      content.append(mismatchMsg);

      // Tab buttons
      const tabBar = el('div', { class: 'regression-mode-tabs' });
      const createTab = el('button', { class: 'tab-btn tab-btn-active' }, 'Create New');
      const existingTab = el('button', { class: 'tab-btn' }, 'Add to Existing');
      tabBar.append(createTab, existingTab);
      content.append(tabBar);

      const createContent = el('div', { class: 'create-new-tab' });
      const existingContent = el('div', { class: 'add-existing-tab' });
      existingContent.style.display = 'none';
      content.append(createContent, existingContent);

      createTab.addEventListener('click', () => {
        createTab.classList.add('tab-btn-active');
        existingTab.classList.remove('tab-btn-active');
        createContent.style.display = '';
        existingContent.style.display = 'none';
      });
      existingTab.addEventListener('click', () => {
        existingTab.classList.add('tab-btn-active');
        createTab.classList.remove('tab-btn-active');
        existingContent.style.display = '';
        createContent.style.display = 'none';
      });

      // --- Create New tab ---
      const titleInput = el('input', {
        type: 'text',
        class: 'admin-input',
        placeholder: 'Regression title',
      }) as HTMLInputElement;
      const createInfo = el('p', { class: 'regression-label-muted' });
      const createBtn = el('button', { class: 'compare-btn' }, 'Create Regression') as HTMLButtonElement;
      const createFeedback = el('div', {});
      createContent.append(titleInput, createInfo, createBtn, createFeedback);

      function buildIndicatorsFromComparison(): {
        machine?: string; commit?: string;
        indicators: Array<{ machine: string; test: string; metric: string }>;
      } {
        const st = getState();
        const commit = st.sideB.commit || st.sideA.commit || undefined;
        const machine = st.sideA.machine || st.sideB.machine || undefined;
        const tests = lastRows
          .filter(r => r.sidePresent === 'both')
          .map(r => r.test);
        const indicators = machine && st.metric
          ? tests.map(t => ({ machine, test: t, metric: st.metric }))
          : [];
        return { machine, commit, indicators };
      }

      createBtn.addEventListener('click', async () => {
        const st = getState();
        const suite = st.sideA.suite || st.sideB.suite;
        if (!suite) return;

        createBtn.disabled = true;
        createFeedback.replaceChildren();

        const { commit, indicators } = buildIndicatorsFromComparison();

        try {
          const created = await createRegression(suite, {
            title: titleInput.value.trim() || undefined,
            state: 'detected',
            commit,
            indicators: indicators.length > 0 ? indicators : undefined,
          }, fetchController?.signal);
          createFeedback.replaceChildren(
            el('p', { class: 'regression-feedback-ok' },
              `Regression created: ${created.uuid.slice(0, 8)}`),
          );
        } catch (err: unknown) {
          createFeedback.replaceChildren(
            el('p', { class: 'error-banner' }, authErrorMessage(err)),
          );
        } finally {
          createBtn.disabled = false;
        }
      });

      // --- Add to Existing tab ---
      const searchInput = el('input', {
        type: 'text',
        class: 'admin-input',
        placeholder: 'Search regressions by title...',
      }) as HTMLInputElement;
      const searchResults = el('div', { class: 'regression-search-results' });
      let selectedRegUuid = '';
      const selectedLabel = el('p', { class: 'regression-label-muted' }, 'No regression selected');
      const addExistingBtn = el('button', { class: 'compare-btn', disabled: '' }, 'Add Indicators') as HTMLButtonElement;
      const addExistingFeedback = el('div', {});
      existingContent.append(searchInput, searchResults, selectedLabel, addExistingBtn, addExistingFeedback);

      let regressionsPageCache: RegressionListItem[] | null = null;
      let regressionCacheSuite = '';

      const doSearch = debounce(async () => {
        const st = getState();
        const suite = st.sideA.suite || st.sideB.suite;
        if (!suite) return;

        const filter = searchInput.value.toLowerCase();

        // Fetch once per suite, then filter client-side
        if (!regressionsPageCache || regressionCacheSuite !== suite) {
          try {
            const result = await getRegressions(suite, { limit: 50 }, fetchController?.signal);
            regressionsPageCache = result.items;
            regressionCacheSuite = suite;
          } catch {
            searchResults.replaceChildren(el('p', { class: 'error-banner' }, 'Failed to load'));
            return;
          }
        }

        const matches = filter
          ? regressionsPageCache.filter(r => (r.title || '').toLowerCase().includes(filter))
          : regressionsPageCache;

        searchResults.replaceChildren();
        for (const r of matches) {
          const row = el('div', { class: 'regression-search-row' });
          row.textContent = truncate(r.title || `(untitled) ${r.uuid.slice(0, 8)}`, 60);
          row.addEventListener('click', () => {
            selectedRegUuid = r.uuid;
            selectedLabel.textContent = `Selected: ${truncate(r.title || r.uuid.slice(0, 8), 40)}`;
            addExistingBtn.disabled = false;
          });
          searchResults.append(row);
        }
        if (matches.length === 0) {
          searchResults.replaceChildren(el('p', { class: 'regression-label-muted' }, 'No matches'));
        }
      }, 300);

      searchInput.addEventListener('input', () => doSearch());
      searchInput.addEventListener('focus', () => doSearch());

      addExistingBtn.addEventListener('click', async () => {
        if (!selectedRegUuid) return;
        const st = getState();
        const suite = st.sideA.suite || st.sideB.suite;
        if (!suite) return;

        addExistingBtn.disabled = true;
        addExistingFeedback.replaceChildren();

        const { indicators } = buildIndicatorsFromComparison();

        if (indicators.length === 0) {
          addExistingFeedback.replaceChildren(
            el('p', { class: 'error-banner' }, 'No indicators to add (need machine and metric)'),
          );
          addExistingBtn.disabled = false;
          return;
        }

        try {
          await addRegressionIndicators(suite, selectedRegUuid, indicators, fetchController?.signal);
          addExistingFeedback.replaceChildren(
            el('p', { class: 'regression-feedback-ok' },
              `Added ${indicators.length} indicator(s)`),
          );
        } catch (err: unknown) {
          addExistingFeedback.replaceChildren(
            el('p', { class: 'error-banner' }, authErrorMessage(err)),
          );
        } finally {
          addExistingBtn.disabled = false;
        }
      });

      // Update panel visibility and info when comparison changes
      function updateRegressionPanel(): void {
        const st = getState();
        const suite = st.sideA.suite || st.sideB.suite;
        const hasSuite = !!suite;
        const suitesMatch = !st.sideA.suite || !st.sideB.suite || st.sideA.suite === st.sideB.suite;

        if (!hasSuite) {
          regressionPanel.style.display = 'none';
          return;
        }

        regressionPanel.style.display = '';
        if (!suitesMatch) {
          mismatchMsg.style.display = '';
          tabBar.style.display = 'none';
          createContent.style.display = 'none';
          existingContent.style.display = 'none';
          return;
        }

        mismatchMsg.style.display = 'none';
        tabBar.style.display = '';
        // Restore active tab visibility
        if (createTab.classList.contains('tab-btn-active')) {
          createContent.style.display = '';
          existingContent.style.display = 'none';
        } else {
          createContent.style.display = 'none';
          existingContent.style.display = '';
        }

        // Update info text
        const machine = st.sideA.machine || st.sideB.machine || '(none)';
        const commit = st.sideB.commit || st.sideA.commit || '(none)';
        const testCount = lastRows.filter(r => r.sidePresent === 'both').length;
        createInfo.textContent = `Pre-filled: commit=${truncate(commit, 12)}, machine=${machine}, ${testCount} tests`;
      }

      // Hook into recompute cycle
      onAfterRender = updateRegressionPanel;
    }

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
    onAfterRender = null;

    // Clean up modules with mutable state
    destroyChart();
    resetTable();
  },
};
