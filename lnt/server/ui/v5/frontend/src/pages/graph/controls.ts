// pages/graph/controls.ts — Control panel for the Graph page.
// Suite dropdown, machine chip input, metric selector, test filter,
// aggregation dropdowns, regression toggle.

import { el, debounce } from '../../utils';
import type { FieldInfo, AggFn } from '../../types';
import { renderMachineCombobox } from '../../components/machine-combobox';
import { filterMetricFields, renderMetricSelector, renderEmptyMetricSelector } from '../../components/metric-selector';
import type { GraphState, RegressionAnnotationMode } from './state';
import { assignSymbolChar } from './traces';

// ---- Types ----

export interface ControlsHandle {
  /** Replace the metric selector with new fields. */
  updateMetricSelector(fields: FieldInfo[], currentMetric: string): void;
  /** Re-render machine chips (after add/remove). */
  updateMachineChips(machines: string[]): void;
  /** Enable or disable all controls (disabled when no suite). */
  setEnabled(enabled: boolean): void;
  /** Update the machine combobox for a new suite. */
  setSuite(suite: string): void;
  /** Programmatically set the regression mode dropdown (does NOT fire callback). */
  setRegressionMode(mode: RegressionAnnotationMode): void;
  /** Embed an element (e.g. baseline panel) at the end of the first controls row. */
  embedInRow1(element: HTMLElement): void;
  /** The controls panel DOM element. */
  getElement(): HTMLElement;
  /** Destroy all sub-component handles. */
  destroy(): void;
}

export interface ControlsCallbacks {
  onSuiteChange(suite: string): void;
  onMachineAdd(name: string): void;
  onMachineRemove(name: string): void;
  onMetricChange(metric: string): void;
  onFilterChange(filter: string): void;
  onRunAggChange(agg: AggFn): void;
  onSampleAggChange(agg: AggFn): void;
  onRegressionModeChange(mode: RegressionAnnotationMode): void;
}

// ---- Helpers ----

function createAggSelect(label: string, current: AggFn, onChange: (agg: AggFn) => void): HTMLElement {
  const group = el('div', { class: 'control-group' });
  group.append(el('label', {}, label));
  const select = el('select', {}) as HTMLSelectElement;
  for (const opt of ['median', 'mean', 'min', 'max'] as AggFn[]) {
    const option = el('option', { value: opt }, opt);
    if (opt === current) (option as HTMLOptionElement).selected = true;
    select.append(option);
  }
  select.addEventListener('change', () => onChange(select.value as AggFn));
  group.append(select);
  return group;
}

function createRegressionToggle(current: RegressionAnnotationMode, onChange: (mode: RegressionAnnotationMode) => void): { element: HTMLElement; select: HTMLSelectElement } {
  const group = el('div', { class: 'control-group' });
  group.append(el('label', {}, 'Regressions'));
  const select = el('select', { class: 'metric-select' }) as HTMLSelectElement;
  for (const [value, label] of [['off', 'Off'], ['active', 'Active'], ['all', 'All']] as const) {
    const option = el('option', { value }, label);
    if (value === current) (option as HTMLOptionElement).selected = true;
    select.append(option);
  }
  select.addEventListener('change', () => onChange(select.value as RegressionAnnotationMode));
  group.append(select);
  return { element: group, select };
}

// ---- Main export ----

export function createControls(
  state: GraphState,
  suites: string[],
  callbacks: ControlsCallbacks,
): ControlsHandle {
  const panel = el('div', { class: 'controls-panel' });

  // Row 1: Suite + Machine combobox + Machine chips
  const row1 = el('div', { class: 'controls-row controls-row-top' });

  // Suite selector
  const suiteGroup = el('div', { class: 'control-group' });
  suiteGroup.append(el('label', {}, 'Suite'));
  const suiteSelect = el('select', { class: 'suite-select' }) as HTMLSelectElement;
  suiteSelect.append(el('option', { value: '' }, '-- Select suite --'));
  for (const s of suites) {
    const opt = el('option', { value: s }, s);
    if (s === state.suite) (opt as HTMLOptionElement).selected = true;
    suiteSelect.append(opt);
  }
  suiteSelect.addEventListener('change', () => callbacks.onSuiteChange(suiteSelect.value));
  suiteGroup.append(suiteSelect);
  row1.append(suiteGroup);

  // Machine combobox
  const machineGroup = el('div', { class: 'control-group machine-control' });
  machineGroup.append(el('label', {}, 'Machines'));
  const machineComboContainer = el('div', {});
  const chipsContainer = el('div', { class: 'machine-chips' });
  machineGroup.append(machineComboContainer, chipsContainer);
  row1.append(machineGroup);

  panel.append(row1);

  // Row 2: Metric + Aggregation + Filter + Regressions
  const row2 = el('div', { class: 'controls-row' });

  // Metric selector placeholder
  const metricContainer = el('div', { class: 'metric-container' });
  renderEmptyMetricSelector(metricContainer);
  row2.append(metricContainer);

  // Aggregation selectors
  row2.append(createAggSelect('Run aggregation', state.runAgg, callbacks.onRunAggChange));
  row2.append(createAggSelect('Sample aggregation', state.sampleAgg, callbacks.onSampleAggChange));

  // Test filter
  const filterGroup = el('div', { class: 'control-group' });
  filterGroup.append(el('label', {}, 'Filter tests'));
  const filterInput = el('input', {
    type: 'text',
    class: 'test-filter-input',
    placeholder: 'Filter tests...',
    value: state.testFilter,
  }) as HTMLInputElement;
  const debouncedFilter = debounce(() => callbacks.onFilterChange(filterInput.value), 200);
  filterInput.addEventListener('input', debouncedFilter);
  filterGroup.append(filterInput);
  row2.append(filterGroup);

  // Regression toggle
  const regressionToggle = createRegressionToggle(state.regressionMode, callbacks.onRegressionModeChange);
  row2.append(regressionToggle.element);

  panel.append(row2);

  // --- Machine combobox handle ---
  let machineComboHandle: { destroy: () => void; clear: () => void } | null = null;

  function createMachineCombo(suite: string): void {
    if (machineComboHandle) {
      machineComboHandle.destroy();
      machineComboHandle = null;
    }
    machineComboContainer.replaceChildren();
    machineComboHandle = renderMachineCombobox(machineComboContainer, {
      testsuite: suite,
      onSelect(name: string) {
        callbacks.onMachineAdd(name);
        machineComboHandle?.clear();
      },
    });
  }

  createMachineCombo(state.suite);

  // --- Machine chips rendering ---

  function renderChips(machines: string[]): void {
    chipsContainer.replaceChildren();
    for (let i = 0; i < machines.length; i++) {
      const m = machines[i];
      const chip = el('span', { class: 'machine-chip' });
      const symbolSpan = el('span', { class: 'chip-symbol' }, assignSymbolChar(i));
      const nameSpan = el('span', {}, m);
      const removeBtn = el('button', {
        type: 'button',
        class: 'chip-remove',
        'aria-label': `Remove ${m}`,
      }, '×');
      removeBtn.addEventListener('click', () => callbacks.onMachineRemove(m));
      chip.append(symbolSpan, nameSpan, removeBtn);
      chipsContainer.append(chip);
    }
  }

  renderChips(state.machines);

  // --- Enable/disable ---

  function setEnabled(enabled: boolean): void {
    const inputs = panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select');
    for (const inp of inputs) {
      if (inp === suiteSelect) continue; // suite selector always enabled
      inp.disabled = !enabled;
    }
  }

  if (!state.suite) setEnabled(false);

  return {
    updateMetricSelector(fields: FieldInfo[], currentMetric: string): void {
      metricContainer.replaceChildren();
      const metricFields = filterMetricFields(fields);
      if (metricFields.length > 0) {
        renderMetricSelector(metricContainer, metricFields, callbacks.onMetricChange, currentMetric, { placeholder: true });
      } else {
        renderEmptyMetricSelector(metricContainer);
      }
    },

    updateMachineChips(machines: string[]): void {
      renderChips(machines);
    },

    setEnabled,

    setSuite(suite: string): void {
      createMachineCombo(suite);
      setEnabled(!!suite);
    },

    setRegressionMode(mode: RegressionAnnotationMode): void {
      regressionToggle.select.value = mode;
    },

    embedInRow1(element: HTMLElement): void {
      row1.append(element);
    },

    getElement(): HTMLElement {
      return panel;
    },

    destroy(): void {
      if (machineComboHandle) machineComboHandle.destroy();
    },
  };
}
