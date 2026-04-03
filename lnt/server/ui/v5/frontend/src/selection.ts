import type { AggFn, FieldInfo, OrderSummary, SideSelection } from './types';
import { SETTINGS_CHANGE, TEST_FILTER_CHANGE } from './events';
import { getRuns } from './api';
import { getState, setSideA, setSideB, setState, swapSides } from './state';
import { debounce, el } from './utils';
import {
  createOrderCombobox, createMachineCombobox, resetComboboxState,
  type ComboboxContext,
} from './combobox';
import { renderMetricSelector, filterMetricFields } from './components/metric-selector';

// Cached data
let cachedOrders: OrderSummary[] = [];
let cachedOrderValues: string[] = [];  // primary order values, computed once
let cachedFields: FieldInfo[] = [];
let testsuite = '';
let onCompare: (() => void) | null = null;

// Staleness counters for createRunsPanel — prevents earlier async calls
// from overwriting the DOM when a newer call has been issued.
let runsPanelVersionA = 0;
let runsPanelVersionB = 0;

export function setCachedData(
  orders: OrderSummary[],
  fields: FieldInfo[],
  ts: string,
  compareFn?: () => void,
): void {
  cachedOrders = orders;
  cachedFields = fields;
  testsuite = ts;
  if (compareFn) onCompare = compareFn;

  // Pre-compute primary order values
  cachedOrderValues = [];
  for (const o of cachedOrders) {
    const keys = Object.keys(o.fields);
    if (keys.length > 0) {
      cachedOrderValues.push(o.fields[keys[0]]);
    }
  }
}

export function getMetricFields(): FieldInfo[] {
  return filterMetricFields(cachedFields);
}

function getSideState(side: 'a' | 'b') {
  const state = getState();
  return {
    selection: side === 'a' ? state.sideA : state.sideB,
    setSide: side === 'a' ? setSideA : setSideB,
    label: side === 'a' ? 'Side A (Baseline)' : 'Side B (New)',
  };
}

function getComboboxContext(): ComboboxContext {
  const orderTags = new Map<string, string | null>();
  for (const o of cachedOrders) {
    const keys = Object.keys(o.fields);
    if (keys.length > 0) {
      orderTags.set(o.fields[keys[0]], o.tag ?? null);
    }
  }
  return {
    cachedOrderValues,
    orderTags,
    testsuite,
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

  container.replaceChildren(el('span', { class: 'runs-hint' }, 'Select order and machine first'));

  const { selection: sideState } = getSideState(side);

  if (!sideState.order || !sideState.machine) return;

  container.replaceChildren(el('span', { class: 'runs-loading' }, 'Loading runs...'));

  getRuns(testsuite, { machine: sideState.machine, order: sideState.order })
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
          ' ',
          el('span', { class: 'run-uuid' }, `UUID ${run.uuid.slice(0, 8)}`),
        );
        container.append(el('div', { class: 'run-row' }, cb, label));

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

// Main render
export function renderSelectionPanel(root: HTMLElement): void {
  root.replaceChildren();
  resetComboboxState();

  const panel = el('div', { class: 'controls-panel' });

  // Side A and B
  const sidesRow = el('div', { class: 'sides-row' });
  const runsContainers: Record<string, HTMLElement> = {};
  const ctx = getComboboxContext();
  const sideDivs: HTMLElement[] = [];

  for (const side of ['a', 'b'] as const) {
    const { setSide, label } = getSideState(side);

    const sideDiv = el('div', { class: `side side-${side}` });
    sideDiv.append(el('h3', {}, label));

    const runsContainer = el('div', { class: 'runs-container' });
    runsContainers[side] = runsContainer;

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
    renderSelectionPanel(root);
    tryAutoCompare();
  });

  sidesRow.append(sideDivs[0], swapBtn, sideDivs[1]);
  panel.append(sidesRow);

  // Global controls
  const globalRow = el('div', { class: 'global-controls' });

  renderMetricSelector(globalRow, getMetricFields(), (metric) => {
    setState({ metric });
    tryAutoCompare();
  }, getState().metric, { placeholder: true });

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

  // Trigger initial runs load if state has order+machine (use stored references)
  const state = getState();
  if (state.sideA.order && state.sideA.machine) {
    createRunsPanel('a', runsContainers['a'], setSideA);
  }
  if (state.sideB.order && state.sideB.machine) {
    createRunsPanel('b', runsContainers['b'], setSideB);
  }
}
