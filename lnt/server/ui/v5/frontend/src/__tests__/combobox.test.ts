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
  createMachineCombobox, createOrderCombobox, createOrderPicker,
  fetchMachineOrderSet, resetComboboxState, type ComboboxContext,
} from '../combobox';

function makeContext(overrides?: Partial<ComboboxContext>): ComboboxContext {
  const sideA: SideSelection = { suite: '', order: '', machine: '', runs: [], runAgg: 'median' };
  return {
    getOrderData: () => ({
      cachedOrderValues: ['100', '101', '102'],
      orderTags: new Map<string, string | null>([['100', 'release-1'], ['101', null], ['102', 'release-2']]),
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

describe('createOrderCombobox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetComboboxState();
  });

  it('shows tags in dropdown items', () => {
    const ctx = makeContext();
    const wrapper = createOrderCombobox('a', () => {}, () => {}, ctx);
    document.body.append(wrapper);

    const input = wrapper.querySelector('input')!;
    input.dispatchEvent(new Event('focus'));

    const items = wrapper.querySelectorAll('.combobox-item');
    const texts = Array.from(items).map(li => li.textContent);
    expect(texts).toContain('100 (release-1)');
    expect(texts).toContain('101');
    expect(texts).toContain('102 (release-2)');

    wrapper.remove();
  });

  it('filters by tag text', () => {
    const ctx = makeContext();
    const wrapper = createOrderCombobox('a', () => {}, () => {}, ctx);
    document.body.append(wrapper);

    const input = wrapper.querySelector('input')! as HTMLInputElement;
    input.value = 'release-2';
    input.dispatchEvent(new Event('input'));

    const items = wrapper.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toBe('102 (release-2)');

    wrapper.remove();
  });

  it('filters by order value', () => {
    const ctx = makeContext();
    const wrapper = createOrderCombobox('a', () => {}, () => {}, ctx);
    document.body.append(wrapper);

    const input = wrapper.querySelector('input')! as HTMLInputElement;
    input.value = '101';
    input.dispatchEvent(new Event('input'));

    const items = wrapper.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toBe('101');

    wrapper.remove();
  });

  it('shows loading hint when machine is set but orders not loaded', () => {
    const sideA: SideSelection = { suite: '', order: '', machine: 'clang-x86', runs: [], runAgg: 'median' };
    const ctx = makeContext({
      getSideState: () => ({
        selection: sideA,
        setSide: (partial: Partial<SideSelection>) => Object.assign(sideA, partial),
        label: 'Side A',
      }),
    });
    // machineOrdersA is null (not loaded) — resetComboboxState ensures this
    const wrapper = createOrderCombobox('a', () => {}, () => {}, ctx);
    document.body.append(wrapper);

    const input = wrapper.querySelector('input')!;
    input.dispatchEvent(new Event('focus'));

    const items = wrapper.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toBe('Loading orders...');

    wrapper.remove();
  });

  it('calls setSide with order value (not tag) on selection', () => {
    const sideA: SideSelection = { suite: '', order: '', machine: '', runs: [], runAgg: 'median' };
    const setSide = vi.fn();
    const ctx = makeContext({
      getSideState: () => ({
        selection: sideA,
        setSide,
        label: 'Side A',
      }),
    });
    const wrapper = createOrderCombobox('a', setSide, () => {}, ctx);
    document.body.append(wrapper);

    const input = wrapper.querySelector('input')!;
    input.dispatchEvent(new Event('focus'));

    const items = wrapper.querySelectorAll('.combobox-item');
    // Click the tagged item "100 (release-1)"
    (items[0] as HTMLElement).click();

    expect(setSide).toHaveBeenCalledWith({ order: '100' });

    wrapper.remove();
  });

  it('shows tag in input after selection', () => {
    const ctx = makeContext();
    const wrapper = createOrderCombobox('a', () => {}, () => {}, ctx);
    document.body.append(wrapper);

    const input = wrapper.querySelector('input')! as HTMLInputElement;
    input.dispatchEvent(new Event('focus'));

    const items = wrapper.querySelectorAll('.combobox-item');
    (items[0] as HTMLElement).click();

    expect(input.value).toBe('100 (release-1)');

    wrapper.remove();
  });

  it('shows tag in input on URL restore', () => {
    const sideA: SideSelection = { suite: '', order: '102', machine: '', runs: [], runAgg: 'median' };
    const ctx = makeContext({
      getSideState: () => ({
        selection: sideA,
        setSide: () => {},
        label: 'Side A',
      }),
    });
    const wrapper = createOrderCombobox('a', () => {}, () => {}, ctx);
    document.body.append(wrapper);

    const input = wrapper.querySelector('input')! as HTMLInputElement;
    expect(input.value).toBe('102 (release-2)');

    wrapper.remove();
  });

  it('shows plain value when order has no tag', () => {
    const sideA: SideSelection = { suite: '', order: '101', machine: '', runs: [], runAgg: 'median' };
    const ctx = makeContext({
      getSideState: () => ({
        selection: sideA,
        setSide: () => {},
        label: 'Side A',
      }),
    });
    const wrapper = createOrderCombobox('a', () => {}, () => {}, ctx);
    document.body.append(wrapper);

    const input = wrapper.querySelector('input')! as HTMLInputElement;
    expect(input.value).toBe('101');

    wrapper.remove();
  });

  it('disables order input when no machine is selected', () => {
    const sideA: SideSelection = { suite: 'nts', order: '', machine: '', runs: [], runAgg: 'median' };
    const ctx = makeContext({
      getSideState: () => ({
        selection: sideA,
        setSide: () => {},
        label: 'Side A',
      }),
    });
    const wrapper = createOrderCombobox('a', () => {}, () => {}, ctx);
    document.body.append(wrapper);

    const input = wrapper.querySelector('input')! as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('Select a machine first');

    wrapper.remove();
  });

  it('does not disable order input when machine is selected', () => {
    const sideA: SideSelection = { suite: 'nts', order: '', machine: 'clang-x86', runs: [], runAgg: 'median' };
    const ctx = makeContext({
      getSideState: () => ({
        selection: sideA,
        setSide: () => {},
        label: 'Side A',
      }),
    });
    const wrapper = createOrderCombobox('a', () => {}, () => {}, ctx);
    document.body.append(wrapper);

    const input = wrapper.querySelector('input')! as HTMLInputElement;
    expect(input.disabled).toBe(false);

    wrapper.remove();
  });
});
// ---------------------------------------------------------------------------

const ORDER_VALUES = ['100', '101', '102', '200'];
const ORDER_TAGS = new Map<string, string | null>([
  ['100', 'release-1'],
  ['101', null],
  ['102', 'release-2'],
  ['200', 'beta-1'],
]);

describe('createOrderPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a combobox wrapper with input and dropdown', () => {
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    expect(picker.element.getAttribute('role')).toBe('combobox');
    expect(picker.element.querySelector('input')).toBeTruthy();
    expect(picker.element.querySelector('ul')).toBeTruthy();

    picker.element.remove();
  });

  it('shows all orders on focus', () => {
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));

    const items = picker.element.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(4);

    picker.element.remove();
  });

  it('displays tags in dropdown items', () => {
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));

    const items = picker.element.querySelectorAll('.combobox-item');
    const texts = Array.from(items).map(li => li.textContent);
    expect(texts).toContain('100 (release-1)');
    expect(texts).toContain('101');
    expect(texts).toContain('102 (release-2)');
    expect(texts).toContain('200 (beta-1)');

    picker.element.remove();
  });

  it('filters by order value', () => {
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.value = '10';
    picker.input.dispatchEvent(new Event('input'));

    const items = picker.element.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(3); // 100, 101, 102
    expect(Array.from(items).map(li => li.textContent)).not.toContain('200 (beta-1)');

    picker.element.remove();
  });

  it('filters by tag text', () => {
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.value = 'beta';
    picker.input.dispatchEvent(new Event('input'));

    const items = picker.element.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toBe('200 (beta-1)');

    picker.element.remove();
  });

  it('calls onSelect with order value (not tag) on click', () => {
    const onSelect = vi.fn();
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
      onSelect,
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));

    const items = picker.element.querySelectorAll('.combobox-item');
    (items[0] as HTMLElement).click(); // "100 (release-1)"

    expect(onSelect).toHaveBeenCalledWith('100');

    picker.element.remove();
  });

  it('sets input value with tag on selection', () => {
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));
    const items = picker.element.querySelectorAll('.combobox-item');
    (items[0] as HTMLElement).click();

    expect(picker.input.value).toBe('100 (release-1)');

    picker.element.remove();
  });

  it('keeps dropdown open when ArrowDown moves focus to an item', () => {
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
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
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
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

  it('strips tag suffix on change event', () => {
    const onSelect = vi.fn();
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
      onSelect,
    });
    document.body.append(picker.element);

    // Simulate: user clicked "100 (release-1)" from dropdown (which set the
    // input value), then blurred — change event fires with the tagged display
    // value. The handler strips the tag suffix before calling onSelect.
    picker.input.value = '100 (release-1)';
    picker.input.dispatchEvent(new Event('change'));

    expect(onSelect).toHaveBeenCalledWith('100');

    picker.element.remove();
  });

  it('sets initial value with tag', () => {
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
      initialValue: '100',
      onSelect: () => {},
    });
    document.body.append(picker.element);

    expect(picker.input.value).toBe('100 (release-1)');

    picker.element.remove();
  });

  it('sets initial value without tag when tag is null', () => {
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
      initialValue: '101',
      onSelect: () => {},
    });

    expect(picker.input.value).toBe('101');
  });

  it('respects getMachineOrders filter', () => {
    const machineOrders = new Set(['100', '200']);
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
      onSelect: () => {},
      getMachineOrders: () => machineOrders,
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));

    const items = picker.element.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(2);
    const texts = Array.from(items).map(li => li.textContent);
    expect(texts).toContain('100 (release-1)');
    expect(texts).toContain('200 (beta-1)');

    picker.element.remove();
  });

  it('shows loading hint when getMachineOrders returns loading', () => {
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
      onSelect: () => {},
      getMachineOrders: () => 'loading',
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));

    const items = picker.element.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toBe('Loading orders...');

    picker.element.remove();
  });

  it('shows all orders when getMachineOrders returns null', () => {
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
      onSelect: () => {},
      getMachineOrders: () => null,
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));

    const items = picker.element.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(4);

    picker.element.remove();
  });

  it('limits dropdown to 100 items', () => {
    const values = Array.from({ length: 150 }, (_, i) => String(i));
    const tags = new Map<string, string | null>(values.map(v => [v, null]));
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values, tags }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.dispatchEvent(new Event('focus'));

    const items = picker.element.querySelectorAll('.combobox-item');
    expect(items).toHaveLength(100);

    picker.element.remove();
  });

  it('closes dropdown on blur', () => {
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
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
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
      placeholder: 'Custom placeholder',
      onSelect: () => {},
    });

    expect(picker.input.placeholder).toBe('Custom placeholder');
  });

  // --- Validation tests ---

  it('shows combobox-invalid on input when no orders match', () => {
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
      onSelect: () => {},
    });
    document.body.append(picker.element);

    picker.input.value = 'zzz-no-match';
    picker.input.dispatchEvent(new Event('input'));

    expect(picker.input.classList.contains('combobox-invalid')).toBe(true);

    picker.element.remove();
  });

  it('removes combobox-invalid on input when orders match', () => {
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
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
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
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
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
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
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
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
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
      onSelect,
    });
    document.body.append(picker.element);

    picker.input.value = 'zzz-invalid';
    picker.input.dispatchEvent(new Event('input')); // triggers invalid
    picker.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(onSelect).not.toHaveBeenCalled();

    picker.element.remove();
  });

  it('no combobox-invalid when getMachineOrders returns loading', () => {
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
      onSelect: () => {},
      getMachineOrders: () => 'loading',
    });
    document.body.append(picker.element);

    picker.input.value = 'zzz-invalid';
    picker.input.dispatchEvent(new Event('input'));

    expect(picker.input.classList.contains('combobox-invalid')).toBe(false);

    picker.element.remove();
  });

  it('validates against machine-filtered orders', () => {
    const machineOrders = new Set(['100', '200']);
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
      onSelect: () => {},
      getMachineOrders: () => machineOrders,
    });
    document.body.append(picker.element);

    // '101' is in ORDER_VALUES but not in machineOrders
    picker.input.value = '101';
    picker.input.dispatchEvent(new Event('input'));
    expect(picker.input.classList.contains('combobox-invalid')).toBe(true);

    // '100' is in machineOrders
    picker.input.value = '100';
    picker.input.dispatchEvent(new Event('input'));
    expect(picker.input.classList.contains('combobox-invalid')).toBe(false);

    picker.element.remove();
  });

  it('rejects partial match on Enter (exact-match required)', () => {
    const onSelect = vi.fn();
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
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
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
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
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
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
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
      onSelect,
    });
    document.body.append(picker.element);

    picker.input.value = '100';
    picker.input.dispatchEvent(new Event('input'));
    picker.input.dispatchEvent(new Event('change'));
    expect(onSelect).toHaveBeenCalledWith('100');

    picker.element.remove();
  });

  it('accepts exact match with tag suffix on Enter', () => {
    const onSelect = vi.fn();
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
      onSelect,
    });
    document.body.append(picker.element);

    // Typing the display label "100 (release-1)" should strip to "100" and accept
    picker.input.value = '100 (release-1)';
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
    const sideA: SideSelection = { suite: 'nts', order: '', machine: '', runs: [], runAgg: 'median' };
    return {
      getOrderData: () => ({
        cachedOrderValues: [],
        orderTags: new Map<string, string | null>(),
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
        selection: { suite: '', order: '', machine: '', runs: [], runAgg: 'median' as const },
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

  it('disables order input when machine is cleared via change', async () => {
    const sideA: SideSelection = { suite: 'nts', order: '100', machine: 'clang-x86', runs: ['r1'], runAgg: 'median' };
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

    // Create order combobox to set up orderInputA ref
    const orderWrapper = createOrderCombobox('a', setSide, () => {}, ctx);
    document.body.append(orderWrapper);
    const orderInput = orderWrapper.querySelector('input')! as HTMLInputElement;
    expect(orderInput.disabled).toBe(false); // machine is set

    // Clear machine text and trigger change
    const machineInput = wrapper.querySelector('input') as HTMLInputElement;
    machineInput.value = '';
    machineInput.dispatchEvent(new Event('change'));

    expect(setSide).toHaveBeenCalledWith({ machine: '', order: '', runs: [] });
    expect(orderInput.disabled).toBe(true);
    expect(orderInput.placeholder).toBe('Select a machine first');
    expect(onMachineChange).toHaveBeenCalled();

    wrapper.remove();
    orderWrapper.remove();
  });

  it('disables machine input when no suite is selected', () => {
    const sideA: SideSelection = { suite: '', order: '', machine: '', runs: [], runAgg: 'median' };
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
// fetchMachineOrderSet tests
// ---------------------------------------------------------------------------

describe('fetchMachineOrderSet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns set of primary order values from machine runs', async () => {
    (getMachineRuns as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        { order: { rev: '100' }, uuid: 'r1', start_time: null, end_time: null },
        { order: { rev: '101' }, uuid: 'r2', start_time: null, end_time: null },
        { order: { rev: '100' }, uuid: 'r3', start_time: null, end_time: null },
      ],
      cursor: { next: null },
    });

    const orders = await fetchMachineOrderSet('nts', 'clang-x86');

    expect(orders).toEqual(new Set(['100', '101']));
    expect(getMachineRuns).toHaveBeenCalledWith('nts', 'clang-x86', { limit: 500 }, undefined);
  });

  it('returns empty set when machine has no runs', async () => {
    (getMachineRuns as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [],
      cursor: { next: null },
    });

    const orders = await fetchMachineOrderSet('nts', 'empty-machine');

    expect(orders).toEqual(new Set());
  });

  it('passes abort signal to getMachineRuns', async () => {
    (getMachineRuns as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [],
      cursor: { next: null },
    });
    const ctrl = new AbortController();

    await fetchMachineOrderSet('nts', 'clang-x86', ctrl.signal);

    expect(getMachineRuns).toHaveBeenCalledWith('nts', 'clang-x86', { limit: 500 }, ctrl.signal);
  });
});
