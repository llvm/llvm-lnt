// components/regression-combobox.ts — Standalone regression typeahead selector.
//
// Follows the same fetch-once, filter-locally pattern as machine-combobox.ts.
// Fetches all regressions (limit 500) on creation, caches them in the
// component instance, and filters client-side on every keystroke using
// matchesFilter (same substring/regex matching as everywhere else).

import { el, truncate, matchesFilter, updateFilterValidation } from '../utils';
import { getRegressions } from '../api';
import type { RegressionListItem } from '../types';

export interface RegressionComboboxOptions {
  testsuite: string;
  onSelect: (uuid: string, title: string | null) => void;
  /** Called when the user clears the selection (blur with empty input). */
  onClear?: () => void;
}

let comboboxCounter = 0;

function setAriaExpanded(wrapper: HTMLElement, expanded: boolean): void {
  wrapper.setAttribute('aria-expanded', String(expanded));
}

/**
 * Render a regression combobox with local filtering.
 * Fetches the full regression list once on creation; filters locally on each keystroke.
 */
export function renderRegressionCombobox(
  container: HTMLElement,
  opts: RegressionComboboxOptions,
): { destroy: () => void; getValue: () => string; clear: () => void } {
  const dropdownId = `regression-combo-list-${++comboboxCounter}`;
  const wrapper = el('div', {
    class: 'combobox',
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-haspopup': 'listbox',
  });
  const input = el('input', {
    type: 'text',
    class: 'combobox-input',
    placeholder: 'Type to search regressions...',
    autocomplete: 'off',
    role: 'searchbox',
    'aria-autocomplete': 'list',
    'aria-controls': dropdownId,
  }) as HTMLInputElement;

  const dropdown = el('ul', { class: 'combobox-dropdown', role: 'listbox', id: dropdownId });
  wrapper.append(input, dropdown);
  container.append(wrapper);

  // Prevent dropdown clicks from blurring the input
  dropdown.addEventListener('mousedown', (e) => e.preventDefault());

  let abortCtrl: AbortController | null = null;
  let selectedUuid = '';
  let regressions: RegressionListItem[] | null = null; // null = still loading
  let fetchError = false;

  function displayText(r: RegressionListItem): string {
    return truncate(r.title || `(untitled) ${r.uuid.slice(0, 8)}`, 60);
  }

  // Fetch the full regression list once (skip if no testsuite)
  if (opts.testsuite) {
    abortCtrl = new AbortController();
    getRegressions(opts.testsuite, { limit: 500 }, abortCtrl.signal)
      .then((result) => {
        regressions = result.items;
        // If the input has focus, refresh the dropdown with the loaded data
        if (document.activeElement === input) {
          showDropdown(input.value);
        }
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        fetchError = true;
        regressions = [];
        // If the input has focus, show the error in the dropdown
        if (document.activeElement === input) {
          showDropdown(input.value);
        }
      });
  } else {
    input.disabled = true;
    input.placeholder = 'Select a suite first';
  }

  function showDropdown(filter: string): void {
    dropdown.replaceChildren();

    const statusMsg = fetchError
      ? 'Failed to load regressions'
      : regressions === null
        ? 'Loading regressions...'
        : regressions.length === 0
          ? 'No regressions found'
          : null;

    if (statusMsg !== null) {
      const cls = fetchError ? 'combobox-item combobox-status-error' : 'combobox-item combobox-status';
      dropdown.replaceChildren(el('li', { class: cls }, statusMsg));
      dropdown.classList.add('open');
      setAriaExpanded(wrapper, true);
      input.classList.remove('combobox-invalid');
      return;
    }

    // At this point regressions is non-null and non-empty (status cases handled above)
    const items = regressions!;
    const matches = filter.trim()
      ? items.filter(r => matchesFilter(r.title || '', filter))
      : items;

    for (const r of matches) {
      const text = displayText(r);
      const li = el('li', { class: 'combobox-item', role: 'option', tabindex: '-1' }, text);
      li.addEventListener('click', () => {
        input.value = text;
        selectedUuid = r.uuid;
        input.classList.remove('combobox-invalid');
        dropdown.classList.remove('open');
        setAriaExpanded(wrapper, false);
        opts.onSelect(r.uuid, r.title);
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
    // Clear selection when user types (prevents stale UUID submission)
    selectedUuid = '';
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
    if (!input.value.trim()) {
      input.classList.remove('combobox-invalid');
      selectedUuid = '';
      if (opts.onClear) opts.onClear();
    }
  });

  // Keyboard navigation
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const first = dropdown.querySelector<HTMLElement>('.combobox-item[tabindex]');
      if (first) first.focus();
    } else if (e.key === 'Escape') {
      dropdown.classList.remove('open');
      setAriaExpanded(wrapper, false);
    }
    // Enter on input is a no-op — user must select from the list
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
      return selectedUuid;
    },
    clear() {
      input.value = '';
      selectedUuid = '';
      input.classList.remove('combobox-invalid');
      dropdown.classList.remove('open');
      setAriaExpanded(wrapper, false);
    },
  };
}
