// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SideSelection } from '../types';

// Mock the API module
vi.mock('../api', () => ({
  getMachines: vi.fn().mockResolvedValue({ items: [] }),
  getRuns: vi.fn().mockResolvedValue([]),
}));

import { createOrderCombobox, resetComboboxState, type ComboboxContext } from '../combobox';

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
