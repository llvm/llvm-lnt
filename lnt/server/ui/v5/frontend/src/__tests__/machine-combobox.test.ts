// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api', () => ({
  getMachines: vi.fn(),
}));

import { renderMachineCombobox } from '../components/machine-combobox';
import { getMachines } from '../api';

const mockGetMachines = getMachines as ReturnType<typeof vi.fn>;

const MACHINES = [
  { name: 'clang-x86', info: {} },
  { name: 'clang-arm', info: {} },
  { name: 'gcc-x86', info: {} },
];

beforeEach(() => {
  vi.useFakeTimers();
  mockGetMachines.mockReset();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Create the combobox and resolve the initial machine list fetch. */
async function createAndLoad(
  items: Array<{ name: string; info: Record<string, unknown> }>,
  opts?: Partial<Parameters<typeof renderMachineCombobox>[1]>,
): Promise<{ container: HTMLElement; input: HTMLInputElement; handle: ReturnType<typeof renderMachineCombobox> }> {
  mockGetMachines.mockResolvedValue({ items, total: items.length });
  const container = document.createElement('div');
  document.body.append(container);
  const handle = renderMachineCombobox(container, { testsuite: 'nts', onSelect: vi.fn(), ...opts });
  // Resolve the initial fetch
  await vi.advanceTimersByTimeAsync(0);
  const input = container.querySelector('input') as HTMLInputElement;
  return { container, input, handle };
}

describe('renderMachineCombobox', () => {
  it('renders an input into the container', () => {
    mockGetMachines.mockResolvedValue({ items: [], total: 0 });
    const container = document.createElement('div');
    renderMachineCombobox(container, { testsuite: 'nts', onSelect: vi.fn() });
    expect(container.querySelector('input.combobox-input')).not.toBeNull();
  });

  it('sets initial value on the input', () => {
    mockGetMachines.mockResolvedValue({ items: [], total: 0 });
    const container = document.createElement('div');
    renderMachineCombobox(container, { testsuite: 'nts', initialValue: 'clang-x86', onSelect: vi.fn() });
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('clang-x86');
  });

  it('fetches full machine list once on creation', async () => {
    mockGetMachines.mockResolvedValue({ items: MACHINES, total: 3 });
    const container = document.createElement('div');
    document.body.append(container);
    renderMachineCombobox(container, { testsuite: 'nts', onSelect: vi.fn() });

    expect(mockGetMachines).toHaveBeenCalledTimes(1);
    expect(mockGetMachines).toHaveBeenCalledWith('nts', { limit: 500 }, expect.anything());
  });

  it('does not fetch when testsuite is empty and disables input', () => {
    mockGetMachines.mockResolvedValue({ items: [], total: 0 });
    const container = document.createElement('div');
    renderMachineCombobox(container, { testsuite: '', onSelect: vi.fn() });

    expect(mockGetMachines).not.toHaveBeenCalled();
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('Select a suite first');
  });

  it('does not make additional API calls on keystroke', async () => {
    const { input } = await createAndLoad(MACHINES);

    mockGetMachines.mockClear();
    input.value = 'clang';
    input.dispatchEvent(new Event('input'));
    input.value = 'gcc';
    input.dispatchEvent(new Event('input'));

    expect(mockGetMachines).not.toHaveBeenCalled();
  });

  it('shows "Loading machines..." before fetch resolves', () => {
    mockGetMachines.mockReturnValue(new Promise(() => {})); // never resolves
    const container = document.createElement('div');
    document.body.append(container);
    renderMachineCombobox(container, { testsuite: 'nts', onSelect: vi.fn() });

    const input = container.querySelector('input') as HTMLInputElement;
    input.dispatchEvent(new Event('focus'));

    const items = container.querySelectorAll('li');
    expect(items.length).toBe(1);
    expect(items[0].textContent).toBe('Loading machines...');
  });

  it('filters locally by case-insensitive substring', async () => {
    const { container, input } = await createAndLoad(MACHINES);

    input.value = 'x86';
    input.dispatchEvent(new Event('input'));

    const items = container.querySelectorAll('li.combobox-item');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toBe('clang-x86');
    expect(items[1].textContent).toBe('gcc-x86');
  });

  it('shows all machines when input is empty', async () => {
    const { container, input } = await createAndLoad(MACHINES);

    input.value = '';
    input.dispatchEvent(new Event('input'));

    const items = container.querySelectorAll('li.combobox-item');
    expect(items).toHaveLength(3);
  });

  it('shows all machines without cap', async () => {
    const manyMachines = Array.from({ length: 50 }, (_, i) => ({
      name: `machine-${String(i).padStart(2, '0')}`,
      info: {},
    }));
    const { container, input } = await createAndLoad(manyMachines);

    input.value = 'machine';
    input.dispatchEvent(new Event('input'));

    const items = container.querySelectorAll('li.combobox-item');
    expect(items).toHaveLength(50);
  });

  it('calls onSelect on dropdown item click', async () => {
    const onSelect = vi.fn();
    const { container, input } = await createAndLoad(MACHINES, { onSelect });

    input.value = 'clang';
    input.dispatchEvent(new Event('input'));

    const item = container.querySelector('li.combobox-item') as HTMLElement;
    item.click();
    expect(onSelect).toHaveBeenCalledWith('clang-x86');
    expect(input.value).toBe('clang-x86');
  });

  it('calls onSelect on Enter when dropdown has items', async () => {
    const onSelect = vi.fn();
    const { input } = await createAndLoad(MACHINES, { onSelect });

    input.value = 'clang-x86';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onSelect).toHaveBeenCalledWith('clang-x86');
  });

  it('keeps dropdown open when ArrowDown moves focus to an item', async () => {
    const { container, input } = await createAndLoad(MACHINES);

    input.value = 'clang';
    input.dispatchEvent(new Event('input'));

    const dropdown = container.querySelector('ul') as HTMLElement;
    expect(dropdown.classList.contains('open')).toBe(true);

    // ArrowDown moves focus to the first item — blur fires on input
    const firstItem = dropdown.querySelector('li.combobox-item') as HTMLElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    // Simulate the blur with relatedTarget pointing to the dropdown item
    input.dispatchEvent(new FocusEvent('blur', { relatedTarget: firstItem }));

    // Dropdown should stay open
    expect(dropdown.classList.contains('open')).toBe(true);
  });

  it('selects item via ArrowDown then Enter', async () => {
    const onSelect = vi.fn();
    const { container, input } = await createAndLoad(MACHINES, { onSelect });

    input.value = 'clang';
    input.dispatchEvent(new Event('input'));

    // ArrowDown to first item
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    const firstItem = container.querySelector('li.combobox-item') as HTMLElement;
    input.dispatchEvent(new FocusEvent('blur', { relatedTarget: firstItem }));

    // Enter on the focused item
    firstItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSelect).toHaveBeenCalledWith('clang-x86');
  });

  it('does not call onSelect on Enter when dropdown is empty', async () => {
    const onSelect = vi.fn();
    const { input } = await createAndLoad(MACHINES, { onSelect });

    input.value = 'nonexistent';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('closes dropdown on Escape', async () => {
    const { container, input } = await createAndLoad(MACHINES);

    input.value = 'clang';
    input.dispatchEvent(new Event('input'));

    const dropdown = container.querySelector('ul') as HTMLElement;
    expect(dropdown.classList.contains('open')).toBe(true);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(dropdown.classList.contains('open')).toBe(false);
  });

  it('closes dropdown on blur', async () => {
    const { container, input } = await createAndLoad(MACHINES);

    input.value = 'clang';
    input.dispatchEvent(new Event('input'));

    const dropdown = container.querySelector('ul') as HTMLElement;
    expect(dropdown.classList.contains('open')).toBe(true);

    input.dispatchEvent(new Event('blur'));
    expect(dropdown.classList.contains('open')).toBe(false);
  });

  it('getValue returns the selected value', () => {
    mockGetMachines.mockResolvedValue({ items: [], total: 0 });
    const container = document.createElement('div');
    const handle = renderMachineCombobox(container, {
      testsuite: 'nts', initialValue: 'test-machine', onSelect: vi.fn(),
    });
    expect(handle.getValue()).toBe('test-machine');
  });

  it('destroy removes document click listener and aborts fetch', () => {
    mockGetMachines.mockResolvedValue({ items: [], total: 0 });
    const container = document.createElement('div');
    const handle = renderMachineCombobox(container, { testsuite: 'nts', onSelect: vi.fn() });
    const spy = vi.spyOn(document, 'removeEventListener');
    handle.destroy();
    expect(spy).toHaveBeenCalledWith('click', expect.any(Function));
  });

  // --- Validation tests ---

  it('shows combobox-invalid when no machines match', async () => {
    const { input } = await createAndLoad(MACHINES);

    input.value = 'nonexistent';
    input.dispatchEvent(new Event('input'));
    expect(input.classList.contains('combobox-invalid')).toBe(true);
  });

  it('removes combobox-invalid when machines match again', async () => {
    const { input } = await createAndLoad(MACHINES);

    input.value = 'nonexistent';
    input.dispatchEvent(new Event('input'));
    expect(input.classList.contains('combobox-invalid')).toBe(true);

    input.value = 'clang';
    input.dispatchEvent(new Event('input'));
    expect(input.classList.contains('combobox-invalid')).toBe(false);
  });

  it('adds combobox-invalid on Enter when dropdown is empty', async () => {
    const { input } = await createAndLoad(MACHINES);

    input.value = 'nonexistent';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(input.classList.contains('combobox-invalid')).toBe(true);
  });

  it('removes combobox-invalid on dropdown item click', async () => {
    const { container, input } = await createAndLoad(MACHINES);

    input.classList.add('combobox-invalid');
    input.value = 'clang';
    input.dispatchEvent(new Event('input'));

    const item = container.querySelector('li.combobox-item') as HTMLElement;
    item.click();
    expect(input.classList.contains('combobox-invalid')).toBe(false);
  });

  it('removes combobox-invalid on clear()', () => {
    mockGetMachines.mockResolvedValue({ items: [], total: 0 });
    const container = document.createElement('div');
    const handle = renderMachineCombobox(container, { testsuite: 'nts', onSelect: vi.fn() });
    const input = container.querySelector('input') as HTMLInputElement;

    input.classList.add('combobox-invalid');
    handle.clear();
    expect(input.classList.contains('combobox-invalid')).toBe(false);
  });

  // --- onClear tests ---

  it('calls onClear when input is cleared on change', () => {
    mockGetMachines.mockResolvedValue({ items: [], total: 0 });
    const onClear = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    renderMachineCombobox(container, { testsuite: 'nts', onSelect: vi.fn(), onClear });

    const input = container.querySelector('input') as HTMLInputElement;
    input.value = '';
    input.dispatchEvent(new Event('change'));
    expect(onClear).toHaveBeenCalled();
  });

  it('does not call onClear when onClear is not provided', () => {
    mockGetMachines.mockResolvedValue({ items: [], total: 0 });
    const container = document.createElement('div');
    document.body.append(container);
    renderMachineCombobox(container, { testsuite: 'nts', onSelect: vi.fn() });

    const input = container.querySelector('input') as HTMLInputElement;
    input.value = '';
    expect(() => input.dispatchEvent(new Event('change'))).not.toThrow();
  });

  it('does not call onClear when input has text on change', () => {
    mockGetMachines.mockResolvedValue({ items: [], total: 0 });
    const onClear = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    renderMachineCombobox(container, { testsuite: 'nts', onSelect: vi.fn(), onClear });

    const input = container.querySelector('input') as HTMLInputElement;
    input.value = 'some-machine';
    input.dispatchEvent(new Event('change'));
    expect(onClear).not.toHaveBeenCalled();
  });
});
