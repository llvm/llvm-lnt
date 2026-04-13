import type { AggFn, FieldInfo, OrderSummary, SideSelection } from './types';
import { SETTINGS_CHANGE, TEST_FILTER_CHANGE } from './events';
import { getFields, getOrders, getRuns } from './api';
import { getBasePath } from './router';
import { getState, setSideA, setSideB, setState, swapSides } from './state';
import { debounce, el } from './utils';
import {
  createOrderCombobox, createMachineCombobox, resetComboboxState,
  type ComboboxContext,
} from './combobox';
import { renderMetricSelector, renderEmptyMetricSelector, filterMetricFields } from './components/metric-selector';

// Per-side cached data
let cachedOrdersA: OrderSummary[] = [];
let cachedOrdersB: OrderSummary[] = [];
let cachedFieldsA: FieldInfo[] = [];
let cachedFieldsB: FieldInfo[] = [];
let testsuites: string[] = [];
let onCompare: (() => void) | null = null;

// Staleness counters for createRunsPanel — prevents earlier async calls
// from overwriting the DOM when a newer call has been issued.
let runsPanelVersionA = 0;
let runsPanelVersionB = 0;

// Per-side suite data loading version counters — prevents stale fetches
// from overwriting data when the suite changes rapidly.
let suiteLoadVersionA = 0;
let suiteLoadVersionB = 0;

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
  cachedOrdersA = [];
  cachedOrdersB = [];
  cachedFieldsA = [];
  cachedFieldsB = [];
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

function getOrderDataForSide(side: 'a' | 'b') {
  const orders = side === 'a' ? cachedOrdersA : cachedOrdersB;
  const cachedOrderValues: string[] = [];
  const orderTags = new Map<string, string | null>();
  for (const o of orders) {
    const keys = Object.keys(o.fields);
    if (keys.length > 0) {
      const v = o.fields[keys[0]];
      cachedOrderValues.push(v);
      orderTags.set(v, o.tag ?? null);
    }
  }
  return { cachedOrderValues, orderTags };
}

function getComboboxContext(): ComboboxContext {
  return {
    getOrderData: getOrderDataForSide,
    getSuiteName: (side: 'a' | 'b') => {
      const { selection } = getSideState(side);
      return selection.suite;
    },
    getSideState,
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

  if (!sideState.suite || !sideState.order || !sideState.machine) {
    container.replaceChildren(el('span', { class: 'runs-hint' }, 'Select an order first'));
    return;
  }

  container.replaceChildren(el('span', { class: 'runs-loading' }, 'Loading runs...'));

  getRuns(sideState.suite, { machine: sideState.machine, order: sideState.order })
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
          run.start_time ? new Date(run.start_time).toLocaleString() : '(no time)',
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
 * Fetch orders and fields for a side when its suite changes.
 * Updates the per-side cache and re-renders metric selector.
 */
export async function fetchSideData(
  side: 'a' | 'b',
  suite: string,
): Promise<void> {
  const version = side === 'a' ? ++suiteLoadVersionA : ++suiteLoadVersionB;

  try {
    const [fields, orders] = await Promise.all([
      getFields(suite),
      getOrders(suite),
    ]);

    // Check for staleness
    const currentVersion = side === 'a' ? suiteLoadVersionA : suiteLoadVersionB;
    if (version !== currentVersion) return;

    if (side === 'a') {
      cachedFieldsA = fields;
      cachedOrdersA = orders;
    } else {
      cachedFieldsB = fields;
      cachedOrdersB = orders;
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
      setSide({ suite: newSuite, machine: '', order: '', runs: [] });
      if (newSuite) {
        fetchSideData(side, newSuite);
      } else {
        // Clear cached data for this side so metrics/orders don't linger
        if (side === 'a') { cachedFieldsA = []; cachedOrdersA = []; }
        else { cachedFieldsB = []; cachedOrdersB = []; }
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
    sideDiv.append(el('label', {}, 'Order'));
    sideDiv.append(createOrderCombobox(side, setSide, refreshRuns, ctx));

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
    // Also swap per-side caches
    const tmpOrders = cachedOrdersA;
    cachedOrdersA = cachedOrdersB;
    cachedOrdersB = tmpOrders;
    const tmpFields = cachedFieldsA;
    cachedFieldsA = cachedFieldsB;
    cachedFieldsB = tmpFields;
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

  const noiseGroup = el('div', { class: 'control-group' });
  noiseGroup.append(el('label', {}, 'Noise %'));
  const noiseInput = el('input', {
    type: 'number',
    class: 'noise-input',
    value: String(getState().noise),
    min: '0',
    step: '0.1',
  });
  noiseInput.addEventListener('change', () => {
    setState({ noise: parseFloat(noiseInput.value) || 0 });
    document.dispatchEvent(new CustomEvent(SETTINGS_CHANGE));
  });
  noiseGroup.append(noiseInput);
  globalRow.append(noiseGroup);

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
  filterInput.addEventListener('input', () => doFilter());
  filterGroup.append(filterInput);
  globalRow.append(filterGroup);

  panel.append(globalRow);

  root.append(panel);

  // Populate runs section (shows appropriate hint or loads runs)
  createRunsPanel('a', runsContainers['a'], setSideA);
  createRunsPanel('b', runsContainers['b'], setSideB);
}
