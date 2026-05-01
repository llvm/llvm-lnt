// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCombobox, type ComboboxItem, type ComboboxOptions } from '../components/combobox';

const ITEMS: ComboboxItem[] = [
  { value: 'alpha', display: 'Alpha' },
  { value: 'beta', display: 'Beta' },
  { value: 'gamma', display: 'Gamma' },
];

function makeOpts(overrides?: Partial<ComboboxOptions>): ComboboxOptions {
  return {
    id: 'test',
    placeholder: 'Search...',
    getItems: (filter) => {
      if (!filter.trim()) return ITEMS;
      return ITEMS.filter(i => i.display.toLowerCase().includes(filter.toLowerCase()));
    },
    onSelect: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createCombobox', () => {
  // --- DOM structure & ARIA ---

  describe('DOM structure & ARIA', () => {
    it('renders wrapper with role=combobox', () => {
      const handle = createCombobox(makeOpts());
      expect(handle.element.getAttribute('role')).toBe('combobox');
      expect(handle.element.getAttribute('aria-expanded')).toBe('false');
      expect(handle.element.getAttribute('aria-haspopup')).toBe('listbox');
    });

    it('renders input with role=searchbox', () => {
      const handle = createCombobox(makeOpts());
      expect(handle.input.getAttribute('role')).toBe('searchbox');
      expect(handle.input.getAttribute('aria-autocomplete')).toBe('list');
    });

    it('input aria-controls matches dropdown id', () => {
      const handle = createCombobox(makeOpts());
      document.body.append(handle.element);
      const dropdown = handle.element.querySelector('ul') as HTMLElement;
      expect(handle.input.getAttribute('aria-controls')).toBe(dropdown.id);
    });

    it('dropdown has role=listbox', () => {
      const handle = createCombobox(makeOpts());
      document.body.append(handle.element);
      const dropdown = handle.element.querySelector('ul') as HTMLElement;
      expect(dropdown.getAttribute('role')).toBe('listbox');
    });

    it('dropdown items have role=option', () => {
      const handle = createCombobox(makeOpts());
      document.body.append(handle.element);
      handle.input.dispatchEvent(new Event('focus'));
      const items = handle.element.querySelectorAll('li.combobox-item');
      for (const li of items) {
        expect(li.getAttribute('role')).toBe('option');
      }
    });

    it('sets placeholder on input', () => {
      const handle = createCombobox(makeOpts({ placeholder: 'Custom placeholder' }));
      expect(handle.input.placeholder).toBe('Custom placeholder');
    });

    it('sets initial value on input', () => {
      const handle = createCombobox(makeOpts({ initialValue: 'Alpha' }));
      expect(handle.input.value).toBe('Alpha');
    });

    it('aria-expanded becomes true when dropdown opens', () => {
      const handle = createCombobox(makeOpts());
      document.body.append(handle.element);
      handle.input.dispatchEvent(new Event('focus'));
      expect(handle.element.getAttribute('aria-expanded')).toBe('true');
    });
  });

  // --- Dropdown display ---

  describe('Dropdown display', () => {
    it('shows all items on focus', () => {
      const handle = createCombobox(makeOpts());
      document.body.append(handle.element);
      handle.input.dispatchEvent(new Event('focus'));
      const items = handle.element.querySelectorAll('li.combobox-item');
      expect(items).toHaveLength(3);
    });

    it('filters items on input', () => {
      const handle = createCombobox(makeOpts());
      document.body.append(handle.element);
      handle.input.value = 'alp';
      handle.input.dispatchEvent(new Event('input'));
      const items = handle.element.querySelectorAll('li.combobox-item');
      expect(items).toHaveLength(1);
      expect(items[0].textContent).toBe('Alpha');
    });

    it('caps items at maxItems', () => {
      const manyItems = Array.from({ length: 150 }, (_, i) => ({
        value: String(i),
        display: `Item ${i}`,
      }));
      const handle = createCombobox(makeOpts({
        getItems: () => manyItems,
        maxItems: 50,
      }));
      document.body.append(handle.element);
      handle.input.dispatchEvent(new Event('focus'));
      const items = handle.element.querySelectorAll('li.combobox-item');
      expect(items).toHaveLength(50);
    });

    it('defaults maxItems to 100', () => {
      const manyItems = Array.from({ length: 150 }, (_, i) => ({
        value: String(i),
        display: `Item ${i}`,
      }));
      const handle = createCombobox(makeOpts({ getItems: () => manyItems }));
      document.body.append(handle.element);
      handle.input.dispatchEvent(new Event('focus'));
      const items = handle.element.querySelectorAll('li.combobox-item');
      expect(items).toHaveLength(100);
    });
  });

  // --- Selection ---

  describe('Selection', () => {
    it('calls onSelect with item on click', () => {
      const onSelect = vi.fn();
      const handle = createCombobox(makeOpts({ onSelect }));
      document.body.append(handle.element);
      handle.input.dispatchEvent(new Event('focus'));
      const item = handle.element.querySelector('li.combobox-item') as HTMLElement;
      item.click();
      expect(onSelect).toHaveBeenCalledWith(ITEMS[0]);
    });

    it('sets input value on click', () => {
      const handle = createCombobox(makeOpts());
      document.body.append(handle.element);
      handle.input.dispatchEvent(new Event('focus'));
      const item = handle.element.querySelector('li.combobox-item') as HTMLElement;
      item.click();
      expect(handle.input.value).toBe('Alpha');
    });

    it('closes dropdown on click', () => {
      const handle = createCombobox(makeOpts());
      document.body.append(handle.element);
      handle.input.dispatchEvent(new Event('focus'));
      const item = handle.element.querySelector('li.combobox-item') as HTMLElement;
      item.click();
      const dropdown = handle.element.querySelector('ul') as HTMLElement;
      expect(dropdown.classList.contains('open')).toBe(false);
      expect(handle.element.getAttribute('aria-expanded')).toBe('false');
    });
  });

  // --- Keyboard ---

  describe('Keyboard', () => {
    it('ArrowDown from input focuses first item', () => {
      const handle = createCombobox(makeOpts());
      document.body.append(handle.element);
      handle.input.dispatchEvent(new Event('focus'));
      const firstItem = handle.element.querySelector('li.combobox-item') as HTMLElement;
      const focusSpy = vi.spyOn(firstItem, 'focus');
      handle.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      expect(focusSpy).toHaveBeenCalled();
    });

    it('ArrowDown/ArrowUp within dropdown moves focus', () => {
      const handle = createCombobox(makeOpts());
      document.body.append(handle.element);
      handle.input.dispatchEvent(new Event('focus'));
      const items = handle.element.querySelectorAll('li.combobox-item');
      const spy1 = vi.spyOn(items[1] as HTMLElement, 'focus');
      const spy0 = vi.spyOn(items[0] as HTMLElement, 'focus');
      (items[0] as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(spy1).toHaveBeenCalled();
      (items[1] as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      expect(spy0).toHaveBeenCalled();
    });

    it('ArrowUp from first item returns focus to input', () => {
      const handle = createCombobox(makeOpts());
      document.body.append(handle.element);
      handle.input.dispatchEvent(new Event('focus'));
      const firstItem = handle.element.querySelector('li.combobox-item') as HTMLElement;
      const inputSpy = vi.spyOn(handle.input, 'focus');
      firstItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      expect(inputSpy).toHaveBeenCalled();
    });

    it('Enter on dropdown item selects it', () => {
      const onSelect = vi.fn();
      const handle = createCombobox(makeOpts({ onSelect }));
      document.body.append(handle.element);
      handle.input.dispatchEvent(new Event('focus'));
      const firstItem = handle.element.querySelector('li.combobox-item') as HTMLElement;
      firstItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(onSelect).toHaveBeenCalledWith(ITEMS[0]);
    });

    it('Escape closes dropdown from input', () => {
      const handle = createCombobox(makeOpts());
      document.body.append(handle.element);
      handle.input.dispatchEvent(new Event('focus'));
      handle.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      const dropdown = handle.element.querySelector('ul') as HTMLElement;
      expect(dropdown.classList.contains('open')).toBe(false);
    });

    it('Escape from dropdown item closes and returns focus to input', () => {
      const handle = createCombobox(makeOpts());
      document.body.append(handle.element);
      handle.input.dispatchEvent(new Event('focus'));
      const firstItem = handle.element.querySelector('li.combobox-item') as HTMLElement;
      const inputSpy = vi.spyOn(handle.input, 'focus');
      firstItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(inputSpy).toHaveBeenCalled();
      const dropdown = handle.element.querySelector('ul') as HTMLElement;
      expect(dropdown.classList.contains('open')).toBe(false);
    });

    it('keeps dropdown open when ArrowDown moves focus to item', () => {
      const handle = createCombobox(makeOpts());
      document.body.append(handle.element);
      handle.input.dispatchEvent(new Event('focus'));
      const dropdown = handle.element.querySelector('ul') as HTMLElement;
      expect(dropdown.classList.contains('open')).toBe(true);
      const firstItem = dropdown.querySelector('li.combobox-item') as HTMLElement;
      handle.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      handle.input.dispatchEvent(new FocusEvent('blur', { relatedTarget: firstItem }));
      expect(dropdown.classList.contains('open')).toBe(true);
    });
  });

  // --- onEnter ---

  describe('onEnter', () => {
    it('calls onEnter on Enter key in input', () => {
      const onEnter = vi.fn().mockReturnValue(true);
      const handle = createCombobox(makeOpts({ onEnter }));
      document.body.append(handle.element);
      handle.input.value = 'Alpha';
      handle.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(onEnter).toHaveBeenCalledWith('Alpha');
    });

    it('closes dropdown when onEnter returns true', () => {
      const onEnter = vi.fn().mockReturnValue(true);
      const handle = createCombobox(makeOpts({ onEnter }));
      document.body.append(handle.element);
      handle.input.dispatchEvent(new Event('focus'));
      handle.input.value = 'Alpha';
      handle.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      const dropdown = handle.element.querySelector('ul') as HTMLElement;
      expect(dropdown.classList.contains('open')).toBe(false);
    });

    it('shows invalid halo when onEnter returns false', () => {
      const onEnter = vi.fn().mockReturnValue(false);
      const handle = createCombobox(makeOpts({ onEnter }));
      document.body.append(handle.element);
      handle.input.value = 'bad';
      handle.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(handle.input.classList.contains('combobox-invalid')).toBe(true);
    });

    it('does nothing on Enter when input is empty', () => {
      const onEnter = vi.fn().mockReturnValue(true);
      const handle = createCombobox(makeOpts({ onEnter }));
      document.body.append(handle.element);
      handle.input.value = '';
      handle.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(onEnter).not.toHaveBeenCalled();
    });

    it('does nothing on Enter when no onEnter callback', () => {
      const onSelect = vi.fn();
      const handle = createCombobox(makeOpts({ onSelect }));
      document.body.append(handle.element);
      handle.input.value = 'Alpha';
      handle.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(onSelect).not.toHaveBeenCalled();
    });
  });

  // --- Validation halo ---

  describe('Validation halo', () => {
    it('shows combobox-invalid when no items match', () => {
      const handle = createCombobox(makeOpts());
      document.body.append(handle.element);
      handle.input.value = 'zzz-no-match';
      handle.input.dispatchEvent(new Event('input'));
      expect(handle.input.classList.contains('combobox-invalid')).toBe(true);
    });

    it('removes combobox-invalid when items match again', () => {
      const handle = createCombobox(makeOpts());
      document.body.append(handle.element);
      handle.input.value = 'zzz';
      handle.input.dispatchEvent(new Event('input'));
      expect(handle.input.classList.contains('combobox-invalid')).toBe(true);
      handle.input.value = 'alp';
      handle.input.dispatchEvent(new Event('input'));
      expect(handle.input.classList.contains('combobox-invalid')).toBe(false);
    });

    it('no combobox-invalid when input is empty', () => {
      const handle = createCombobox(makeOpts());
      document.body.append(handle.element);
      handle.input.value = '';
      handle.input.dispatchEvent(new Event('input'));
      expect(handle.input.classList.contains('combobox-invalid')).toBe(false);
    });

    it('removes combobox-invalid on item click', () => {
      const handle = createCombobox(makeOpts());
      document.body.append(handle.element);
      handle.input.classList.add('combobox-invalid');
      handle.input.dispatchEvent(new Event('focus'));
      const item = handle.element.querySelector('li.combobox-item') as HTMLElement;
      item.click();
      expect(handle.input.classList.contains('combobox-invalid')).toBe(false);
    });
  });

  // --- Status ---

  describe('Status', () => {
    it('shows status message instead of items', () => {
      const handle = createCombobox(makeOpts({
        getStatus: () => ({ text: 'Loading...' }),
      }));
      document.body.append(handle.element);
      handle.input.dispatchEvent(new Event('focus'));
      const items = handle.element.querySelectorAll('li');
      expect(items).toHaveLength(1);
      expect(items[0].textContent).toBe('Loading...');
      expect(items[0].classList.contains('combobox-status')).toBe(true);
    });

    it('shows error status with error class', () => {
      const handle = createCombobox(makeOpts({
        getStatus: () => ({ text: 'Failed to load', isError: true }),
      }));
      document.body.append(handle.element);
      handle.input.dispatchEvent(new Event('focus'));
      const items = handle.element.querySelectorAll('li');
      expect(items[0].classList.contains('combobox-status-error')).toBe(true);
    });

    it('shows items when getStatus returns null', () => {
      const handle = createCombobox(makeOpts({
        getStatus: () => null,
      }));
      document.body.append(handle.element);
      handle.input.dispatchEvent(new Event('focus'));
      const items = handle.element.querySelectorAll('li.combobox-item');
      expect(items).toHaveLength(3);
    });

    it('removes combobox-invalid when status is showing', () => {
      const handle = createCombobox(makeOpts({
        getStatus: () => ({ text: 'Loading...' }),
      }));
      document.body.append(handle.element);
      handle.input.classList.add('combobox-invalid');
      handle.input.dispatchEvent(new Event('focus'));
      expect(handle.input.classList.contains('combobox-invalid')).toBe(false);
    });
  });

  // --- Dismiss ---

  describe('Dismiss', () => {
    it('closes dropdown on blur', () => {
      const handle = createCombobox(makeOpts());
      document.body.append(handle.element);
      handle.input.dispatchEvent(new Event('focus'));
      expect(handle.element.querySelector('.combobox-dropdown.open')).toBeTruthy();
      handle.input.dispatchEvent(new Event('blur'));
      expect(handle.element.querySelector('.combobox-dropdown.open')).toBeNull();
    });

    it('keeps dropdown open when focus moves within wrapper', () => {
      const handle = createCombobox(makeOpts());
      document.body.append(handle.element);
      handle.input.dispatchEvent(new Event('focus'));
      const firstItem = handle.element.querySelector('li.combobox-item') as HTMLElement;
      handle.input.dispatchEvent(new FocusEvent('blur', { relatedTarget: firstItem }));
      expect(handle.element.querySelector('.combobox-dropdown.open')).toBeTruthy();
    });

    it('outside click closes dropdown', () => {
      const handle = createCombobox(makeOpts());
      document.body.append(handle.element);
      handle.input.dispatchEvent(new Event('focus'));
      expect(handle.element.getAttribute('aria-expanded')).toBe('true');
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(handle.element.getAttribute('aria-expanded')).toBe('false');
    });
  });

  // --- onClear ---

  describe('onClear', () => {
    it('calls onClear on change with empty input', () => {
      const onClear = vi.fn();
      const handle = createCombobox(makeOpts({ onClear }));
      document.body.append(handle.element);
      handle.input.value = '';
      handle.input.dispatchEvent(new Event('change'));
      expect(onClear).toHaveBeenCalled();
    });

    it('does not call onClear when input has text', () => {
      const onClear = vi.fn();
      const handle = createCombobox(makeOpts({ onClear }));
      document.body.append(handle.element);
      handle.input.value = 'something';
      handle.input.dispatchEvent(new Event('change'));
      expect(onClear).not.toHaveBeenCalled();
    });

    it('does not throw when onClear is not provided', () => {
      const handle = createCombobox(makeOpts());
      document.body.append(handle.element);
      handle.input.value = '';
      expect(() => handle.input.dispatchEvent(new Event('change'))).not.toThrow();
    });
  });

  // --- Lifecycle ---

  describe('Lifecycle', () => {
    it('setValue updates the input value', () => {
      const handle = createCombobox(makeOpts());
      handle.setValue('New value');
      expect(handle.input.value).toBe('New value');
    });

    it('clear resets input and halo', () => {
      const handle = createCombobox(makeOpts());
      document.body.append(handle.element);
      handle.input.value = 'something';
      handle.input.classList.add('combobox-invalid');
      handle.clear();
      expect(handle.input.value).toBe('');
      expect(handle.input.classList.contains('combobox-invalid')).toBe(false);
    });

    it('destroy removes document click listener', () => {
      const handle = createCombobox(makeOpts());
      document.body.append(handle.element);
      const spy = vi.spyOn(document, 'removeEventListener');
      handle.destroy();
      expect(spy).toHaveBeenCalledWith('click', expect.any(Function));
    });
  });
});
