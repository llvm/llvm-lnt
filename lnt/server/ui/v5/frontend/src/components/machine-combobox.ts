// components/machine-combobox.ts — Standalone machine typeahead selector.

import { el, matchesFilter, updateFilterValidation } from '../utils';
import { getMachines } from '../api';
import type { MachineInfo } from '../types';

export interface MachineComboboxOptions {
  testsuite: string;
  initialValue?: string;
  onSelect: (name: string) => void;
  /** Called when the user clears the input and blurs (change event with empty text). */
  onClear?: () => void;
}

let comboboxCounter = 0;

function setAriaExpanded(wrapper: HTMLElement, expanded: boolean): void {
  wrapper.setAttribute('aria-expanded', String(expanded));
}

/**
 * Render a machine name combobox with local filtering.
 * Fetches the full machine list once on creation; filters locally on each keystroke.
 */
export function renderMachineCombobox(
  container: HTMLElement,
  opts: MachineComboboxOptions,
): { destroy: () => void; getValue: () => string; clear: () => void } {
  const dropdownId = `machine-combo-list-${++comboboxCounter}`;
  const wrapper = el('div', {
    class: 'combobox',
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-haspopup': 'listbox',
  });
  const input = el('input', {
    type: 'text',
    class: 'combobox-input',
    placeholder: 'Type to search machines...',
    autocomplete: 'off',
    role: 'searchbox',
    'aria-autocomplete': 'list',
    'aria-controls': dropdownId,
  }) as HTMLInputElement;
  if (opts.initialValue) input.value = opts.initialValue;

  const dropdown = el('ul', { class: 'combobox-dropdown', role: 'listbox', id: dropdownId });
  wrapper.append(input, dropdown);
  container.append(wrapper);

  // Prevent dropdown clicks from blurring the input
  dropdown.addEventListener('mousedown', (e) => e.preventDefault());

  let abortCtrl: AbortController | null = null;
  let selectedValue = opts.initialValue || '';
  let machines: MachineInfo[] | null = null; // null = still loading

  // Fetch the full machine list once (skip if no testsuite yet)
  if (opts.testsuite) {
    abortCtrl = new AbortController();
    getMachines(opts.testsuite, { limit: 500 }, abortCtrl.signal)
      .then((result) => {
        machines = result.items;
        // If the input has focus, refresh the dropdown with the loaded data
        if (document.activeElement === input) {
          showDropdown(input.value);
        }
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
      });
  } else {
    input.disabled = true;
    input.placeholder = 'Select a suite first';
  }

  function showDropdown(filter: string): void {
    dropdown.replaceChildren();

    // Still loading — show hint
    if (machines === null) {
      dropdown.replaceChildren(
        el('li', { class: 'combobox-item', style: 'color: #999; pointer-events: none' }, 'Loading machines...'),
      );
      dropdown.classList.add('open');
      setAriaExpanded(wrapper, true);
      input.classList.remove('combobox-invalid');
      return;
    }

    const matches = filter.trim()
      ? machines.filter(m => matchesFilter(m.name, filter))
      : machines;

    for (const machine of matches) {
      const li = el('li', { class: 'combobox-item', tabindex: '-1' }, machine.name);
      li.addEventListener('click', () => {
        input.value = machine.name;
        selectedValue = machine.name;
        input.classList.remove('combobox-invalid');
        dropdown.classList.remove('open');
        setAriaExpanded(wrapper, false);
        opts.onSelect(machine.name);
      });
      dropdown.append(li);
    }

    const isOpen = matches.length > 0;
    dropdown.classList.toggle('open', isOpen);
    setAriaExpanded(wrapper, isOpen);

    // Validation halo
    if (input.value.trim() && matches.length === 0) {
      input.classList.add('combobox-invalid');
    } else {
      input.classList.remove('combobox-invalid');
    }
  }

  input.addEventListener('input', () => {
    updateFilterValidation(input);
    showDropdown(input.value);
  });
  input.addEventListener('focus', () => {
    if (!dropdown.classList.contains('open')) {
      showDropdown(input.value);
    }
  });
  input.addEventListener('blur', (e: FocusEvent) => {
    if (wrapper.contains(e.relatedTarget as Node)) return;
    dropdown.classList.remove('open');
    setAriaExpanded(wrapper, false);
  });
  input.addEventListener('change', () => {
    if (!input.value.trim() && opts.onClear) {
      input.classList.remove('combobox-invalid');
      selectedValue = '';
      opts.onClear();
    }
  });

  // Keyboard navigation
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const first = dropdown.querySelector<HTMLElement>('.combobox-item');
      if (first) first.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      const hasItems = dropdown.querySelector('.combobox-item') !== null;
      if (hasItems) {
        selectedValue = text;
        input.classList.remove('combobox-invalid');
        dropdown.classList.remove('open');
        setAriaExpanded(wrapper, false);
        opts.onSelect(text);
      } else {
        input.classList.add('combobox-invalid');
      }
    } else if (e.key === 'Escape') {
      dropdown.classList.remove('open');
      setAriaExpanded(wrapper, false);
    }
  });

  dropdown.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
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
      dropdown.classList.remove('open');
      setAriaExpanded(wrapper, false);
      input.focus();
    }
  });

  function onDocClick(e: MouseEvent): void {
    if (!wrapper.contains(e.target as Node)) {
      dropdown.classList.remove('open');
      setAriaExpanded(wrapper, false);
    }
  }
  document.addEventListener('click', onDocClick);

  return {
    destroy() {
      document.removeEventListener('click', onDocClick);
      if (abortCtrl) abortCtrl.abort();
    },
    getValue() {
      return selectedValue;
    },
    clear() {
      input.value = '';
      selectedValue = '';
      input.classList.remove('combobox-invalid');
      dropdown.classList.remove('open');
      setAriaExpanded(wrapper, false);
    },
  };
}
