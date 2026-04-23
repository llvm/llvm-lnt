// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockMachineComboHandle = { destroy: vi.fn(), clear: vi.fn() };
vi.mock('../../../components/machine-combobox', () => ({
  renderMachineCombobox: vi.fn(() => mockMachineComboHandle),
}));

const mockCommitPickerHandle = {
  element: document.createElement('div'),
  input: document.createElement('input'),
  destroy: vi.fn(),
};
vi.mock('../../../combobox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../combobox')>();
  return {
    ...actual,
    createCommitPicker: vi.fn(() => mockCommitPickerHandle),
  };
});

import { createBaselinePanel, type BaselinePanelCallbacks } from '../../../pages/graph/baselines';
import { renderMachineCombobox } from '../../../components/machine-combobox';
import { createCommitPicker } from '../../../combobox';
import type { BaselineRef } from '../../../pages/graph/state';

function makeBaseline(suite = 'nts', machine = 'm1', commit = 'abc'): BaselineRef {
  return { suite, machine, commit };
}

function makeCallbacks(overrides?: Partial<BaselinePanelCallbacks>): BaselinePanelCallbacks {
  return {
    onBaselineAdd: vi.fn(),
    onBaselineRemove: vi.fn(),
    getCommitFields: vi.fn(() => []),
    getBaselineCommits: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('createBaselinePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCommitPickerHandle.input = document.createElement('input');
    mockCommitPickerHandle.element = document.createElement('div');
  });

  // ---- DOM structure and initial state ----

  it('renders panel with label, add button visible, and form hidden', () => {
    const handle = createBaselinePanel([], new Map(), ['nts'], makeCallbacks());
    const panel = handle.getElement();

    expect(panel.classList.contains('baseline-panel')).toBe(true);
    expect(panel.querySelector('label')?.textContent).toBe('Baselines');

    const addBtn = panel.querySelector('.baseline-add-btn') as HTMLElement;
    expect(addBtn).not.toBeNull();
    expect(addBtn.style.display).not.toBe('none');

    const form = panel.querySelector('.baseline-form') as HTMLElement;
    expect(form).not.toBeNull();
    expect(form.style.display).toBe('none');
  });

  it('renders initial baseline chips with display values from displayMap', () => {
    const bl = makeBaseline('nts', 'm1', 'abc');
    const displayMap = new Map([['abc', 'v1.0']]);
    const handle = createBaselinePanel([bl], displayMap, ['nts'], makeCallbacks());
    const panel = handle.getElement();

    const chips = panel.querySelectorAll('.baseline-chip');
    expect(chips.length).toBe(1);
    expect(chips[0].textContent).toContain('nts/m1/v1.0');
  });

  it('renders suite dropdown inside form with all suites', () => {
    const handle = createBaselinePanel([], new Map(), ['nts', 'other'], makeCallbacks());
    const panel = handle.getElement();

    // Show the form
    (panel.querySelector('.baseline-add-btn') as HTMLElement).click();

    const suiteSelect = panel.querySelector('.suite-select') as HTMLSelectElement;
    expect(suiteSelect).not.toBeNull();
    const values = [...suiteSelect.options].map(o => o.value);
    expect(values).toContain('');
    expect(values).toContain('nts');
    expect(values).toContain('other');
  });

  // ---- Add button toggle ----

  it('clicking add button shows form and hides the button', () => {
    const handle = createBaselinePanel([], new Map(), ['nts'], makeCallbacks());
    const panel = handle.getElement();

    const addBtn = panel.querySelector('.baseline-add-btn') as HTMLElement;
    const form = panel.querySelector('.baseline-form') as HTMLElement;
    addBtn.click();

    expect(form.style.display).toBe('');
    expect(addBtn.style.display).toBe('none');
  });

  // ---- Cascading dropdowns ----

  it('suite change creates machine combobox for selected suite', () => {
    const handle = createBaselinePanel([], new Map(), ['nts', 'other'], makeCallbacks());
    const panel = handle.getElement();

    // Show form and select suite
    (panel.querySelector('.baseline-add-btn') as HTMLElement).click();
    const suiteSelect = panel.querySelector('.suite-select') as HTMLSelectElement;
    suiteSelect.value = 'nts';
    suiteSelect.dispatchEvent(new Event('change'));

    expect(renderMachineCombobox).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ testsuite: 'nts' }),
    );
  });

  it('suite change to empty clears machine combobox and commit picker', () => {
    const handle = createBaselinePanel([], new Map(), ['nts'], makeCallbacks());
    const panel = handle.getElement();

    // Show form, select suite to create machine combobox
    (panel.querySelector('.baseline-add-btn') as HTMLElement).click();
    const suiteSelect = panel.querySelector('.suite-select') as HTMLSelectElement;
    suiteSelect.value = 'nts';
    suiteSelect.dispatchEvent(new Event('change'));
    expect(renderMachineCombobox).toHaveBeenCalledTimes(1);

    // Change suite to empty
    mockMachineComboHandle.destroy.mockClear();
    suiteSelect.value = '';
    suiteSelect.dispatchEvent(new Event('change'));
    expect(mockMachineComboHandle.destroy).toHaveBeenCalled();
  });

  it('machine selection triggers loadCommits and creates commit picker', async () => {
    const commits = [
      { commit: 'abc', ordinal: 1, tag: null, fields: {} },
      { commit: 'def', ordinal: 2, tag: null, fields: {} },
    ];
    const callbacks = makeCallbacks({
      getBaselineCommits: vi.fn().mockResolvedValue(commits),
    });
    const handle = createBaselinePanel([], new Map(), ['nts'], callbacks);
    const panel = handle.getElement();

    // Show form, select suite
    (panel.querySelector('.baseline-add-btn') as HTMLElement).click();
    const suiteSelect = panel.querySelector('.suite-select') as HTMLSelectElement;
    suiteSelect.value = 'nts';
    suiteSelect.dispatchEvent(new Event('change'));

    // Capture and trigger machine onSelect
    const machineCall = vi.mocked(renderMachineCombobox).mock.calls[0];
    machineCall[1].onSelect('m1');

    await vi.waitFor(() => {
      expect(createCommitPicker).toHaveBeenCalled();
    });

    expect(callbacks.getBaselineCommits).toHaveBeenCalledWith('nts', 'm1', expect.any(AbortSignal));
  });

  it('changing machine aborts previous commit fetch and starts new one', async () => {
    const deferred1 = new Promise<unknown[]>(() => {});

    const callbacks = makeCallbacks({
      getBaselineCommits: vi.fn()
        .mockReturnValueOnce(deferred1)
        .mockResolvedValueOnce([{ commit: 'xyz', ordinal: 1, tag: null, fields: {} }]),
    });
    const handle = createBaselinePanel([], new Map(), ['nts'], callbacks);
    const panel = handle.getElement();

    (panel.querySelector('.baseline-add-btn') as HTMLElement).click();
    const suiteSelect = panel.querySelector('.suite-select') as HTMLSelectElement;
    suiteSelect.value = 'nts';
    suiteSelect.dispatchEvent(new Event('change'));

    // First machine selection (will block on deferred1)
    const machineCall1 = vi.mocked(renderMachineCombobox).mock.calls[0];
    machineCall1[1].onSelect('m1');

    // Capture the signal from the first call
    const firstSignal = (callbacks.getBaselineCommits as ReturnType<typeof vi.fn>).mock.calls[0][2] as AbortSignal;

    // Destroy and recreate for second machine (suite change triggers clearMachine)
    // In practice, the loadCommits function aborts the previous fetch before starting
    // a new one when onSelect is called again. But the machine combobox is recreated
    // on suite change, not on successive machine selections. The abort happens inside
    // loadCommits which is called on each machine select.
    machineCall1[1].onSelect('m2');

    // First signal should be aborted
    expect(firstSignal.aborted).toBe(true);

    // Let the second call complete
    await vi.waitFor(() => {
      expect(createCommitPicker).toHaveBeenCalled();
    });
  });

  it('commit selection calls onBaselineAdd and resets picker input', async () => {
    const commits = [{ commit: 'abc', ordinal: 1, tag: null, fields: {} }];
    const callbacks = makeCallbacks({
      getBaselineCommits: vi.fn().mockResolvedValue(commits),
    });
    const handle = createBaselinePanel([], new Map(), ['nts'], callbacks);
    const panel = handle.getElement();

    // Set up cascading: show form -> select suite -> select machine
    (panel.querySelector('.baseline-add-btn') as HTMLElement).click();
    const suiteSelect = panel.querySelector('.suite-select') as HTMLSelectElement;
    suiteSelect.value = 'nts';
    suiteSelect.dispatchEvent(new Event('change'));

    const machineCall = vi.mocked(renderMachineCombobox).mock.calls[0];
    machineCall[1].onSelect('m1');

    await vi.waitFor(() => {
      expect(createCommitPicker).toHaveBeenCalled();
    });

    // Capture and trigger commit onSelect
    const pickerOpts = vi.mocked(createCommitPicker).mock.calls[0][0];
    mockCommitPickerHandle.input.value = 'abc';
    pickerOpts.onSelect('abc');

    expect(callbacks.onBaselineAdd).toHaveBeenCalledWith({
      suite: 'nts',
      machine: 'm1',
      commit: 'abc',
    });
    expect(mockCommitPickerHandle.input.value).toBe('');
  });

  // ---- Error handling ----

  it('loadCommits shows error text when getBaselineCommits rejects', async () => {
    const callbacks = makeCallbacks({
      getBaselineCommits: vi.fn().mockRejectedValue(new Error('Network fail')),
    });
    const handle = createBaselinePanel([], new Map(), ['nts'], callbacks);
    const panel = handle.getElement();

    (panel.querySelector('.baseline-add-btn') as HTMLElement).click();
    const suiteSelect = panel.querySelector('.suite-select') as HTMLSelectElement;
    suiteSelect.value = 'nts';
    suiteSelect.dispatchEvent(new Event('change'));

    const machineCall = vi.mocked(renderMachineCombobox).mock.calls[0];
    machineCall[1].onSelect('m1');

    await vi.waitFor(() => {
      const errorEl = panel.querySelector('.error-text');
      expect(errorEl).not.toBeNull();
      expect(errorEl!.textContent).toBe('Failed to load commits');
    });
  });

  it('loadCommits silently ignores AbortError', async () => {
    const callbacks = makeCallbacks({
      getBaselineCommits: vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')),
    });
    const handle = createBaselinePanel([], new Map(), ['nts'], callbacks);
    const panel = handle.getElement();

    (panel.querySelector('.baseline-add-btn') as HTMLElement).click();
    const suiteSelect = panel.querySelector('.suite-select') as HTMLSelectElement;
    suiteSelect.value = 'nts';
    suiteSelect.dispatchEvent(new Event('change'));

    const machineCall = vi.mocked(renderMachineCombobox).mock.calls[0];
    machineCall[1].onSelect('m1');

    // Give the async rejection time to propagate
    await vi.waitFor(() => {
      expect(callbacks.getBaselineCommits).toHaveBeenCalled();
    });

    expect(panel.querySelector('.error-text')).toBeNull();
  });

  // ---- Chip management ----

  it('chip remove button calls onBaselineRemove', () => {
    const bl1 = makeBaseline('nts', 'm1', 'abc');
    const bl2 = makeBaseline('nts', 'm2', 'def');
    const callbacks = makeCallbacks();
    const handle = createBaselinePanel([bl1, bl2], new Map(), ['nts'], callbacks);
    const panel = handle.getElement();

    const removeButtons = panel.querySelectorAll('.chip-remove');
    expect(removeButtons.length).toBe(2);
    (removeButtons[0] as HTMLButtonElement).click();
    expect(callbacks.onBaselineRemove).toHaveBeenCalledWith(bl1);
  });

  it('updateChips replaces chips with new baselines and display values', () => {
    const handle = createBaselinePanel([], new Map(), ['nts'], makeCallbacks());
    const panel = handle.getElement();
    expect(panel.querySelectorAll('.baseline-chip').length).toBe(0);

    const bl = makeBaseline('nts', 'm1', 'abc');
    handle.updateChips([bl], new Map([['abc', 'v2.0']]));

    const chips = panel.querySelectorAll('.baseline-chip');
    expect(chips.length).toBe(1);
    expect(chips[0].textContent).toContain('nts/m1/v2.0');
  });

  // ---- Handle methods ----

  it('reset hides form, shows add button, clears state, aborts fetch', async () => {
    const blockingPromise = new Promise<unknown[]>(() => {});

    const callbacks = makeCallbacks({
      getBaselineCommits: vi.fn().mockReturnValue(blockingPromise),
    });
    const handle = createBaselinePanel([], new Map(), ['nts'], callbacks);
    const panel = handle.getElement();

    // Show form, select suite, select machine (starts pending fetch)
    (panel.querySelector('.baseline-add-btn') as HTMLElement).click();
    const suiteSelect = panel.querySelector('.suite-select') as HTMLSelectElement;
    suiteSelect.value = 'nts';
    suiteSelect.dispatchEvent(new Event('change'));
    const machineCall = vi.mocked(renderMachineCombobox).mock.calls[0];
    machineCall[1].onSelect('m1');

    // Capture abort signal before reset
    const signal = (callbacks.getBaselineCommits as ReturnType<typeof vi.fn>).mock.calls[0][2] as AbortSignal;

    handle.reset();

    const form = panel.querySelector('.baseline-form') as HTMLElement;
    const addBtn = panel.querySelector('.baseline-add-btn') as HTMLElement;
    expect(form.style.display).toBe('none');
    expect(addBtn.style.display).toBe('');
    expect(suiteSelect.value).toBe('');
    expect(signal.aborted).toBe(true);
    expect(mockMachineComboHandle.destroy).toHaveBeenCalled();
  });

  it('destroy cleans up machine handle, commit picker, and abort controller', async () => {
    const commits = [{ commit: 'abc', ordinal: 1, tag: null, fields: {} }];
    const callbacks = makeCallbacks({
      getBaselineCommits: vi.fn().mockResolvedValue(commits),
    });
    const handle = createBaselinePanel([], new Map(), ['nts'], callbacks);
    const panel = handle.getElement();

    // Set up all sub-components
    (panel.querySelector('.baseline-add-btn') as HTMLElement).click();
    const suiteSelect = panel.querySelector('.suite-select') as HTMLSelectElement;
    suiteSelect.value = 'nts';
    suiteSelect.dispatchEvent(new Event('change'));
    const machineCall = vi.mocked(renderMachineCombobox).mock.calls[0];
    machineCall[1].onSelect('m1');

    await vi.waitFor(() => {
      expect(createCommitPicker).toHaveBeenCalled();
    });

    mockMachineComboHandle.destroy.mockClear();
    mockCommitPickerHandle.destroy.mockClear();

    handle.destroy();
    expect(mockMachineComboHandle.destroy).toHaveBeenCalled();
    expect(mockCommitPickerHandle.destroy).toHaveBeenCalled();
  });

  it('destroy is safe when no sub-components exist', () => {
    const handle = createBaselinePanel([], new Map(), ['nts'], makeCallbacks());
    expect(() => handle.destroy()).not.toThrow();
  });
});
