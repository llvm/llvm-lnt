// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api', () => ({
  getRegressions: vi.fn(),
}));

import { renderRegressionCombobox } from '../components/regression-combobox';
import { getRegressions } from '../api';

const mockGetRegressions = getRegressions as ReturnType<typeof vi.fn>;

const REGRESSIONS = [
  { uuid: 'uuid-1111', title: 'Compile time regression', state: 'detected', machine_count: 1, test_count: 2 },
  { uuid: 'uuid-2222', title: 'Runtime perf drop', state: 'detected', machine_count: 1, test_count: 1 },
  { uuid: 'uuid-3333', title: null, state: 'detected', machine_count: 1, test_count: 1 },
];

beforeEach(() => {
  vi.useFakeTimers();
  mockGetRegressions.mockReset();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Create the combobox and resolve the initial regression list fetch. */
async function createAndLoad(
  items: typeof REGRESSIONS,
  opts?: Partial<Parameters<typeof renderRegressionCombobox>[1]>,
): Promise<{ container: HTMLElement; input: HTMLInputElement; handle: ReturnType<typeof renderRegressionCombobox> }> {
  mockGetRegressions.mockResolvedValue({ items, next: null, previous: null });
  const container = document.createElement('div');
  document.body.append(container);
  const handle = renderRegressionCombobox(container, { testsuite: 'nts', onSelect: vi.fn(), ...opts });
  // Resolve the initial fetch
  await vi.advanceTimersByTimeAsync(0);
  const input = container.querySelector('input') as HTMLInputElement;
  return { container, input, handle };
}

describe('renderRegressionCombobox', () => {
  // --- Rendering & structure ---

  describe('Rendering & structure', () => {
    it('renders combobox structure with correct ARIA roles', async () => {
      const { container } = await createAndLoad(REGRESSIONS);
      const wrapper = container.querySelector('.combobox');
      expect(wrapper).not.toBeNull();
      expect(wrapper!.getAttribute('role')).toBe('combobox');
      const input = wrapper!.querySelector('input');
      expect(input).not.toBeNull();
      const dropdown = wrapper!.querySelector('ul');
      expect(dropdown).not.toBeNull();
      expect(dropdown!.getAttribute('role')).toBe('listbox');
    });

    it('wrapper has role="combobox" and aria-expanded="false" on render', async () => {
      const { container } = await createAndLoad(REGRESSIONS);
      const wrapper = container.querySelector('.combobox') as HTMLElement;
      expect(wrapper.getAttribute('role')).toBe('combobox');
      expect(wrapper.getAttribute('aria-expanded')).toBe('false');
    });

    it('input has role="searchbox" and aria-controls matching dropdown id', async () => {
      const { container, input } = await createAndLoad(REGRESSIONS);
      expect(input.getAttribute('role')).toBe('searchbox');
      const dropdown = container.querySelector('ul') as HTMLElement;
      expect(input.getAttribute('aria-controls')).toBe(dropdown.id);
    });
  });

  // --- Data fetching ---

  describe('Data fetching', () => {
    it('fetches regressions on creation with limit 500', async () => {
      mockGetRegressions.mockResolvedValue({ items: REGRESSIONS, next: null, previous: null });
      const container = document.createElement('div');
      document.body.append(container);
      renderRegressionCombobox(container, { testsuite: 'nts', onSelect: vi.fn() });

      expect(mockGetRegressions).toHaveBeenCalledTimes(1);
      expect(mockGetRegressions).toHaveBeenCalledWith('nts', { limit: 500 }, expect.anything());
    });

    it('shows "Loading regressions..." before fetch resolves', () => {
      mockGetRegressions.mockReturnValue(new Promise(() => {})); // never resolves
      const container = document.createElement('div');
      document.body.append(container);
      renderRegressionCombobox(container, { testsuite: 'nts', onSelect: vi.fn() });

      const input = container.querySelector('input') as HTMLInputElement;
      input.dispatchEvent(new Event('focus'));

      const items = container.querySelectorAll('li');
      expect(items.length).toBe(1);
      expect(items[0].textContent).toBe('Loading regressions...');
    });

    it('does not fetch when testsuite is empty and disables input', () => {
      mockGetRegressions.mockResolvedValue({ items: [], next: null, previous: null });
      const container = document.createElement('div');
      renderRegressionCombobox(container, { testsuite: '', onSelect: vi.fn() });

      expect(mockGetRegressions).not.toHaveBeenCalled();
      const input = container.querySelector('input') as HTMLInputElement;
      expect(input.disabled).toBe(true);
      expect(input.placeholder).toBe('Select a suite first');
    });

    it('shows "Failed to load regressions" when fetch rejects', async () => {
      mockGetRegressions.mockRejectedValue(new Error('Network error'));
      const container = document.createElement('div');
      document.body.append(container);
      renderRegressionCombobox(container, { testsuite: 'nts', onSelect: vi.fn() });

      // Resolve the rejected promise
      await vi.advanceTimersByTimeAsync(0);

      const input = container.querySelector('input') as HTMLInputElement;
      input.dispatchEvent(new Event('focus'));

      const items = container.querySelectorAll('li');
      expect(items.length).toBe(1);
      expect(items[0].textContent).toBe('Failed to load regressions');
    });
  });

  // --- Dropdown display ---

  describe('Dropdown display', () => {
    it('shows all regressions on focus after fetch resolves', async () => {
      const { container, input } = await createAndLoad(REGRESSIONS);

      input.dispatchEvent(new Event('focus'));

      const items = container.querySelectorAll('li.combobox-item[role="option"]');
      expect(items).toHaveLength(3);
    });

    it('aria-expanded becomes "true" when dropdown opens on focus', async () => {
      const { container, input } = await createAndLoad(REGRESSIONS);

      input.dispatchEvent(new Event('focus'));

      const wrapper = container.querySelector('.combobox') as HTMLElement;
      expect(wrapper.getAttribute('aria-expanded')).toBe('true');
    });

    it('shows "No regressions found" when API returns empty list', async () => {
      const { container, input } = await createAndLoad([]);

      input.dispatchEvent(new Event('focus'));

      const items = container.querySelectorAll('li');
      expect(items.length).toBe(1);
      expect(items[0].textContent).toBe('No regressions found');
    });

    it('untitled regressions display "(untitled) {short-uuid}"', async () => {
      const { container, input } = await createAndLoad(REGRESSIONS);

      input.dispatchEvent(new Event('focus'));

      const items = container.querySelectorAll('li.combobox-item');
      // Third item is untitled
      expect(items[2].textContent).toBe('(untitled) uuid-333');
    });
  });

  // --- Filtering ---

  describe('Filtering', () => {
    it('filters by title substring on input', async () => {
      const { container, input } = await createAndLoad(REGRESSIONS);

      input.value = 'compile';
      input.dispatchEvent(new Event('input'));

      const items = container.querySelectorAll('li.combobox-item[role="option"]');
      expect(items).toHaveLength(1);
      expect(items[0].textContent).toContain('Compile time regression');
    });

    it('re: regex filter mode works', async () => {
      const { container, input } = await createAndLoad(REGRESSIONS);

      input.value = 're:^Runtime';
      input.dispatchEvent(new Event('input'));

      const items = container.querySelectorAll('li.combobox-item[role="option"]');
      expect(items).toHaveLength(1);
      expect(items[0].textContent).toContain('Runtime perf drop');
    });

    it('shows combobox-invalid when no regressions match filter', async () => {
      const { input } = await createAndLoad(REGRESSIONS);

      input.value = 'nonexistent-pattern-xyz';
      input.dispatchEvent(new Event('input'));

      expect(input.classList.contains('combobox-invalid')).toBe(true);
    });
  });

  // --- Selection ---

  describe('Selection', () => {
    it('calls onSelect with uuid and title on item click', async () => {
      const onSelect = vi.fn();
      const { container, input } = await createAndLoad(REGRESSIONS, { onSelect });

      input.dispatchEvent(new Event('focus'));

      const items = container.querySelectorAll('li.combobox-item[role="option"]');
      (items[0] as HTMLElement).click();

      expect(onSelect).toHaveBeenCalledWith('uuid-1111', 'Compile time regression');
    });

    it('sets input value to title on selection', async () => {
      const { container, input } = await createAndLoad(REGRESSIONS);

      input.dispatchEvent(new Event('focus'));

      const items = container.querySelectorAll('li.combobox-item[role="option"]');
      (items[0] as HTMLElement).click();

      expect(input.value).toContain('Compile time regression');
    });

    it('closes dropdown on item click (aria-expanded="false")', async () => {
      const { container, input } = await createAndLoad(REGRESSIONS);

      input.dispatchEvent(new Event('focus'));

      const wrapper = container.querySelector('.combobox') as HTMLElement;
      expect(wrapper.getAttribute('aria-expanded')).toBe('true');

      const items = container.querySelectorAll('li.combobox-item[role="option"]');
      (items[0] as HTMLElement).click();

      expect(wrapper.getAttribute('aria-expanded')).toBe('false');
    });

    it('clears internal selectedUuid when user types after selecting', async () => {
      const { container, input, handle } = await createAndLoad(REGRESSIONS);

      // Select an item
      input.dispatchEvent(new Event('focus'));
      const items = container.querySelectorAll('li.combobox-item[role="option"]');
      (items[0] as HTMLElement).click();
      expect(handle.getValue()).toBe('uuid-1111');

      // User types in input — clears selection
      input.value = 'something else';
      input.dispatchEvent(new Event('input'));

      expect(handle.getValue()).toBe('');
    });
  });

  // --- Keyboard ---

  describe('Keyboard', () => {
    it('ArrowDown from input focuses first dropdown item', async () => {
      const { container, input } = await createAndLoad(REGRESSIONS);

      input.value = 'compile';
      input.dispatchEvent(new Event('input'));

      const dropdown = container.querySelector('ul') as HTMLElement;
      expect(dropdown.classList.contains('open')).toBe(true);

      const firstItem = dropdown.querySelector('li.combobox-item[tabindex]') as HTMLElement;
      const focusSpy = vi.spyOn(firstItem, 'focus');

      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      expect(focusSpy).toHaveBeenCalled();
    });

    it('ArrowDown/ArrowUp within dropdown moves focus', async () => {
      const { container, input } = await createAndLoad(REGRESSIONS);

      input.dispatchEvent(new Event('focus'));

      const items = container.querySelectorAll('li.combobox-item[tabindex]');
      const focusSpy0 = vi.spyOn(items[0] as HTMLElement, 'focus');
      const focusSpy1 = vi.spyOn(items[1] as HTMLElement, 'focus');

      // ArrowDown from first to second
      (items[0] as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(focusSpy1).toHaveBeenCalled();

      // ArrowUp from second back to first
      (items[1] as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      expect(focusSpy0).toHaveBeenCalled();
    });

    it('Enter on dropdown item selects it', async () => {
      const onSelect = vi.fn();
      const { container, input } = await createAndLoad(REGRESSIONS, { onSelect });

      input.dispatchEvent(new Event('focus'));

      const firstItem = container.querySelector('li.combobox-item[tabindex]') as HTMLElement;
      firstItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      expect(onSelect).toHaveBeenCalledWith('uuid-1111', 'Compile time regression');
    });

    it('Escape closes dropdown and returns focus to input', async () => {
      const { container, input } = await createAndLoad(REGRESSIONS);

      input.value = 'compile';
      input.dispatchEvent(new Event('input'));

      const dropdown = container.querySelector('ul') as HTMLElement;
      expect(dropdown.classList.contains('open')).toBe(true);

      // Escape from input closes dropdown (same pattern as machine-combobox)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(dropdown.classList.contains('open')).toBe(false);
    });
  });

  // --- Dismiss ---

  describe('Dismiss', () => {
    it('closes dropdown on blur (aria-expanded="false")', async () => {
      const { container, input } = await createAndLoad(REGRESSIONS);

      input.dispatchEvent(new Event('focus'));

      const wrapper = container.querySelector('.combobox') as HTMLElement;
      expect(wrapper.getAttribute('aria-expanded')).toBe('true');

      input.dispatchEvent(new Event('blur'));

      expect(wrapper.getAttribute('aria-expanded')).toBe('false');
    });

    it('keeps dropdown open when focus moves within wrapper (relatedTarget)', async () => {
      const { container, input } = await createAndLoad(REGRESSIONS);

      input.dispatchEvent(new Event('focus'));

      const dropdown = container.querySelector('ul') as HTMLElement;
      expect(dropdown.classList.contains('open')).toBe(true);

      const firstItem = dropdown.querySelector('li.combobox-item') as HTMLElement;
      input.dispatchEvent(new FocusEvent('blur', { relatedTarget: firstItem }));

      expect(dropdown.classList.contains('open')).toBe(true);
    });

    it('outside click closes dropdown', async () => {
      const { container, input } = await createAndLoad(REGRESSIONS);

      input.dispatchEvent(new Event('focus'));

      const wrapper = container.querySelector('.combobox') as HTMLElement;
      expect(wrapper.getAttribute('aria-expanded')).toBe('true');

      // Click outside
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(wrapper.getAttribute('aria-expanded')).toBe('false');
    });
  });

  // --- Lifecycle ---

  describe('Lifecycle', () => {
    it('onClear fires on blur-with-empty-input (via change event)', async () => {
      const onClear = vi.fn();
      const { input } = await createAndLoad(REGRESSIONS, { onClear });

      input.value = '';
      input.dispatchEvent(new Event('change'));
      expect(onClear).toHaveBeenCalled();
    });

    it('onClear does not throw when not provided', async () => {
      mockGetRegressions.mockResolvedValue({ items: [], next: null, previous: null });
      const container = document.createElement('div');
      document.body.append(container);
      renderRegressionCombobox(container, { testsuite: 'nts', onSelect: vi.fn() });
      await vi.advanceTimersByTimeAsync(0);

      const input = container.querySelector('input') as HTMLInputElement;
      input.value = '';
      expect(() => input.dispatchEvent(new Event('change'))).not.toThrow();
    });

    it('onClear does not fire when input has text on blur', async () => {
      const onClear = vi.fn();
      const { input } = await createAndLoad(REGRESSIONS, { onClear });

      input.value = 'some text';
      input.dispatchEvent(new Event('change'));
      expect(onClear).not.toHaveBeenCalled();
    });

    it('getValue() returns UUID after selection, empty string after clear()', async () => {
      const { container, input, handle } = await createAndLoad(REGRESSIONS);

      // Initially empty
      expect(handle.getValue()).toBe('');

      // Select an item
      input.dispatchEvent(new Event('focus'));
      const items = container.querySelectorAll('li.combobox-item[role="option"]');
      (items[0] as HTMLElement).click();
      expect(handle.getValue()).toBe('uuid-1111');

      // Clear
      handle.clear();
      expect(handle.getValue()).toBe('');
    });

    it('destroy() removes document click listener', async () => {
      const { handle } = await createAndLoad(REGRESSIONS);
      const spy = vi.spyOn(document, 'removeEventListener');
      handle.destroy();
      expect(spy).toHaveBeenCalledWith('click', expect.any(Function));
    });

    it('destroy() aborts in-flight fetch without errors', () => {
      mockGetRegressions.mockReturnValue(new Promise(() => {})); // never resolves
      const container = document.createElement('div');
      document.body.append(container);
      const handle = renderRegressionCombobox(container, { testsuite: 'nts', onSelect: vi.fn() });

      // Should not throw even though fetch is in-flight
      expect(() => handle.destroy()).not.toThrow();
    });

    it('clear() resets input and selection', async () => {
      const { container, input, handle } = await createAndLoad(REGRESSIONS);

      // Select an item
      input.dispatchEvent(new Event('focus'));
      const items = container.querySelectorAll('li.combobox-item[role="option"]');
      (items[0] as HTMLElement).click();
      expect(input.value).not.toBe('');

      handle.clear();
      expect(input.value).toBe('');
      expect(handle.getValue()).toBe('');
      expect(input.classList.contains('combobox-invalid')).toBe(false);
    });
  });
});
