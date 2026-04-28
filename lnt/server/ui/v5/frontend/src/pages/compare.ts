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
import type { ComparisonRow, SampleInfo, ProfileListItem } from '../types';
import { getTestsuites } from '../router';
import { getSamples, getProfilesForRun, createRegression, addRegressionIndicators, getToken, authErrorMessage } from '../api';
import { renderRegressionCombobox } from '../components/regression-combobox';
import {
  CHART_ZOOM, CHART_HOVER, TABLE_HOVER,
  TEST_FILTER_CHANGE, SETTINGS_CHANGE,
  onCustomEvent,
} from '../events';
import { getState, applyUrlState, setShadow, clearShadow } from '../state';
import {
  initSelection, fetchSideData, getMetricFields, renderSelectionPanel,
} from '../selection';
import {
  aggregateSamplesWithinRun, aggregateAcrossRuns, computeComparison,
  groupSamplesByTest,
} from '../comparison';
import { renderTable, filterToTests, highlightRow, resetTable, applyTableFilters } from '../table';
import { renderChart, highlightPoint, destroyChart } from '../chart';
import { computeSummaryCounts, renderSummaryBar } from '../components/comparison-summary';
import { el, truncate, matchesFilter, agnosticLink } from '../utils';

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
/** Regression combobox handle for lifecycle cleanup. */
let regComboCleanup: { destroy: () => void } | null = null;
/** Pending requestAnimationFrame ID for chart rendering. */
let pendingChartRAF: number | null = null;
/** Generation counter for RAF-batched chart renders. */
let chartRenderGen = 0;
/** Cached shadow comparison rows. */
let shadowRows: ComparisonRow[] = [];
/** Cached shadow side B intermediate aggregation state. */
let cachedShadowRawB: Map<string, number[]> | null = null;
let cachedShadowMapB: Map<string, number> | null = null;

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

    function scheduleChartRender(
      chartRows: ComparisonRow[],
      preFilteredTests?: Set<string> | null,
    ): void {
      chartRenderGen++;
      const gen = chartRenderGen;
      if (pendingChartRAF !== null) cancelAnimationFrame(pendingChartRAF);
      pendingChartRAF = requestAnimationFrame(() => {
        pendingChartRAF = null;
        if (gen !== chartRenderGen) return;
        const state = getState();
        const noiseHidden = computeNoiseHidden();
        const filteredShadow = state.shadow
          ? shadowRows.filter(r => !noiseHidden.has(r.test) && !manuallyHidden.has(r.test))
          : undefined;
        renderChart(chartContainer, chartRows, {
          preserveZoom: true,
          preFilteredTests,
          shadowRows: filteredShadow,
          shadowLabel: state.shadow
            ? `${truncate(state.shadow.sideB.commit, 12)} on ${state.shadow.sideB.machine}`
            : undefined,
        });
      });
    }

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

    function syncChartAndSummary(matchingTests: Set<string> | null): void {
      const noiseHidden = computeNoiseHidden();
      const chartRows = lastRows
        .filter(r => !noiseHidden.has(r.test) && !manuallyHidden.has(r.test));
      scheduleChartRender(chartRows, matchingTests);

      const testFilter = getState().testFilter ?? '';
      const counts = computeSummaryCounts(lastRows, testFilter, chartZoomFilter, matchingTests);
      renderSummaryBar(summaryContainer, counts);

      if (onAfterRender) onAfterRender();
    }

    function renderTableAndChart(): void {
      const noiseHidden = computeNoiseHidden();
      tableRows = lastRows.filter(r => !noiseHidden.has(r.test));

      // Pre-compute filtered test set once
      const state = getState();
      const testFilter = state.testFilter ?? '';
      const matchingTests: Set<string> | null = testFilter
        ? new Set(lastRows.filter(r => matchesFilter(r.test, testFilter)).map(r => r.test))
        : null;

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
          const visibleTests = tableRows
            .filter(r => r.sidePresent === 'both' && !manuallyHidden.has(r.test)
              && (matchingTests ? matchingTests.has(r.test) : true))
            .map(r => r.test);

          if (visibleTests.length === 1 && visibleTests[0] === test) {
            // Already isolated — restore all
            manuallyHidden = new Set();
          } else {
            // Hide all visible except the target
            manuallyHidden = new Set(
              tableRows
                .filter(r => r.sidePresent === 'both' && r.test !== test
                  && (matchingTests ? matchingTests.has(r.test) : true))
                .map(r => r.test),
            );
          }
          renderTableAndChart();
        },
      });
      syncChartAndSummary(matchingTests);
    }

    // ----- Recompute from cache (no API calls) -----

    function currentBiggerIsBetter(): boolean {
      const field = getMetricFields().find(f => f.name === getState().metric);
      return field?.bigger_is_better ?? false;
    }

    function recomputeFromCache(): void {
      const state = getState();
      if (!state.metric) return;

      const biggerIsBetter = currentBiggerIsBetter();

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

      recomputeShadow(biggerIsBetter);
      renderTableAndChart();
    }

    /** Re-classify from cached aggregated maps (no re-aggregation). */
    function reclassifyFromCache(): void {
      const state = getState();
      if (!state.metric || !cachedMapA || !cachedMapB) return;

      const biggerIsBetter = currentBiggerIsBetter();

      lastRows = computeComparison(cachedMapA, cachedMapB, biggerIsBetter, state.noiseConfig, cachedRawA ?? undefined, cachedRawB ?? undefined);
      recomputeShadow(biggerIsBetter);
      renderTableAndChart();
    }

    function clearShadowCaches(): void {
      shadowRows = [];
      cachedShadowRawB = null;
      cachedShadowMapB = null;
    }

    function recomputeShadow(biggerIsBetter?: boolean): void {
      const state = getState();
      if (!state.shadow || !state.metric || !cachedMapA || !cachedRawA) {
        shadowRows = [];
        return;
      }

      const bib = biggerIsBetter ?? currentBiggerIsBetter();

      const shadowSamplesB = state.shadow.sideB.runs
        .map(uuid => sampleCache.get(uuid))
        .filter((s): s is SampleInfo[] => s !== undefined);

      if (shadowSamplesB.length === 0) {
        shadowRows = [];
        return;
      }

      cachedShadowRawB = groupSamplesByTest(shadowSamplesB, state.metric);
      const perRunShadowB = shadowSamplesB.map(s =>
        aggregateSamplesWithinRun(s, state.metric, state.sampleAgg));
      cachedShadowMapB = aggregateAcrossRuns(perRunShadowB, state.shadow.sideB.runAgg);

      shadowRows = computeComparison(
        cachedMapA, cachedShadowMapB, bib,
        state.noiseConfig, cachedRawA, cachedShadowRawB,
      );
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
      const uncachedShadow = state.shadow
        ? state.shadow.sideB.runs.filter(uuid => !sampleCache.has(uuid))
        : [];

      if (uncachedA.length === 0 && uncachedB.length === 0 && uncachedShadow.length === 0) {
        // All data cached — recompute immediately without any API calls
        recomputeFromCache();
        return;
      }

      // Evict stale cache entries (old run UUIDs no longer selected or shadow-referenced)
      const shadowRuns = state.shadow ? state.shadow.sideB.runs : [];
      const allRunUuids = new Set([...state.sideA.runs, ...state.sideB.runs, ...shadowRuns]);
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
      clearShadowCaches();

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

      // Shadow fetches use shadow's own suite and are isolated so failures don't kill main
      const shadowFetchPromises = uncachedShadow.map(uuid =>
        getSamples(state.shadow!.sideB.suite, uuid, signal, (loaded) => updateSampleProgress(uuid, loaded)).then(samples => {
          sampleCache.set(uuid, samples);
        }),
      );

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

      // Main fetches fail hard, shadow fetches fail soft
      Promise.all([
        Promise.all(fetchPromises),
        Promise.allSettled(shadowFetchPromises),
      ])
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

    // Shadow pin button — injected into Side B panel header
    const pinBtn = el('button', {
      class: 'compare-btn shadow-pin-btn', disabled: true,
    }, 'Pin as Shadow') as HTMLButtonElement;
    pinBtn.style.display = 'none';
    const sideBHeader = selectionContainer.querySelector('.side-b h3');
    if (sideBHeader) {
      const headerRow = el('div', { class: 'side-header-row' });
      sideBHeader.replaceWith(headerRow);
      headerRow.append(sideBHeader, pinBtn);
    }

    // Shadow chip — toolbar row above chart (outside settings)
    const shadowToolbar = el('div', { class: 'action-row shadow-toolbar' });
    shadowToolbar.style.display = 'none';
    const shadowBadge = el('span', { class: 'machine-chip' });
    const dismissBtn = el('button', { class: 'chip-remove', title: 'Remove shadow' }, '\u00d7');
    shadowToolbar.append(shadowBadge);

    function updateShadowToolbar(): void {
      const st = getState();
      const hasComparison = st.sideA.runs.length > 0 &&
        st.sideB.runs.length > 0 && !!st.metric;

      // Pin button in Side B panel
      pinBtn.style.display = (hasComparison && !st.shadow) ? '' : 'none';
      pinBtn.disabled = !hasComparison;

      // Shadow chip above chart
      if (st.shadow) {
        shadowToolbar.style.display = '';
        const label = `Shadow: ${truncate(st.shadow.sideB.commit, 12)} on ${st.shadow.sideB.machine}`;
        shadowBadge.replaceChildren(label + ' ', dismissBtn);
      } else {
        shadowToolbar.style.display = 'none';
      }
    }

    pinBtn.addEventListener('click', () => {
      clearShadowCaches();
      const snapshot = structuredClone(getState().sideB);
      setShadow({ sideB: snapshot });
      recomputeShadow();
      renderTableAndChart();
    });

    dismissBtn.addEventListener('click', () => {
      clearShadow();
      clearShadowCaches();
      renderTableAndChart();
    });

    container.append(progressContainer, errorContainer, shadowToolbar, chartContainer, summaryContainer, tableContainer);

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
        const st = getState();
        const suite = st.sideA.suite || st.sideB.suite;
        if (suite && !regComboHandle) {
          createRegCombo(suite);
        }
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
          const linkText = created.title || created.uuid.slice(0, 8);
          const linkPath = `/${encodeURIComponent(suite)}/regressions/${encodeURIComponent(created.uuid)}`;
          const msg = el('p', { class: 'regression-feedback-ok' }, 'Regression created: ');
          msg.append(agnosticLink(linkText, linkPath));
          createFeedback.replaceChildren(msg);
          titleInput.value = '';
        } catch (err: unknown) {
          createFeedback.replaceChildren(
            el('p', { class: 'error-banner' }, authErrorMessage(err)),
          );
        } finally {
          createBtn.disabled = false;
        }
      });

      // --- Add to Existing tab ---
      let selectedRegUuid = '';
      const addExistingBtn = el('button', { class: 'compare-btn', disabled: '' }, 'Add Indicators') as HTMLButtonElement;
      const addExistingFeedback = el('div', {});

      // Regression combobox — fetches data on creation, filters locally
      let regComboHandle: ReturnType<typeof renderRegressionCombobox> | null = null;
      const regComboContainer = el('div', {});

      function createRegCombo(suite: string): void {
        if (regComboHandle) regComboHandle.destroy();
        regComboContainer.replaceChildren();
        selectedRegUuid = '';
        addExistingBtn.disabled = true;
        regComboHandle = renderRegressionCombobox(regComboContainer, {
          testsuite: suite,
          onSelect: (uuid, _title) => {
            selectedRegUuid = uuid;
            addExistingBtn.disabled = false;
          },
          onClear: () => {
            selectedRegUuid = '';
            addExistingBtn.disabled = true;
          },
        });
        regComboCleanup = regComboHandle;
      }

      existingContent.append(regComboContainer, addExistingBtn, addExistingFeedback);

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
          const updated = await addRegressionIndicators(suite, selectedRegUuid, indicators, fetchController?.signal);
          const linkText = updated.title || selectedRegUuid.slice(0, 8);
          const linkPath = `/${encodeURIComponent(suite)}/regressions/${encodeURIComponent(selectedRegUuid)}`;
          const msg = el('p', { class: 'regression-feedback-ok' },
            `Added ${indicators.length} indicator(s) to `);
          msg.append(agnosticLink(linkText, linkPath));
          addExistingFeedback.replaceChildren(msg);
        } catch (err: unknown) {
          addExistingFeedback.replaceChildren(
            el('p', { class: 'error-banner' }, authErrorMessage(err)),
          );
        } finally {
          addExistingBtn.disabled = false;
        }
      });

      // Update panel visibility and info when comparison changes
      let comboboxSuite = '';
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

        // Invalidate combobox when suite changes
        if (suite !== comboboxSuite) {
          if (regComboHandle) regComboHandle.destroy();
          regComboContainer.replaceChildren();
          regComboHandle = null;
          regComboCleanup = null;
          selectedRegUuid = '';
          addExistingBtn.disabled = true;
          comboboxSuite = suite;

          if (existingTab.classList.contains('tab-btn-active')) {
            createRegCombo(suite);
          }
        }

        // Update info text
        const machine = st.sideA.machine || st.sideB.machine || '(none)';
        const commit = st.sideB.commit || st.sideA.commit || '(none)';
        const testCount = computeVisibleTests().length;
        createInfo.textContent = `Pre-filled: commit=${truncate(commit, 12)}, machine=${machine}, ${testCount} tests`;
      }

      // Hook into recompute cycle
      onAfterRender = () => {
        updateRegressionPanel();
        updateShadowToolbar();
      };

      // Initial panel setup (creates combobox if suite is available from URL)
      updateRegressionPanel();
    }

    // Wire event listeners (all return cleanup functions)
    eventCleanups.push(
      onCustomEvent<Set<string> | null>(CHART_ZOOM, (tests) => {
        chartZoomFilter = tests;
        filterToTests(tests);
        const testFilter = getState().testFilter ?? '';
        const counts = computeSummaryCounts(lastRows, testFilter, chartZoomFilter);
        renderSummaryBar(summaryContainer, counts);
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
        if (lastRows.length === 0) return;
        const matchingTests = applyTableFilters();
        syncChartAndSummary(matchingTests);
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
    shadowRows = [];
    cachedShadowRawB = null;
    cachedShadowMapB = null;
    manuallyHidden = new Set();
    onAfterRender = null;

    // Destroy regression combobox
    if (regComboCleanup) {
      regComboCleanup.destroy();
      regComboCleanup = null;
    }

    // Cancel pending chart RAF
    if (pendingChartRAF !== null) {
      cancelAnimationFrame(pendingChartRAF);
      pendingChartRAF = null;
    }
    chartRenderGen = 0;

    // Clean up modules with mutable state
    destroyChart();
    resetTable();
  },
};
