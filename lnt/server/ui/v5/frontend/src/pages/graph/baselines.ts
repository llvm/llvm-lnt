// pages/graph/baselines.ts — Baseline panel with cascading suite→machine→commit
// dropdowns and removable baseline chips.

import { el } from '../../utils';
import type { CommitSummary } from '../../types';
import { renderMachineCombobox } from '../../components/machine-combobox';
import { createCommitPicker, type CommitPickerHandle } from '../../combobox';
import { commitDisplayValue } from '../../utils';
import type { BaselineRef } from './state';

// ---- Types ----

export interface BaselinePanelHandle {
  /** Re-render baseline chips with display values. */
  updateChips(baselines: BaselineRef[], displayMap: Map<string, string>): void;
  /** Reset the panel (on suite change): collapse, clear cascading selections. */
  reset(): void;
  /** The panel DOM element. */
  getElement(): HTMLElement;
  /** Destroy sub-component handles. */
  destroy(): void;
}

export interface BaselinePanelCallbacks {
  onBaselineAdd(baseline: BaselineRef): void;
  onBaselineRemove(baseline: BaselineRef): void;
  getCommitFields(suite: string): Array<{ name: string; display?: boolean }>;
  getBaselineCommits(suite: string, machine: string, signal?: AbortSignal): Promise<CommitSummary[]>;
}

// ---- Implementation ----

export function createBaselinePanel(
  baselines: BaselineRef[],
  displayMap: Map<string, string>,
  suites: string[],
  callbacks: BaselinePanelCallbacks,
): BaselinePanelHandle {
  const panel = el('div', { class: 'baseline-panel control-group' });

  panel.append(el('label', {}, 'Baselines'));

  // "Add baseline" button (hidden when form is shown)
  const addBtn = el('button', { type: 'button', class: 'baseline-add-btn' }, '+ Add baseline');
  panel.append(addBtn);

  // Expandable form — bare selects in a horizontal flex row (no per-field labels)
  const form = el('div', { class: 'baseline-form', style: 'display: none' });
  panel.append(form);

  // Chips container (after form, so chips appear below)
  const chipsContainer = el('div', { class: 'baseline-chips' });
  panel.append(chipsContainer);

  addBtn.addEventListener('click', () => {
    form.style.display = '';
    addBtn.style.display = 'none';
  });

  // Internal state for cascading dropdowns
  let selectedSuite = '';
  let selectedMachine = '';
  let machineHandle: { destroy: () => void; clear: () => void } | null = null;
  let commitPicker: CommitPickerHandle | null = null;
  let abortCtrl: AbortController | null = null;
  let cachedCommitValues: string[] = [];
  let cachedCommitDisplayMap: Map<string, string> = new Map();

  // Suite selector (bare, no label — inside horizontal form row)
  const suiteSelect = el('select', { class: 'suite-select' }) as HTMLSelectElement;
  suiteSelect.append(el('option', { value: '' }, '-- Suite --'));
  for (const s of suites) {
    suiteSelect.append(el('option', { value: s }, s));
  }
  form.append(suiteSelect);

  // Machine combobox container (bare)
  const machineContainer = el('div', {});
  form.append(machineContainer);

  // Commit picker container (bare)
  const commitContainer = el('div', {});
  form.append(commitContainer);

  function clearCommitPicker(): void {
    if (commitPicker) { commitPicker.destroy(); commitPicker = null; }
    commitContainer.replaceChildren();
    cachedCommitValues = [];
    cachedCommitDisplayMap = new Map();
  }

  function clearMachine(): void {
    if (machineHandle) { machineHandle.destroy(); machineHandle = null; }
    machineContainer.replaceChildren();
    selectedMachine = '';
    clearCommitPicker();
  }

  function createMachineCombo(suite: string): void {
    clearMachine();
    if (!suite) return;
    machineHandle = renderMachineCombobox(machineContainer, {
      testsuite: suite,
      onSelect(name: string) {
        selectedMachine = name;
        loadCommits(suite, name);
      },
    });
  }

  async function loadCommits(suite: string, machine: string): Promise<void> {
    clearCommitPicker();
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();

    try {
      const commits = await callbacks.getBaselineCommits(suite, machine, abortCtrl.signal);
      const commitFields = callbacks.getCommitFields(suite);
      cachedCommitValues = commits.map(c => c.commit);
      cachedCommitDisplayMap = new Map();
      for (const c of commits) {
        const display = commitDisplayValue(c, commitFields);
        if (display !== c.commit) cachedCommitDisplayMap.set(c.commit, display);
      }

      commitPicker = createCommitPicker({
        id: 'baseline-commit',
        getCommitData: () => ({
          values: cachedCommitValues,
          displayMap: cachedCommitDisplayMap,
        }),
        onSelect(commit: string) {
          // Auto-add baseline on commit selection
          callbacks.onBaselineAdd({ suite: selectedSuite, machine: selectedMachine, commit });
          // Reset the form for next baseline
          if (commitPicker) { commitPicker.input.value = ''; }
        },
        placeholder: 'Select commit...',
      });
      commitContainer.append(commitPicker.element);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      commitContainer.replaceChildren(el('span', { class: 'error-text' }, 'Failed to load commits'));
    }
  }

  suiteSelect.addEventListener('change', () => {
    selectedSuite = suiteSelect.value;
    createMachineCombo(selectedSuite);
  });

  // --- Chips rendering ---

  function renderChips(bls: BaselineRef[], dm: Map<string, string>): void {
    chipsContainer.replaceChildren();
    for (const bl of bls) {
      const commitDisplay = dm.get(bl.commit) ?? bl.commit;
      const label = `${bl.suite}/${bl.machine}/${commitDisplay}`;

      const chip = el('span', { class: 'baseline-chip' });
      chip.append(el('span', {}, label));
      const removeBtn = el('button', {
        type: 'button',
        class: 'chip-remove',
        'aria-label': `Remove baseline ${label}`,
      }, '×');
      removeBtn.addEventListener('click', () => callbacks.onBaselineRemove(bl));
      chip.append(removeBtn);
      chipsContainer.append(chip);
    }
  }

  renderChips(baselines, displayMap);

  return {
    updateChips(bls: BaselineRef[], dm: Map<string, string>): void {
      renderChips(bls, dm);
    },

    reset(): void {
      form.style.display = 'none';
      addBtn.style.display = '';
      suiteSelect.value = '';
      selectedSuite = '';
      clearMachine();
      if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }
    },

    getElement(): HTMLElement {
      return panel;
    },

    destroy(): void {
      if (machineHandle) machineHandle.destroy();
      if (commitPicker) commitPicker.destroy();
      if (abortCtrl) abortCtrl.abort();
    },
  };
}
