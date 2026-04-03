// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api', () => ({
  getMachines: vi.fn(),
}));

import { renderMachineCombobox } from '../components/machine-combobox';
import { getMachines } from '../api';

const mockGetMachines = getMachines as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  mockGetMachines.mockReset();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('renderMachineCombobox', () => {
  it('renders an input into the container', () => {
    const container = document.createElement('div');
    renderMachineCombobox(container, { testsuite: 'nts', onSelect: vi.fn() });
    expect(container.querySelector('input.combobox-input')).not.toBeNull();
  });

  it('sets initial value on the input', () => {
    const container = document.createElement('div');
    renderMachineCombobox(container, { testsuite: 'nts', initialValue: 'clang-x86', onSelect: vi.fn() });
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('clang-x86');
  });

  it('calls getMachines with namePrefix after debounce', async () => {
    mockGetMachines.mockResolvedValue({ items: [], total: 0 });
    const container = document.createElement('div');
    document.body.append(container);
    renderMachineCombobox(container, { testsuite: 'nts', onSelect: vi.fn() });

    const input = container.querySelector('input') as HTMLInputElement;
    input.value = 'clang';
    input.dispatchEvent(new Event('input'));

    expect(mockGetMachines).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(mockGetMachines).toHaveBeenCalledWith('nts', { namePrefix: 'clang', limit: 20 }, expect.anything());
  });

  it('shows dropdown with results and calls onSelect on click', async () => {
    mockGetMachines.mockResolvedValue({
      items: [{ name: 'clang-x86', info: {} }, { name: 'clang-arm', info: {} }],
      total: 2,
    });
    const onSelect = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    renderMachineCombobox(container, { testsuite: 'nts', onSelect });

    const input = container.querySelector('input') as HTMLInputElement;
    input.value = 'clang';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const items = container.querySelectorAll('li.combobox-item');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toBe('clang-x86');

    (items[0] as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledWith('clang-x86');
    expect(input.value).toBe('clang-x86');
  });

  it('calls onSelect with typed value on Enter', () => {
    const onSelect = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    renderMachineCombobox(container, { testsuite: 'nts', onSelect });

    const input = container.querySelector('input') as HTMLInputElement;
    input.value = 'my-machine';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onSelect).toHaveBeenCalledWith('my-machine');
  });

  it('closes dropdown on Escape', async () => {
    mockGetMachines.mockResolvedValue({
      items: [{ name: 'clang-x86', info: {} }],
      total: 1,
    });
    const container = document.createElement('div');
    document.body.append(container);
    renderMachineCombobox(container, { testsuite: 'nts', onSelect: vi.fn() });

    const input = container.querySelector('input') as HTMLInputElement;
    input.value = 'clang';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const dropdown = container.querySelector('ul') as HTMLElement;
    expect(dropdown.classList.contains('open')).toBe(true);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(dropdown.classList.contains('open')).toBe(false);
  });

  it('getValue returns the selected value', () => {
    const container = document.createElement('div');
    const handle = renderMachineCombobox(container, {
      testsuite: 'nts', initialValue: 'test-machine', onSelect: vi.fn(),
    });
    expect(handle.getValue()).toBe('test-machine');
  });

  it('destroy removes document click listener', () => {
    const container = document.createElement('div');
    const handle = renderMachineCombobox(container, { testsuite: 'nts', onSelect: vi.fn() });
    const spy = vi.spyOn(document, 'removeEventListener');
    handle.destroy();
    expect(spy).toHaveBeenCalledWith('click', expect.any(Function));
  });
});
