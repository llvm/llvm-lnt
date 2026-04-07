// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SideSelection } from '../types';

// Mock the API module
vi.mock('../api', () => ({
  getMachines: vi.fn().mockResolvedValue({ items: [] }),
  getMachineRuns: vi.fn().mockResolvedValue({ items: [], cursor: { next: null } }),
  getRuns: vi.fn().mockResolvedValue([]),
}));

import { getMachineRuns } from '../api';
import {
  createOrderCombobox, createOrderPicker, fetchMachineOrderSet,
  resetComboboxState, type ComboboxContext,
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
});

// ---------------------------------------------------------------------------
// createOrderPicker tests
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

  it('strips tag suffix on change event (Enter)', () => {
    const onSelect = vi.fn();
    const picker = createOrderPicker({
      id: 'test',
      getOrderData: () => ({ values: ORDER_VALUES, tags: ORDER_TAGS }),
      onSelect,
    });
    document.body.append(picker.element);

    picker.input.value = 'abc123 (release-1)';
    picker.input.dispatchEvent(new Event('change'));

    expect(onSelect).toHaveBeenCalledWith('abc123');

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
