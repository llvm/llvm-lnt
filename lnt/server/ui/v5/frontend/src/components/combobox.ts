// components/combobox.ts — Generic combobox base.
//
// Handles DOM structure, ARIA attributes, keyboard navigation,
// blur/outside-click dismiss, and validation halo. Specialized
// comboboxes (machine, commit, regression) are thin wrappers.

import { el, updateFilterValidation } from '../utils';

export interface ComboboxItem {
  value: string;
  display: string;
}

export interface ComboboxStatus {
  text: string;
  isError?: boolean;
}

export interface ComboboxOptions {
  id: string;
  placeholder?: string;
  initialValue?: string;
  getItems: (filter: string) => ComboboxItem[];
  onSelect: (item: ComboboxItem) => void;
  onEnter?: (text: string) => boolean;
  onClear?: () => void;
  getStatus?: () => ComboboxStatus | null;
  maxItems?: number;
}

export interface ComboboxHandle {
  element: HTMLElement;
  input: HTMLInputElement;
  setValue: (display: string) => void;
  clear: () => void;
  destroy: () => void;
}

let comboboxCounter = 0;

export function createCombobox(opts: ComboboxOptions): ComboboxHandle {
  const dropdownId = `combobox-list-${opts.id}-${++comboboxCounter}`;
  const maxItems = opts.maxItems ?? 100;

  const wrapper = el('div', {
    class: 'combobox',
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-haspopup': 'listbox',
  });
  const input = el('input', {
    type: 'text',
    class: 'combobox-input',
    placeholder: opts.placeholder ?? '',
    autocomplete: 'off',
    role: 'searchbox',
    'aria-autocomplete': 'list',
    'aria-controls': dropdownId,
  }) as HTMLInputElement;
  if (opts.initialValue) input.value = opts.initialValue;

  const dropdown = el('ul', { class: 'combobox-dropdown', role: 'listbox', id: dropdownId });
  wrapper.append(input, dropdown);

  dropdown.addEventListener('mousedown', (e) => e.preventDefault());

  function setExpanded(expanded: boolean): void {
    wrapper.setAttribute('aria-expanded', String(expanded));
  }

  function closeDropdown(): void {
    dropdown.classList.remove('open');
    setExpanded(false);
  }

  function showDropdown(filter: string): void {
    dropdown.replaceChildren();

    if (opts.getStatus) {
      const status = opts.getStatus();
      if (status !== null) {
        const cls = status.isError ? 'combobox-item combobox-status-error' : 'combobox-item combobox-status';
        dropdown.replaceChildren(el('li', { class: cls }, status.text));
        dropdown.classList.add('open');
        setExpanded(true);
        input.classList.remove('combobox-invalid');
        return;
      }
    }

    const allItems = opts.getItems(filter);
    const limited = allItems.slice(0, maxItems);

    for (const item of limited) {
      const li = el('li', { class: 'combobox-item', role: 'option', tabindex: '-1' }, item.display);
      li.addEventListener('click', () => {
        input.value = item.display;
        input.classList.remove('combobox-invalid');
        closeDropdown();
        opts.onSelect(item);
      });
      dropdown.append(li);
    }

    const isOpen = limited.length > 0;
    dropdown.classList.toggle('open', isOpen);
    setExpanded(isOpen);

    if (input.value.trim() && allItems.length === 0) {
      input.classList.add('combobox-invalid');
    } else {
      input.classList.remove('combobox-invalid');
    }
  }

  // -- Keyboard navigation --

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const first = dropdown.querySelector<HTMLElement>('li[tabindex]');
      if (first) first.focus();
    } else if (e.key === 'Escape') {
      closeDropdown();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (opts.onEnter) {
        const text = input.value.trim();
        if (!text) return;
        const accepted = opts.onEnter(text);
        if (accepted) {
          closeDropdown();
        } else {
          input.classList.add('combobox-invalid');
        }
      }
    }
  });

  dropdown.addEventListener('keydown', (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName !== 'LI') return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = target.nextElementSibling as HTMLElement | null;
      if (next) next.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = target.previousElementSibling as HTMLElement | null;
      if (prev) prev.focus();
      else input.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      target.click();
    } else if (e.key === 'Escape') {
      closeDropdown();
      suppressNextFocus = true;
      input.focus();
    }
  });

  // -- Open/filter --

  let suppressNextFocus = false;

  input.addEventListener('input', () => {
    updateFilterValidation(input);
    showDropdown(input.value);
  });
  input.addEventListener('focus', () => {
    if (suppressNextFocus) { suppressNextFocus = false; return; }
    if (!dropdown.classList.contains('open')) {
      showDropdown(input.value);
    }
  });

  // -- Dismiss --

  input.addEventListener('blur', (e: FocusEvent) => {
    if (wrapper.contains(e.relatedTarget as Node)) return;
    closeDropdown();
  });

  input.addEventListener('change', () => {
    if (!input.value.trim() && opts.onClear) {
      input.classList.remove('combobox-invalid');
      opts.onClear();
    }
  });

  function onDocClick(e: MouseEvent): void {
    if (!wrapper.contains(e.target as Node)) {
      closeDropdown();
    }
  }
  document.addEventListener('click', onDocClick);

  return {
    element: wrapper,
    input,
    setValue(display: string) {
      input.value = display;
    },
    clear() {
      input.value = '';
      input.classList.remove('combobox-invalid');
      closeDropdown();
    },
    destroy() {
      document.removeEventListener('click', onDocClick);
    },
  };
}
