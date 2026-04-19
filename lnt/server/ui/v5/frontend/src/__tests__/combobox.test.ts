// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SideSelection } from '../types';

// Mock the API module
vi.mock('../api', () => ({
  getMachines: vi.fn().mockResolvedValue({ items: [] }),
  getMachineRuns: vi.fn().mockResolvedValue({ items: [], cursor: { next: null } }),
  getRuns: vi.fn().mockResolvedValue([]),
}));

import { getMachines, getMachineRuns } from '../api';
import {
  createMachineCombobox, createCommitCombobox, createCommitPicker,
  fetchMachineCommitSet, resetComboboxState, type ComboboxContext,
} from '../combobox';

function makeContext(overrides?: Partial<ComboboxContext>): ComboboxContext {
  const sideA: SideSelection = { suite: '', commit: '', machine: '', runs: [], runAgg: 'median' };
  return {
    getCommitData: () => ({
      cachedCommitValues: ['100', '101', '102'],
    }),
    getSuiteName: () => 'nts',
    getSideState: () => ({
      selection: sideA,
      setSide: (partial: Partial<SideSelection>) => Object.assign(sideA, partial),
      label: 'Side A',
    }),
    ...overrides,
  };
}

describe('createCommitCombobox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetComboboxState();
  });

  it('shows values in dropdown items', () => {
    const ctx = makeContext();
    const wrapper = createCommitCombobox('a', () => {}, () => {}, ctx);
    document.body.append(wrapper);

    const input = wrapper.querySelector('input')!;
    input.dispatchEvent(new Event('focus'));

    const items = wrapper.querySelectorAll('.combobox-item');
    const texts = Array.from(items).map(li => li.textContent);
    expect(texts).toContain('100');
    expect(texts).toContain('101');
    expect(texts).toContain('102');

    wrapper.remove();
  });

  it('filters by commit value substring', () => {
    const ctx = makeContext();
    const wrapper = createCommitCombobox('a', () => {}, () => {}, ctx);
    document.body.append(wrapper);

    const input = wrapper.querySelector('input')! as HTMLInputElement;
    input.value = '102';
    input.dispatchEvent(new Event('input'));

    const items = wrapper.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toBe('102');

    wrapper.remove();
  });

  it('filters by commit value', () => {
    const ctx = makeContext();
    const wrapper = createCommitCombobox('a', () => {}, () => {}, ctx);
    document.body.append(wrapper);

    const input = wrapper.querySelector('input')! as HTMLInputElement;
    input.value = '101';
    input.dispatchEvent(new Event('input'));

    const items = wrapper.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toBe('101');

    wrapper.remove();
  });

  it('shows loading hint when machine is set but commits not loaded', () => {
    const sideA: SideSelection = { suite: '', commit: '', machine: 'clang-x86', runs: [], runAgg: 'median' };
    const ctx = makeContext({
      getSideState: () => ({
        selection: sideA,
        setSide: (partial: Partial<SideSelection>) => Object.assign(sideA, partial),
        label: 'Side A',
      }),
    });
    // machineCommitsA is null (not loaded) — resetComboboxState ensures this
    const wrapper = createCommitCombobox('a', () => {}, () => {}, ctx);
    document.body.append(wrapper);

    const input = wrapper.querySelector('input')!;
    input.dispatchEvent(new Event('focus'));

    const items = wrapper.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toBe('Loading commits...');

    wrapper.remove();
  });

  it('calls setSide with commit value on selection', () => {
    const sideA: SideSelection = { suite: '', commit: '', machine: '', runs: [], runAgg: 'median' };
    const setSide = vi.fn();
    const ctx = makeContext({
      getSideState: () => ({
        selection: sideA,
        setSide,
        label: 'Side A',
      }),
    });
    const wrapper = createCommitCombobox('a', setSide, () => {}, ctx);
    document.body.append(wrapper);

    const input = wrapper.querySelector('input')!;
    input.dispatchEvent(new Event('focus'));

    const items = wrapper.querySelectorAll('.combobox-item');
    // Click the first item "100"
    (items[0] as HTMLElement).click();

    expect(setSide).toHaveBeenCalledWith({ commit: '100' });

    wrapper.remove();
  });

  it('shows value in input after selection', () => {
    const ctx = makeContext();
    const wrapper = createCommitCombobox('a', () => {}, () => {}, ctx);
    document.body.append(wrapper);

    const input = wrapper.querySelector('input')! as HTMLInputElement;
    input.dispatchEvent(new Event('focus'));

    const items = wrapper.querySelectorAll('.combobox-item');
    (items[0] as HTMLElement).click();

    expect(input.value).toBe('100');

    wrapper.remove();
  });

  it('shows value in input on URL restore', () => {
    const sideA: SideSelection = { suite: '', commit: '102', machine: '', runs: [], runAgg: 'median' };
    const ctx = makeContext({
      getSideState: () => ({
        selection: sideA,
        setSide: () => {},
        label: 'Side A',
      }),
    });
    const wrapper = createCommitCombobox('a', () => {}, () => {}, ctx);
    document.body.append(wrapper);

    const input = wrapper.querySelector('input')! as HTMLInputElement;
    expect(input.value).toBe('102');

    wrapper.remove();
  });

  it('shows value in input for existing commit', () => {
    const sideA: SideSelection = { suite: '', commit: '101', machine: '', runs: [], runAgg: 'median' };
    const ctx = makeContext({
      getSideState: () => ({
        selection: sideA,
        setSide: () => {},
        label: 'Side A',
      }),
    });
    const wrapper = createCommitCombobox('a', () => {}, () => {}, ctx);
    document.body.append(wrapper);

    const input = wrapper.querySelector('input')! as HTMLInputElement;
    expect(input.value).toBe('101');

    wrapper.remove();
  });

  it('disables commit input when no machine is selected', () => {
    const sideA: SideSelection = { suite: 'nts', commit: '', machine: '', runs: [], runAgg: 'median' };
    const ctx = makeContext({
      getSideState: () => ({
        selection: sideA,
        setSide: () => {},
        label: 'Side A',
      }),
    });
    const wrapper = createCommitCombobox('a', () => {}, () => {}, ctx);
    document.body.append(wrapper);

    const input = wrapper.querySelector('input')! as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('Select a machine first');

    wrapper.remove();
  });

  it('does not disable commit input when machine is selected', () => {
    const sideA: SideSelection = { suite: 'nts', commit: '', machine: 'clang-x86', runs: [], runAgg: 'median' };
    const ctx = makeContext({
      getSideState: () => ({
        selection: sideA,
        setSide: () => {},
        label: 'Side A',
      }),
    });
    const wrapper = createCommitCombobox('a', () => {}, () => {}, ctx);
    document.body.append(wrapper);

    const input = wrapper.querySelector('input')! as HTMLInputElement;
    expect(input.disabled).toBe(false);

    wrapper.remove();
  });
});
// ---------------------------------------------------------------------------

const COMMIT_VALUES = ['100', '101', '102', '200'];

describe('createCommitPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a combobox wrapper with input and dropdown', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    expect(picker.element.getAttribute('role')).toBe('combobox');
    expect(picker.element.querySelector('input')).toBeTruthy();
    expect(picker.element.querySelector('ul')).toBeTruthy();

    picker.element.remove();
  });

  it('shows all commits on focus', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));

    const items = picker.element.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(4);

    picker.element.remove();
  });

  it('displays values in dropdown items', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));

    const items = picker.element.querySelectorAll('.combobox-item');
    const texts = Array.from(items).map(li => li.textContent);
    expect(texts).toContain('100');
    expect(texts).toContain('101');
    expect(texts).toContain('102');
    expect(texts).toContain('200');

    picker.element.remove();
  });

  it('filters by commit value', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.value = '10';
    picker.input.dispatchEvent(new Event('input'));

    const items = picker.element.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(3); // 100, 101, 102
    expect(Array.from(items).map(li => li.textContent)).not.toContain('200');

    picker.element.remove();
  });

  it('filters by commit value prefix', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.value = '200';
    picker.input.dispatchEvent(new Event('input'));

    const items = picker.element.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toBe('200');

    picker.element.remove();
  });

  it('calls onSelect with commit value on click', () => {
    const onSelect = vi.fn();
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect,
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));

    const items = picker.element.querySelectorAll('.combobox-item');
    (items[0] as HTMLElement).click(); // "100"

    expect(onSelect).toHaveBeenCalledWith('100');

    picker.element.remove();
  });

  it('sets input value on selection', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));
    const items = picker.element.querySelectorAll('.combobox-item');
    (items[0] as HTMLElement).click();

    expect(picker.input.value).toBe('100');

    picker.element.remove();
  });

  it('keeps dropdown open when ArrowDown moves focus to an item', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));
    const dropdown = picker.element.querySelector('ul') as HTMLElement;
    expect(dropdown.classList.contains('open')).toBe(true);

    const firstItem = dropdown.querySelector('li.combobox-item') as HTMLElement;
    picker.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    picker.input.dispatchEvent(new FocusEvent('blur', { relatedTarget: firstItem }));

    expect(dropdown.classList.contains('open')).toBe(true);

    picker.element.remove();
  });

  it('selects item via ArrowDown then Enter', () => {
    const onSelect = vi.fn();
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect,
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));
    const dropdown = picker.element.querySelector('ul') as HTMLElement;

    picker.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    const firstItem = dropdown.querySelector('li.combobox-item') as HTMLElement;
    picker.input.dispatchEvent(new FocusEvent('blur', { relatedTarget: firstItem }));

    firstItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSelect).toHaveBeenCalledWith('100');

    picker.element.remove();
  });

  it('accepts value on change event', () => {
    const onSelect = vi.fn();
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect,
    });
    document.body.append(picker.element);

    picker.input.value = '100';
    picker.input.dispatchEvent(new Event('change'));

    expect(onSelect).toHaveBeenCalledWith('100');

    picker.element.remove();
  });

  it('sets initial value', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      initialValue: '100',
      onSelect: () => {},
    });
    document.body.append(picker.element);

    expect(picker.input.value).toBe('100');

    picker.element.remove();
  });

  it('sets initial value for any commit', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      initialValue: '101',
      onSelect: () => {},
    });

    expect(picker.input.value).toBe('101');
  });

  it('respects getMachineCommits filter', () => {
    const machineCommits = new Set(['100', '200']);
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
      getMachineCommits: () => machineCommits,
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));

    const items = picker.element.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(2);
    const texts = Array.from(items).map(li => li.textContent);
    expect(texts).toContain('100');
    expect(texts).toContain('200');

    picker.element.remove();
  });

  it('shows loading hint when getMachineCommits returns loading', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
      getMachineCommits: () => 'loading',
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));

    const items = picker.element.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toBe('Loading commits...');

    picker.element.remove();
  });

  it('shows all commits when getMachineCommits returns null', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
      getMachineCommits: () => null,
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));

    const items = picker.element.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(4);

    picker.element.remove();
  });

  it('limits dropdown to 100 items', () => {
    const values = Array.from({ length: 150 }, (_, i) => String(i));
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));

    const items = picker.element.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(100);

    picker.element.remove();
  });

  it('closes dropdown on blur', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));
    expect(picker.element.querySelector('.combobox-dropdown.open')).toBeTruthy();

    picker.input.dispatchEvent(new Event('blur'));
    expect(picker.element.querySelector('.combobox-dropdown.open')).toBeNull();

    picker.element.remove();
  });

  it('uses custom placeholder', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      placeholder: 'Custom placeholder',
      onSelect: () => {},
    });

    expect(picker.input.placeholder).toBe('Custom placeholder');
  });

  // --- Validation tests ---

  it('shows combobox-invalid on input when no commits match', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.value = 'zzz-no-match';
    picker.input.dispatchEvent(new Event('input'));

    expect(picker.input.classList.contains('combobox-invalid')).toBe(true);

    picker.element.remove();
  });

  it('removes combobox-invalid on input when commits match', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    // First: invalid
    picker.input.value = 'zzz';
    picker.input.dispatchEvent(new Event('input'));
    expect(picker.input.classList.contains('combobox-invalid')).toBe(true);

    // Then: valid prefix
    picker.input.value = '10';
    picker.input.dispatchEvent(new Event('input'));
    expect(picker.input.classList.contains('combobox-invalid')).toBe(false);

    picker.element.remove();
  });

  it('no combobox-invalid when input is empty', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.value = '';
    picker.input.dispatchEvent(new Event('input'));

    expect(picker.input.classList.contains('combobox-invalid')).toBe(false);

    picker.element.remove();
  });

  it('does not call onSelect on change when combobox-invalid', () => {
    const onSelect = vi.fn();
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect,
    });
    document.body.append(picker.element);

    picker.input.value = 'zzz-invalid';
    picker.input.dispatchEvent(new Event('input')); // triggers invalid
    picker.input.dispatchEvent(new Event('change'));

    expect(onSelect).not.toHaveBeenCalled();

    picker.element.remove();
  });

  it('calls onSelect on Enter when input is valid', () => {
    const onSelect = vi.fn();
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect,
    });
    document.body.append(picker.element);

    picker.input.value = '100';
    picker.input.dispatchEvent(new Event('input')); // populate dropdown
    picker.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(onSelect).toHaveBeenCalledWith('100');

    picker.element.remove();
  });

  it('does not call onSelect on Enter when input is invalid', () => {
    const onSelect = vi.fn();
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect,
    });
    document.body.append(picker.element);

    picker.input.value = 'zzz-invalid';
    picker.input.dispatchEvent(new Event('input')); // triggers invalid
    picker.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(onSelect).not.toHaveBeenCalled();

    picker.element.remove();
  });

  it('no combobox-invalid when getMachineCommits returns loading', () => {
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
      getMachineCommits: () => 'loading',
    });
    document.body.append(picker.element);

    picker.input.value = 'zzz-invalid';
    picker.input.dispatchEvent(new Event('input'));

    expect(picker.input.classList.contains('combobox-invalid')).toBe(false);

    picker.element.remove();
  });

  it('validates against machine-filtered commits', () => {
    const machineCommits = new Set(['100', '200']);
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect: () => {},
      getMachineCommits: () => machineCommits,
    });
    document.body.append(picker.element);

    // '101' is in COMMIT_VALUES but not in machineCommits
    picker.input.value = '101';
    picker.input.dispatchEvent(new Event('input'));
    expect(picker.input.classList.contains('combobox-invalid')).toBe(true);

    // '100' is in machineCommits
    picker.input.value = '100';
    picker.input.dispatchEvent(new Event('input'));
    expect(picker.input.classList.contains('combobox-invalid')).toBe(false);

    picker.element.remove();
  });

  it('rejects partial match on Enter (exact-match required)', () => {
    const onSelect = vi.fn();
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect,
    });
    document.body.append(picker.element);

    // "10" substring-matches "100", "101", "102" but is not an exact match
    picker.input.value = '10';
    picker.input.dispatchEvent(new Event('input'));
    expect(picker.input.classList.contains('combobox-invalid')).toBe(false); // suggestions exist

    picker.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(picker.input.classList.contains('combobox-invalid')).toBe(true);

    picker.element.remove();
  });

  it('rejects partial match on change (exact-match required)', () => {
    const onSelect = vi.fn();
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect,
    });
    document.body.append(picker.element);

    picker.input.value = '10';
    picker.input.dispatchEvent(new Event('input'));
    picker.input.dispatchEvent(new Event('change'));
    expect(onSelect).not.toHaveBeenCalled();
    expect(picker.input.classList.contains('combobox-invalid')).toBe(true);

    picker.element.remove();
  });

  it('accepts exact match on Enter', () => {
    const onSelect = vi.fn();
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect,
    });
    document.body.append(picker.element);

    picker.input.value = '100';
    picker.input.dispatchEvent(new Event('input'));
    picker.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onSelect).toHaveBeenCalledWith('100');

    picker.element.remove();
  });

  it('accepts exact match on change', () => {
    const onSelect = vi.fn();
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect,
    });
    document.body.append(picker.element);

    picker.input.value = '100';
    picker.input.dispatchEvent(new Event('input'));
    picker.input.dispatchEvent(new Event('change'));
    expect(onSelect).toHaveBeenCalledWith('100');

    picker.element.remove();
  });

  it('accepts exact match on Enter via display value', () => {
    const onSelect = vi.fn();
    const picker = createCommitPicker({
      id: 'test',
      getCommitData: () => ({ values: COMMIT_VALUES }),
      onSelect,
    });
    document.body.append(picker.element);

    picker.input.value = '100';
    picker.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onSelect).toHaveBeenCalledWith('100');

    picker.element.remove();
  });
});

// ---------------------------------------------------------------------------
// createMachineCombobox validation tests
// ---------------------------------------------------------------------------

const mockGetMachines = getMachines as ReturnType<typeof vi.fn>;

const MACHINES = [
  { name: 'clang-x86', info: {} },
  { name: 'clang-arm', info: {} },
  { name: 'gcc-x86', info: {} },
];

describe('createMachineCombobox', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetComboboxState();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeMachineCtx(overrides?: Partial<ComboboxContext>): ComboboxContext {
    const sideA: SideSelection = { suite: 'nts', commit: '', machine: '', runs: [], runAgg: 'median' };
    return {
      getCommitData: () => ({
        cachedCommitValues: [],
      }),
      getSuiteName: () => 'nts',
      getSideState: () => ({
        selection: sideA,
        setSide: (partial: Partial<SideSelection>) => Object.assign(sideA, partial),
        label: 'Side A',
      }),
      ...overrides,
    };
  }

  /** Create combobox and resolve the initial machine list fetch. */
  async function createAndLoad(
    ctx?: ComboboxContext,
    setSide?: (partial: Partial<SideSelection>) => void,
    onMachineChange?: () => void,
    machines?: Array<{ name: string; info: Record<string, unknown> }>,
  ): Promise<HTMLElement> {
    mockGetMachines.mockResolvedValue({ items: machines ?? MACHINES, total: (machines ?? MACHINES).length });
    const wrapper = createMachineCombobox('a', setSide ?? (() => {}), onMachineChange ?? (() => {}), ctx ?? makeMachineCtx());
    document.body.append(wrapper);
    await vi.advanceTimersByTimeAsync(0); // resolve fetch
    return wrapper;
  }

  it('fetches full machine list once on creation', async () => {
    mockGetMachines.mockResolvedValue({ items: MACHINES, total: 3 });
    const ctx = makeMachineCtx();
    const wrapper = createMachineCombobox('a', () => {}, () => {}, ctx);
    document.body.append(wrapper);

    expect(mockGetMachines).toHaveBeenCalledTimes(1);
    expect(mockGetMachines).toHaveBeenCalledWith('nts', { limit: 500 });

    wrapper.remove();
  });

  it('does not fetch when no suite is selected', () => {
    mockGetMachines.mockResolvedValue({ items: [], total: 0 });
    const ctx = makeMachineCtx({
      getSuiteName: () => '',
      getSideState: () => ({
        selection: { suite: '', commit: '', machine: '', runs: [], runAgg: 'median' as const },
        setSide: () => {},
        label: 'Side A',
      }),
    });
    const wrapper = createMachineCombobox('a', () => {}, () => {}, ctx);
    document.body.append(wrapper);

    expect(mockGetMachines).not.toHaveBeenCalled();

    wrapper.remove();
  });

  it('filters locally by substring — no additional API calls', async () => {
    const wrapper = await createAndLoad();
    const input = wrapper.querySelector('input') as HTMLInputElement;

    mockGetMachines.mockClear();
    input.value = 'x86';
    input.dispatchEvent(new Event('input'));

    expect(mockGetMachines).not.toHaveBeenCalled();
    const items = wrapper.querySelectorAll('li.combobox-item');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toBe('clang-x86');
    expect(items[1].textContent).toBe('gcc-x86');

    wrapper.remove();
  });

  it('shows combobox-invalid when no machines match', async () => {
    const wrapper = await createAndLoad();
    const input = wrapper.querySelector('input') as HTMLInputElement;

    input.value = 'nonexistent';
    input.dispatchEvent(new Event('input'));
    expect(input.classList.contains('combobox-invalid')).toBe(true);

    wrapper.remove();
  });

  it('removes combobox-invalid when machines match again', async () => {
    const wrapper = await createAndLoad();
    const input = wrapper.querySelector('input') as HTMLInputElement;

    input.value = 'nonexistent';
    input.dispatchEvent(new Event('input'));
    expect(input.classList.contains('combobox-invalid')).toBe(true);

    input.value = 'clang';
    input.dispatchEvent(new Event('input'));
    expect(input.classList.contains('combobox-invalid')).toBe(false);

    wrapper.remove();
  });

  it('accepts on Enter when dropdown has items', async () => {
    const onMachineChange = vi.fn();
    const wrapper = await createAndLoad(undefined, undefined, onMachineChange);
    const input = wrapper.querySelector('input') as HTMLInputElement;

    input.value = 'clang';
    input.dispatchEvent(new Event('input'));
    input.value = 'clang-x86';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    // onMachineChange is called asynchronously via onMachineSelect
    await vi.advanceTimersByTimeAsync(0);
    expect(onMachineChange).toHaveBeenCalled();
    expect(input.classList.contains('combobox-invalid')).toBe(false);

    wrapper.remove();
  });

  it('does not accept on Enter when dropdown is empty', async () => {
    const onMachineChange = vi.fn();
    const wrapper = await createAndLoad(undefined, undefined, onMachineChange);
    const input = wrapper.querySelector('input') as HTMLInputElement;

    input.value = 'nonexistent';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(onMachineChange).not.toHaveBeenCalled();
    expect(input.classList.contains('combobox-invalid')).toBe(true);

    wrapper.remove();
  });

  it('disables commit input when machine is cleared via change', async () => {
    const sideA: SideSelection = { suite: 'nts', commit: '100', machine: 'clang-x86', runs: ['r1'], runAgg: 'median' };
    const setSide = vi.fn((partial: Partial<SideSelection>) => Object.assign(sideA, partial));
    const onMachineChange = vi.fn();
    const ctx = makeMachineCtx({
      getSideState: () => ({
        selection: sideA,
        setSide,
        label: 'Side A',
      }),
    });
    const wrapper = await createAndLoad(ctx, setSide, onMachineChange);

    // Create commit combobox to set up commitInputA ref
    const commitWrapper = createCommitCombobox('a', setSide, () => {}, ctx);
    document.body.append(commitWrapper);
    const commitInput = commitWrapper.querySelector('input')! as HTMLInputElement;
    expect(commitInput.disabled).toBe(false); // machine is set

    // Clear machine text and trigger change
    const machineInput = wrapper.querySelector('input') as HTMLInputElement;
    machineInput.value = '';
    machineInput.dispatchEvent(new Event('change'));

    expect(setSide).toHaveBeenCalledWith({ machine: '', commit: '', runs: [] });
    expect(commitInput.disabled).toBe(true);
    expect(commitInput.placeholder).toBe('Select a machine first');
    expect(onMachineChange).toHaveBeenCalled();

    wrapper.remove();
    commitWrapper.remove();
  });

  it('disables machine input when no suite is selected', () => {
    const sideA: SideSelection = { suite: '', commit: '', machine: '', runs: [], runAgg: 'median' };
    const ctx = makeMachineCtx({
      getSuiteName: () => '',
      getSideState: () => ({
        selection: sideA,
        setSide: (partial: Partial<SideSelection>) => Object.assign(sideA, partial),
        label: 'Side A',
      }),
    });
    const wrapper = createMachineCombobox('a', () => {}, () => {}, ctx);
    document.body.append(wrapper);

    const input = wrapper.querySelector('input') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('Select a suite first');

    wrapper.remove();
  });

  it('shows "Loading machines..." before fetch resolves', () => {
    mockGetMachines.mockReturnValue(new Promise(() => {})); // never resolves
    const ctx = makeMachineCtx();
    const wrapper = createMachineCombobox('a', () => {}, () => {}, ctx);
    document.body.append(wrapper);

    const input = wrapper.querySelector('input') as HTMLInputElement;
    input.dispatchEvent(new Event('focus'));

    const items = wrapper.querySelectorAll('li');
    expect(items.length).toBe(1);
    expect(items[0].textContent).toBe('Loading machines...');

    wrapper.remove();
  });
});

// ---------------------------------------------------------------------------
// fetchMachineCommitSet tests
// ---------------------------------------------------------------------------

describe('fetchMachineCommitSet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns set of commit values from machine runs', async () => {
    (getMachineRuns as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        { commit: '100', uuid: 'r1', submitted_at: null },
        { commit: '101', uuid: 'r2', submitted_at: null },
        { commit: '100', uuid: 'r3', submitted_at: null },
      ],
      cursor: { next: null },
    });

    const commits = await fetchMachineCommitSet('nts', 'clang-x86');

    expect(commits).toEqual(new Set(['100', '101']));
    expect(getMachineRuns).toHaveBeenCalledWith('nts', 'clang-x86', { limit: 500 }, undefined);
  });

  it('returns empty set when machine has no runs', async () => {
    (getMachineRuns as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [],
      cursor: { next: null },
    });

    const commits = await fetchMachineCommitSet('nts', 'empty-machine');

    expect(commits).toEqual(new Set());
  });

  it('passes abort signal to getMachineRuns', async () => {
    (getMachineRuns as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [],
      cursor: { next: null },
    });
    const ctrl = new AbortController();

    await fetchMachineCommitSet('nts', 'clang-x86', ctrl.signal);

    expect(getMachineRuns).toHaveBeenCalledWith('nts', 'clang-x86', { limit: 500 }, ctrl.signal);
  });
});

// ---------------------------------------------------------------------------
// createCommitPicker with displayMap
// ---------------------------------------------------------------------------

describe('createCommitPicker with displayMap', () => {
  const DISPLAY_MAP = new Map([['abc123', 'v1.0'], ['def456', 'v2.0']]);
  const COMMIT_VALUES_DM = ['abc123', 'def456', 'ghi789'];

  it('shows display values in dropdown items', () => {
    const picker = createCommitPicker({
      id: 'display-test',
      getCommitData: () => ({ values: COMMIT_VALUES_DM, displayMap: DISPLAY_MAP }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    const input = picker.input;
    input.dispatchEvent(new Event('focus'));

    const items = picker.element.querySelectorAll('.combobox-item');
    expect(items[0].textContent).toBe('v1.0');
    expect(items[1].textContent).toBe('v2.0');
    expect(items[2].textContent).toBe('ghi789'); // no mapping, raw string

    picker.element.remove();
  });

  it('filters by display value', () => {
    const picker = createCommitPicker({
      id: 'filter-test',
      getCommitData: () => ({ values: COMMIT_VALUES_DM, displayMap: DISPLAY_MAP }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    const input = picker.input;
    input.value = 'v1';
    input.dispatchEvent(new Event('input'));

    const items = picker.element.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toBe('v1.0');

    picker.element.remove();
  });

  it('calls onSelect with raw commit string', () => {
    const onSelect = vi.fn();
    const picker = createCommitPicker({
      id: 'select-test',
      getCommitData: () => ({ values: COMMIT_VALUES_DM, displayMap: DISPLAY_MAP }),
      onSelect,
    });
    document.body.append(picker.element);

    const input = picker.input;
    input.dispatchEvent(new Event('focus'));

    const items = picker.element.querySelectorAll('.combobox-item');
    (items[0] as HTMLElement).click();

    expect(onSelect).toHaveBeenCalledWith('abc123'); // raw string, not 'v1.0'

    picker.element.remove();
  });
});
