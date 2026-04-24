import type { AggFn, FieldInfo, CommitSummary, SideSelection } from './types';
import { SETTINGS_CHANGE, TEST_FILTER_CHANGE } from './events';
import { getFields, getCommits, getRuns, getTestSuiteInfoCached } from './api';
import { getBasePath } from './router';
import { getState, setSideA, setSideB, setState, setNoiseConfig, swapSides } from './state';
import { debounce, el, commitDisplayValue, updateFilterValidation } from './utils';
import {
  createCommitCombobox, createMachineCombobox, resetComboboxState,
  refreshCommitDisplay,
  type ComboboxContext,
} from './combobox';
import { renderMetricSelector, renderEmptyMetricSelector, filterMetricFields } from './components/metric-selector';

// Per-side cached data
let cachedCommitsA: CommitSummary[] = [];
let cachedCommitsB: CommitSummary[] = [];
let cachedFieldsA: FieldInfo[] = [];
let cachedFieldsB: FieldInfo[] = [];
let testsuites: string[] = [];
let onCompare: (() => void) | null = null;
// Schema commit_fields per suite for display resolution
const commitFieldsCache = new Map<string, Array<{ name: string; display?: boolean }>>();

// Staleness counters for createRunsPanel — prevents earlier async calls
// from overwriting the DOM when a newer call has been issued.
let runsPanelVersionA = 0;
let runsPanelVersionB = 0;

// Per-side suite data loading version counters — prevents stale fetches
// from overwriting data when the suite changes rapidly.
let suiteLoadVersionA = 0;
let suiteLoadVersionB = 0;

// Per-side abort controllers for machine-filtered commit fetches
let commitFetchControllerA: AbortController | null = null;
let commitFetchControllerB: AbortController | null = null;

/** Module-level reference to the metric selector container for re-rendering. */
let metricContainerRef: HTMLElement | null = null;

/**
 * Initialize the selection module.
 * Replaces the old setCachedData() — no upfront data fetching.
 */
export function initSelection(
  availableTestsuites: string[],
  compareFn?: () => void,
): void {
  testsuites = availableTestsuites;
  if (compareFn) onCompare = compareFn;
  cachedCommitsA = [];
  cachedCommitsB = [];
  cachedFieldsA = [];
  cachedFieldsB = [];
  if (commitFetchControllerA) { commitFetchControllerA.abort(); commitFetchControllerA = null; }
  if (commitFetchControllerB) { commitFetchControllerB.abort(); commitFetchControllerB = null; }
}

export function getMetricFields(): FieldInfo[] {
  // Union of fields from both sides, deduplicated by name
  const seen = new Set<string>();
  const merged: FieldInfo[] = [];
  for (const f of [...cachedFieldsA, ...cachedFieldsB]) {
    if (!seen.has(f.name)) {
      seen.add(f.name);
      merged.push(f);
    }
  }
  return filterMetricFields(merged);
}

function getSideState(side: 'a' | 'b') {
  const state = getState();
  return {
    selection: side === 'a' ? state.sideA : state.sideB,
    setSide: side === 'a' ? setSideA : setSideB,
    label: side === 'a' ? 'Side A (Baseline)' : 'Side B (New)',
  };
}

function getCommitDataForSide(side: 'a' | 'b') {
  const commits = side === 'a' ? cachedCommitsA : cachedCommitsB;
  const cachedCommitValues = commits.map(c => c.commit);
  const { selection } = getSideState(side);
  const cf = selection.suite ? commitFieldsCache.get(selection.suite) : undefined;
  let displayMap: Map<string, string> | undefined;
  if (cf) {
    displayMap = new Map<string, string>();
    for (const c of commits) {
      const display = commitDisplayValue(c, cf);
      if (display !== c.commit) displayMap.set(c.commit, display);
    }
    if (displayMap.size === 0) displayMap = undefined;
  }
  return { cachedCommitValues, displayMap };
}

/**
 * Fetch commits filtered by machine for a side.
 * Aborts any previous in-flight commit fetch for the same side.
 */
async function fetchCommitsForMachine(side: 'a' | 'b', machine: string): Promise<void> {
  const prev = side === 'a' ? commitFetchControllerA : commitFetchControllerB;
  if (prev) prev.abort();
  const ctrl = new AbortController();
  if (side === 'a') commitFetchControllerA = ctrl;
  else commitFetchControllerB = ctrl;

  const { selection } = getSideState(side);
  const suite = selection.suite;
  if (!suite) return;

  try {
    const commits = await getCommits(suite, { machine, signal: ctrl.signal });
    if (side === 'a') cachedCommitsA = commits;
    else cachedCommitsB = commits;
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    if (side === 'a') cachedCommitsA = [];
    else cachedCommitsB = [];
  }
}

function getComboboxContext(): ComboboxContext {
  return {
    getCommitData: getCommitDataForSide,
    getSuiteName: (side: 'a' | 'b') => {
      const { selection } = getSideState(side);
      return selection.suite;
    },
    getSideState,
    fetchCommitsForMachine,
  };
}

/** Auto-trigger comparison when state is valid (both sides have runs + metric). */
function tryAutoCompare(): void {
  const state = getState();
  if (state.sideA.runs.length > 0
    && state.sideB.runs.length > 0
    && state.metric !== ''
    && onCompare) {
    onCompare();
  }
}

/**
 * Debounced version of tryAutoCompare, used only in checkbox change handlers.
 * When the user rapidly toggles multiple run checkboxes, the calls coalesce
 * into a single comparison after a short delay, avoiding redundant API calls.
 */
const debouncedTryAutoCompare = debounce(tryAutoCompare, 150);

function createRunsPanel(side: 'a' | 'b', container: HTMLElement, setSide: (partial: Partial<SideSelection>) => void): void {
  // Increment the version counter for this side so any in-flight request
  // from a previous call knows it is stale and should not touch the DOM.
  const version = side === 'a' ? ++runsPanelVersionA : ++runsPanelVersionB;

  const { selection: sideState } = getSideState(side);

  if (!sideState.suite || !sideState.commit || !sideState.machine) {
    container.replaceChildren(el('span', { class: 'runs-hint' }, 'Select a commit first'));
    return;
  }

  container.replaceChildren(el('span', { class: 'runs-loading' }, 'Loading runs...'));

  getRuns(sideState.suite, { machine: sideState.machine, commit: sideState.commit })
    .then(runs => {
      // A newer createRunsPanel call was made while we were waiting —
      // discard this stale result to avoid overwriting fresh data.
      const currentVersion = side === 'a' ? runsPanelVersionA : runsPanelVersionB;
      if (version !== currentVersion) return;
      container.replaceChildren();
      if (runs.length === 0) {
        container.append(el('span', { class: 'runs-empty' }, 'No runs found'));
        setSide({ runs: [] });
        return;
      }

      // If the URL state has run UUIDs that match available runs, restore
      // that selection (some runs may be unchecked). Otherwise select all.
      const urlRuns = new Set(sideState.runs);
      const hasUrlMatch = runs.some(r => urlRuns.has(r.uuid));

      for (const run of runs) {
        const id = `run-${side}-${run.uuid}`;
        const cb = el('input', { type: 'checkbox', id, value: run.uuid });
        cb.checked = hasUrlMatch ? urlRuns.has(run.uuid) : true;
        const label = el('label', { for: id },
          run.submitted_at ? new Date(run.submitted_at).toLocaleString() : '(no time)',
        );
        const link = el('a', {
          href: `${getBasePath()}/${encodeURIComponent(sideState.suite)}/runs/${encodeURIComponent(run.uuid)}`,
          class: 'run-uuid',
        }, `UUID ${run.uuid.slice(0, 8)}`);
        container.append(el('div', { class: 'run-row' }, cb, label, link));

        cb.addEventListener('change', () => {
          const checked = container.querySelectorAll<HTMLInputElement>('input:checked');
          setSide({ runs: Array.from(checked).map(c => c.value) });
          updateRunAggState(side);
          debouncedTryAutoCompare();
        });
      }

      const checked = container.querySelectorAll<HTMLInputElement>('input:checked');
      setSide({ runs: Array.from(checked).map(c => c.value) });
      updateRunAggState(side);
      tryAutoCompare();
    })
    .catch(e => {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      container.replaceChildren(el('span', { class: 'runs-error' }, 'Error loading runs'));
    });
}

let runAggSelectA: HTMLSelectElement | null = null;
let runAggSelectB: HTMLSelectElement | null = null;

function updateRunAggState(side: 'a' | 'b'): void {
  const sel = side === 'a' ? runAggSelectA : runAggSelectB;
  if (!sel) return;
  const { selection } = getSideState(side);
  sel.disabled = selection.runs.length <= 1;
}

function createRunAggSelect(
  side: 'a' | 'b',
  setSide: (partial: Partial<SideSelection>) => void,
): HTMLSelectElement {
  const { selection } = getSideState(side);
  const select = el('select', { class: 'agg-select' }) as HTMLSelectElement;
  for (const v of ['median', 'mean', 'min', 'max'] as AggFn[]) {
    const opt = el('option', { value: v }, v);
    if (v === selection.runAgg) (opt as HTMLOptionElement).selected = true;
    select.append(opt);
  }
  select.disabled = true;
  select.addEventListener('change', () => {
    setSide({ runAgg: select.value as AggFn });
    tryAutoCompare();
  });
  if (side === 'a') runAggSelectA = select;
  else runAggSelectB = select;
  return select;
}

function createSampleAggSelect(): HTMLSelectElement {
  const state = getState();
  const select = el('select', { class: 'agg-select' }) as HTMLSelectElement;
  for (const v of ['median', 'mean', 'min', 'max'] as AggFn[]) {
    const opt = el('option', { value: v }, v);
    if (v === state.sampleAgg) (opt as HTMLOptionElement).selected = true;
    select.append(opt);
  }
  select.addEventListener('change', () => {
    setState({ sampleAgg: select.value as AggFn });
    tryAutoCompare();
  });
  return select;
}

/**
 * Fetch fields and suite info for a side when its suite changes.
 * Commits are NOT fetched here — they are fetched per-machine when a
 * machine is selected (via fetchCommitsForMachine).
 */
export async function fetchSideData(
  side: 'a' | 'b',
  suite: string,
): Promise<void> {
  const version = side === 'a' ? ++suiteLoadVersionA : ++suiteLoadVersionB;

  // Clear stale commits from a previous suite/machine selection
  if (side === 'a') cachedCommitsA = [];
  else cachedCommitsB = [];

  try {
    const [fields, suiteInfo] = await Promise.all([
      getFields(suite),
      getTestSuiteInfoCached(suite).catch(() => null),
    ]);

    if (suiteInfo) {
      commitFieldsCache.set(suite, suiteInfo.schema.commit_fields);
    }

    // Check for staleness
    const currentVersion = side === 'a' ? suiteLoadVersionA : suiteLoadVersionB;
    if (version !== currentVersion) return;

    refreshCommitDisplay(side, getSideState(side).selection.commit);

    if (side === 'a') {
      cachedFieldsA = fields;
    } else {
      cachedFieldsB = fields;
    }

    // Re-render metric selector — read metricContainerRef AFTER await
    // so it targets the current DOM element (not one from before re-render).
    const target = metricContainerRef;
    if (target) {
      target.replaceChildren();
      renderMetricSelector(target, getMetricFields(), (metric) => {
        setState({ metric });
        tryAutoCompare();
      }, getState().metric, { placeholder: true });
    }
  } catch {
    // Silently ignore fetch errors — controls stay disabled
  }
}

// Main render
export function renderSelectionPanel(root: HTMLElement): void {
  root.replaceChildren();
  resetComboboxState();

  const panel = el('div', { class: 'controls-panel' });

  // Side A and B
  const sidesRow = el('div', { class: 'sides-row' });
  const runsContainers: Record<string, HTMLElement> = {};
  const sideDivs: HTMLElement[] = [];

  // Global controls (created early so fetchSideData can update metric selector)
  const globalRow = el('div', { class: 'global-controls' });
  const metricContainer = el('div', {});
  metricContainerRef = metricContainer;
  const metricFields = getMetricFields();
  if (metricFields.length > 0) {
    renderMetricSelector(metricContainer, metricFields, (metric) => {
      setState({ metric });
      tryAutoCompare();
    }, getState().metric, { placeholder: true });
  } else {
    renderEmptyMetricSelector(metricContainer);
  }
  globalRow.append(metricContainer);

  for (const side of ['a', 'b'] as const) {
    const { setSide, label } = getSideState(side);

    const sideDiv = el('div', { class: `side side-${side}` });
    sideDiv.append(el('h3', {}, label));

    // Suite selector
    sideDiv.append(el('label', {}, 'Suite'));
    const suiteSelect = el('select', { class: 'suite-select' }) as HTMLSelectElement;
    const emptyOpt = el('option', { value: '' }, '-- Select suite --');
    suiteSelect.append(emptyOpt);
    const { selection: sideState } = getSideState(side);
    for (const name of testsuites) {
      const opt = el('option', { value: name }, name);
      if (name === sideState.suite) (opt as HTMLOptionElement).selected = true;
      suiteSelect.append(opt);
    }
    suiteSelect.addEventListener('change', () => {
      const newSuite = suiteSelect.value;
      setSide({ suite: newSuite, machine: '', commit: '', runs: [] });
      if (newSuite) {
        fetchSideData(side, newSuite);
      } else {
        // Clear cached data for this side so metrics/commits don't linger
        if (side === 'a') { cachedFieldsA = []; cachedCommitsA = []; }
        else { cachedFieldsB = []; cachedCommitsB = []; }
      }
      // Re-render the panel to update comboboxes with new suite context
      renderSelectionPanel(root);
    });
    sideDiv.append(suiteSelect);

    const runsContainer = el('div', { class: 'runs-container' });
    runsContainers[side] = runsContainer;

    const ctx = getComboboxContext();
    const refreshRuns = () => createRunsPanel(side, runsContainer, setSide);

    // Machine
    sideDiv.append(el('label', {}, 'Machine'));
    sideDiv.append(createMachineCombobox(side, setSide, refreshRuns, ctx));

    // Order
    sideDiv.append(el('label', {}, 'Commit'));
    sideDiv.append(createCommitCombobox(side, setSide, refreshRuns, ctx));

    // Runs
    sideDiv.append(el('label', {}, 'Runs'));
    sideDiv.append(runsContainer);

    // Run aggregation
    const aggRow = el('div', { class: 'agg-row' });
    aggRow.append(el('label', {}, 'Run aggregation:'));
    aggRow.append(createRunAggSelect(side, setSide));
    sideDiv.append(aggRow);

    sideDivs.push(sideDiv);
  }

  // Swap button between the two sides
  const swapBtn = el('button', {
    class: 'swap-sides-btn',
    title: 'Swap A and B sides',
    'aria-label': 'Swap A and B sides',
  }, '\u21C4');
  swapBtn.addEventListener('click', () => {
    swapSides();
    // Also swap per-side caches; abort in-flight commit fetches
    // (they would write to the wrong logical side after the swap).
    const tmpCommits = cachedCommitsA;
    cachedCommitsA = cachedCommitsB;
    cachedCommitsB = tmpCommits;
    const tmpFields = cachedFieldsA;
    cachedFieldsA = cachedFieldsB;
    cachedFieldsB = tmpFields;
    if (commitFetchControllerA) { commitFetchControllerA.abort(); commitFetchControllerA = null; }
    if (commitFetchControllerB) { commitFetchControllerB.abort(); commitFetchControllerB = null; }
    renderSelectionPanel(root);
    tryAutoCompare();
  });

  sidesRow.append(sideDivs[0], swapBtn, sideDivs[1]);
  panel.append(sidesRow);

  // Continue global controls
  const sampleAggGroup = el('div', { class: 'control-group' });
  sampleAggGroup.append(el('label', {}, 'Sample aggregation'));
  sampleAggGroup.append(createSampleAggSelect());
  globalRow.append(sampleAggGroup);

  // Hide noise checkbox (outside collapsible, always visible)
  const hideNoiseGroup = el('div', { class: 'control-group control-group-checkbox' });
  const hideNoiseCb = el('input', { type: 'checkbox', id: 'hide-noise' }) as HTMLInputElement;
  hideNoiseCb.checked = getState().hideNoise;
  hideNoiseCb.addEventListener('change', () => {
    setState({ hideNoise: hideNoiseCb.checked });
    document.dispatchEvent(new CustomEvent(SETTINGS_CHANGE));
  });
  hideNoiseGroup.append(hideNoiseCb);
  hideNoiseGroup.append(el('label', { for: 'hide-noise' }, 'Hide noise'));
  globalRow.append(hideNoiseGroup);

  // Collapsible noise filtering section
  const noisePanel = el('details', { class: 'noise-filtering-panel' });
  noisePanel.append(el('summary', {}, 'Noise filtering'));
  const noiseBody = el('div', { class: 'noise-filtering-body' });

  const nc = getState().noiseConfig;

  // Helper to build a knob row
  function buildKnobRow(
    knobKey: 'pct' | 'pval' | 'floor',
    label: string,
    tooltip: string,
    inputAttrs: Record<string, string>,
    validate: (v: number) => boolean,
  ): HTMLElement {
    const knob = nc[knobKey];
    const row = el('div', { class: 'noise-knob-row' });

    const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = knob.enabled;

    const valInput = el('input', {
      type: 'number',
      value: String(knob.value),
      ...inputAttrs,
    }) as HTMLInputElement;
    valInput.disabled = !knob.enabled;

    cb.addEventListener('change', () => {
      setNoiseConfig(knobKey, { enabled: cb.checked });
      valInput.disabled = !cb.checked;
      document.dispatchEvent(new CustomEvent(SETTINGS_CHANGE));
    });

    valInput.addEventListener('change', () => {
      const v = parseFloat(valInput.value);
      if (Number.isFinite(v) && validate(v)) {
        setNoiseConfig(knobKey, { value: v });
        document.dispatchEvent(new CustomEvent(SETTINGS_CHANGE));
      }
    });

    row.append(cb);
    row.append(el('label', { title: tooltip }, label));
    row.append(valInput);
    return row;
  }

  noiseBody.append(buildKnobRow('pct', 'Delta % below', 'Tests where the absolute percentage change is within this threshold are considered noise.', { min: '0', step: '0.1' }, v => v >= 0));
  noiseBody.append(buildKnobRow('pval', 'P-value above', 'Welch\u2019s t-test on raw samples from both sides. Tests with p-value above the threshold are considered noise (the difference is not statistically significant). Requires at least 2 samples per side.', { min: '0', max: '1', step: '0.01' }, v => v >= 0 && v <= 1));
  noiseBody.append(buildKnobRow('floor', 'Absolute below', 'Tests where both sides\u2019 aggregated values are below this floor are considered noise. Useful for filtering out measurements too small to be meaningful.', { min: '0', step: 'any' }, v => v >= 0));

  noisePanel.append(noiseBody);
  globalRow.append(noisePanel);

  // Test filter
  const filterGroup = el('div', { class: 'control-group' });
  filterGroup.append(el('label', {}, 'Filter tests'));
  const filterInput = el('input', {
    type: 'text',
    class: 'test-filter-input',
    placeholder: 'Filter tests...',
    value: getState().testFilter,
  });
  const doFilter = debounce(() => {
    setState({ testFilter: filterInput.value });
    document.dispatchEvent(new CustomEvent(TEST_FILTER_CHANGE));
  }, 200);
  filterInput.addEventListener('input', () => {
    updateFilterValidation(filterInput);
    doFilter();
  });
  filterGroup.append(filterInput);
  globalRow.append(filterGroup);

  panel.append(globalRow);

  root.append(panel);

  // Populate runs section (shows appropriate hint or loads runs)
  createRunsPanel('a', runsContainers['a'], setSideA);
  createRunsPanel('b', runsContainers['b'], setSideB);
}
