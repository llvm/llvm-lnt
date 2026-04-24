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
import type { ComparisonRow, SampleInfo, RegressionListItem, ProfileListItem } from '../types';
import { getTestsuites } from '../router';
import { getSamples, getProfilesForRun, createRegression, addRegressionIndicators, getRegressions, getToken, authErrorMessage } from '../api';
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
  groupSamplesByTest,
} from '../comparison';
import { renderTable, filterToTests, highlightRow, resetTable } from '../table';
import { renderChart, highlightPoint, destroyChart } from '../chart';
import { computeSummaryCounts, renderSummaryBar } from '../components/comparison-summary';
import { el, truncate, debounce, matchesFilter, updateFilterValidation } from '../utils';

/** Cleanup functions for document-level event listeners. */
let eventCleanups: Array<() => void> = [];
/** AbortController for in-flight sample fetches. */
let fetchController: AbortController | null = null;
/** Per-run sample cache: run UUID → samples. */
let sampleCache = new Map<string, SampleInfo[]>();
/** Per-run profile cache: run UUID → profile list items. */
let profileCache = new Map<string, ProfileListItem[]>();
/** Cached profile links (invalidated when profileCache or runs change). */
let cachedProfileLinks: Map<string, string> | undefined = undefined;
/** Cached intermediate aggregation state — preserved when only noise settings change. */
let cachedRawA: Map<string, number[]> | null = null;
let cachedRawB: Map<string, number[]> | null = null;
let cachedMapA: Map<string, number> | null = null;
let cachedMapB: Map<string, number> | null = null;
/** Tests manually hidden by the user (click toggle). */
let manuallyHidden = new Set<string>();
/** Callback invoked after every table/chart render (used by regression panel). */
let onAfterRender: (() => void) | null = null;

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
    const summaryContainer = el('div', { class: 'comparison-summary-container' });
    const tableContainer = el('div', { class: 'table-container' });

    let lastRows: ComparisonRow[] = [];
    let chartZoomFilter: Set<string> | null = null;

    // ----- Compute noise-hidden set, visible tests, and render -----

    /** Tests with noise status that are hidden via the "Hide noise" checkbox. */
    function computeNoiseHidden(): Set<string> {
      const state = getState();
      if (!state.hideNoise) return new Set();
      const noisy = new Set<string>();
      for (const r of lastRows) {
        if (r.status === 'noise') noisy.add(r.test);
      }
      return noisy;
    }

    /** Rows actually in the table (lastRows minus noise-hidden). */
    let tableRows: ComparisonRow[] = [];

    /**
     * Tests visible in the comparison: present on both sides, not
     * noise-hidden, not manually-hidden, and matching the text filter.
     * Used by the regression panel to decide which indicators to create.
     */
    function computeVisibleTests(): string[] {
      const noiseHidden = computeNoiseHidden();
      const filter = getState().testFilter ?? '';
      return lastRows
        .filter(r => r.sidePresent === 'both'
          && !noiseHidden.has(r.test)
          && !manuallyHidden.has(r.test)
          && (!filter || matchesFilter(r.test, filter)))
        .map(r => r.test);
    }

    function buildProfileLinks(): Map<string, string> | undefined {
      if (cachedProfileLinks !== undefined) return cachedProfileLinks;

      const state = getState();
      const repA = state.sideA.runs[state.sideA.runs.length - 1];
      const repB = state.sideB.runs[state.sideB.runs.length - 1];
      const suiteA = state.sideA.suite;
      const suiteB = state.sideB.suite;
      const profilesA = repA ? profileCache.get(repA) ?? [] : [];
      const profilesB = repB ? profileCache.get(repB) ?? [] : [];

      if (profilesA.length === 0 && profilesB.length === 0) {
        cachedProfileLinks = undefined;
        return undefined;
      }

      const profileSetA = new Set(profilesA.map(p => p.test));
      const profileSetB = new Set(profilesB.map(p => p.test));
      const links = new Map<string, string>();

      for (const test of new Set([...profileSetA, ...profileSetB])) {
        const hasA = profileSetA.has(test) && repA;
        const hasB = profileSetB.has(test) && repB;
        const params = new URLSearchParams();

        if (hasA && hasB && suiteA === suiteB) {
          params.set('suite_a', suiteA);
          params.set('run_a', repA);
          params.set('test_a', test);
          params.set('suite_b', suiteB);
          params.set('run_b', repB);
          params.set('test_b', test);
        } else if (hasA) {
          params.set('suite_a', suiteA);
          params.set('run_a', repA);
          params.set('test_a', test);
        } else if (hasB) {
          params.set('suite_b', suiteB);
          params.set('run_b', repB);
          params.set('test_b', test);
        }
        links.set(test, `/profiles?${params.toString()}`);
      }
      cachedProfileLinks = links.size > 0 ? links : undefined;
      return cachedProfileLinks;
    }

    function updateSummaryBar(): void {
      const state = getState();
      const counts = computeSummaryCounts(lastRows, state.testFilter, chartZoomFilter);
      renderSummaryBar(summaryContainer, counts);
    }

    function renderTableAndChart(): void {
      const noiseHidden = computeNoiseHidden();
      tableRows = lastRows.filter(r => !noiseHidden.has(r.test));
      const chartRows = tableRows.filter(r => !manuallyHidden.has(r.test));
      renderTable(tableContainer, tableRows, {
        hiddenTests: manuallyHidden,
        profileLinks: buildProfileLinks(),
        onToggle: (test) => {
          if (manuallyHidden.has(test)) {
            manuallyHidden.delete(test);
          } else {
            manuallyHidden.add(test);
          }
          renderTableAndChart();
        },
        onIsolate: (test) => {
          // Isolate only affects manuallyHidden; the two filters (noise,
          // manual) are independent.
          const state = getState();
          const filter = state.testFilter || '';
          const visibleTests = tableRows
            .filter(r => r.sidePresent === 'both' && !manuallyHidden.has(r.test)
              && (!filter || matchesFilter(r.test, filter)))
            .map(r => r.test);

          if (visibleTests.length === 1 && visibleTests[0] === test) {
            // Already isolated — restore all
            manuallyHidden = new Set();
          } else {
            // Hide all visible except the target
            manuallyHidden = new Set(
              tableRows
                .filter(r => r.sidePresent === 'both' && r.test !== test
                  && (!filter || matchesFilter(r.test, filter)))
                .map(r => r.test),
            );
          }
          renderTableAndChart();
        },
      });
      renderChart(chartContainer, chartRows, true);
      updateSummaryBar();
      if (onAfterRender) onAfterRender();
    }

    // ----- Recompute from cache (no API calls) -----

    function recomputeFromCache(): void {
      const state = getState();
      if (!state.metric) return;

      const metricFields = getMetricFields();
      const metricField = metricFields.find(f => f.name === state.metric);
      const biggerIsBetter = metricField?.bigger_is_better ?? false;

      // Build raw sample pools per side (single pass)
      const samplesA = state.sideA.runs
        .map(uuid => sampleCache.get(uuid))
        .filter((s): s is SampleInfo[] => s !== undefined);
      const samplesB = state.sideB.runs
        .map(uuid => sampleCache.get(uuid))
        .filter((s): s is SampleInfo[] => s !== undefined);

      cachedRawA = groupSamplesByTest(samplesA, state.metric);
      cachedRawB = groupSamplesByTest(samplesB, state.metric);

      // Aggregate within-run then across-runs
      const perRunA = samplesA.map(s => aggregateSamplesWithinRun(s, state.metric, state.sampleAgg));
      const perRunB = samplesB.map(s => aggregateSamplesWithinRun(s, state.metric, state.sampleAgg));
      cachedMapA = aggregateAcrossRuns(perRunA, state.sideA.runAgg);
      cachedMapB = aggregateAcrossRuns(perRunB, state.sideB.runAgg);

      const rows = computeComparison(cachedMapA, cachedMapB, biggerIsBetter, state.noiseConfig, cachedRawA, cachedRawB);
      lastRows = rows;

      renderTableAndChart();
    }

    /** Re-classify from cached aggregated maps (no re-aggregation). */
    function reclassifyFromCache(): void {
      const state = getState();
      if (!state.metric || !cachedMapA || !cachedMapB) return;

      const metricFields = getMetricFields();
      const metricField = metricFields.find(f => f.name === state.metric);
      const biggerIsBetter = metricField?.bigger_is_better ?? false;

      lastRows = computeComparison(cachedMapA, cachedMapB, biggerIsBetter, state.noiseConfig, cachedRawA ?? undefined, cachedRawB ?? undefined);
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
      for (const uuid of profileCache.keys()) {
        if (!allRunUuids.has(uuid)) profileCache.delete(uuid);
      }
      cachedProfileLinks = undefined;
      // Invalidate aggregation caches — data is changing
      cachedRawA = null;
      cachedRawB = null;
      cachedMapA = null;
      cachedMapB = null;

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

      // Fetch profiles for the representative (latest) run on each side
      const repA = state.sideA.runs[state.sideA.runs.length - 1];
      const repB = state.sideB.runs[state.sideB.runs.length - 1];
      if (repA && !profileCache.has(repA)) {
        fetchPromises.push(
          getProfilesForRun(state.sideA.suite, repA, signal)
            .then(profiles => { profileCache.set(repA, profiles); cachedProfileLinks = undefined; })
            .catch(() => {}),
        );
      }
      if (repB && !profileCache.has(repB)) {
        fetchPromises.push(
          getProfilesForRun(state.sideB.suite, repB, signal)
            .then(profiles => { profileCache.set(repB, profiles); cachedProfileLinks = undefined; })
            .catch(() => {}),
        );
      }

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

    container.append(progressContainer, errorContainer, chartContainer, summaryContainer, tableContainer);

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
        const tests = computeVisibleTests();
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

        const filter = searchInput.value;

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
          ? regressionsPageCache.filter(r => matchesFilter(r.title || '', filter))
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

      searchInput.addEventListener('input', () => {
        updateFilterValidation(searchInput);
        doSearch();
      });
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
        const testCount = computeVisibleTests().length;
        createInfo.textContent = `Pre-filled: commit=${truncate(commit, 12)}, machine=${machine}, ${testCount} tests`;
      }

      // Hook into recompute cycle
      onAfterRender = updateRegressionPanel;
    }

    // Wire event listeners (all return cleanup functions)
    eventCleanups.push(
      onCustomEvent<Set<string> | null>(CHART_ZOOM, (tests) => {
        chartZoomFilter = tests;
        filterToTests(tests);
        updateSummaryBar();
      }),
      onCustomEvent<string | null>(CHART_HOVER, (testName) => {
        highlightRow(testName);
      }),
      onCustomEvent<string | null>(TABLE_HOVER, (testName) => {
        highlightPoint(testName);
      }),
      onCustomEvent(SETTINGS_CHANGE, () => {
        // Noise or aggregation settings changed. If only noise/hideNoise changed,
        // re-classify from cached maps (no re-aggregation). If aggregation
        // changed, full recompute is needed (cachedMapA will be invalidated).
        const state = getState();
        if (state.sideA.runs.length > 0 && state.sideB.runs.length > 0 && state.metric) {
          if (cachedMapA && cachedMapB) {
            reclassifyFromCache();
          } else {
            recomputeFromCache();
          }
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
    profileCache.clear();
    cachedProfileLinks = undefined;
    cachedRawA = null;
    cachedRawB = null;
    cachedMapA = null;
    cachedMapB = null;
    manuallyHidden = new Set();
    onAfterRender = null;

    // Clean up modules with mutable state
    destroyChart();
    resetTable();
  },
};
