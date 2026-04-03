// components/machine-combobox.ts — Standalone machine typeahead selector.

import { el, debounce } from '../utils';
import { getMachines } from '../api';

export interface MachineComboboxOptions {
  testsuite: string;
  initialValue?: string;
  onSelect: (name: string) => void;
}

let comboboxCounter = 0;

function setAriaExpanded(wrapper: HTMLElement, expanded: boolean): void {
  wrapper.setAttribute('aria-expanded', String(expanded));
}

/**
 * Render a machine name combobox with typeahead search.
 * Calls getMachines with namePrefix on each keystroke (debounced 300ms).
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

  const doSearch = debounce(async () => {
    const text = input.value.trim();
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();
    try {
      const result = await getMachines(opts.testsuite, {
        namePrefix: text || undefined, limit: 20,
      }, abortCtrl.signal);
      dropdown.replaceChildren();
      if (result.items.length === 0) {
        dropdown.classList.remove('open');
        setAriaExpanded(wrapper, false);
        return;
      }
      for (const machine of result.items) {
        const li = el('li', { class: 'combobox-item', tabindex: '-1' }, machine.name);
        li.addEventListener('click', () => {
          input.value = machine.name;
          selectedValue = machine.name;
          dropdown.classList.remove('open');
          setAriaExpanded(wrapper, false);
          opts.onSelect(machine.name);
        });
        dropdown.append(li);
      }
      dropdown.classList.add('open');
      setAriaExpanded(wrapper, true);
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
    }
  }, 300);

  input.addEventListener('input', doSearch as EventListener);
  input.addEventListener('focus', () => {
    if (!input.value.trim() && !dropdown.classList.contains('open')) {
      doSearch();
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
      if (text) {
        selectedValue = text;
        dropdown.classList.remove('open');
        setAriaExpanded(wrapper, false);
        opts.onSelect(text);
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
      dropdown.classList.remove('open');
      setAriaExpanded(wrapper, false);
    },
  };
}
