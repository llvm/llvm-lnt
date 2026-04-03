// components/order-search.ts — Order search with tag-based autocomplete.

import { el, debounce, primaryOrderValue } from '../utils';
import { searchOrdersByTag } from '../api';
import { navigate } from '../router';

export interface OrderSuggestion {
  orderValue: string;
  tag: string | null;
}

export interface OrderSearchOptions {
  testsuite: string;
  placeholder?: string;
  /** If provided, called instead of navigating to Order Detail. */
  onSelect?: (orderValue: string) => void;
  /** Pre-loaded suggestions shown on focus. Tagged orders should come first. */
  suggestions?: OrderSuggestion[];
}

let orderSearchCounter = 0;

/**
 * Render an order search input with autocomplete dropdown.
 *
 * - If suggestions are provided, shows them on focus (filtered by input text)
 * - Otherwise, typing triggers a debounced tag_prefix search via the API
 * - Enter selects the current input value directly
 * - Clicking a dropdown item selects that order
 */
export function renderOrderSearch(
  container: HTMLElement,
  options: OrderSearchOptions,
): { destroy: () => void; setSuggestions: (s: OrderSuggestion[]) => void } {
  const dropdownId = `order-search-list-${++orderSearchCounter}`;
  const wrapper = el('div', {
    class: 'order-search',
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-haspopup': 'listbox',
  });
  const input = el('input', {
    type: 'text',
    class: 'order-search-input combobox-input',
    placeholder: options.placeholder || 'Search by order value or tag...',
    role: 'searchbox',
    'aria-autocomplete': 'list',
    'aria-controls': dropdownId,
  }) as HTMLInputElement;
  const dropdown = el('ul', { class: 'order-search-dropdown combobox-dropdown', role: 'listbox', id: dropdownId });
  wrapper.append(input, dropdown);
  container.append(wrapper);

  // Prevent dropdown clicks from blurring the input
  dropdown.addEventListener('mousedown', (e) => e.preventDefault());

  let abortCtrl: AbortController | null = null;
  let suggestions: OrderSuggestion[] = options.suggestions || [];
  // When suggestions are explicitly provided (even as []), use suggestions mode:
  // only show from the suggestions list, never fall back to API search.
  const useSuggestionsMode = options.suggestions !== undefined;

  function selectOrder(value: string): void {
    input.value = '';
    dropdown.classList.remove('open');
    wrapper.setAttribute('aria-expanded', 'false');
    if (options.onSelect) {
      options.onSelect(value);
    } else {
      navigate(`/orders/${encodeURIComponent(value)}`);
    }
  }

  function showSuggestions(): void {
    const text = input.value.trim().toLowerCase();
    const filtered = text
      ? suggestions.filter(s =>
          s.orderValue.toLowerCase().startsWith(text) ||
          (s.tag && s.tag.toLowerCase().startsWith(text)))
      : suggestions;

    dropdown.replaceChildren();
    if (filtered.length === 0) {
      dropdown.classList.remove('open');
      wrapper.setAttribute('aria-expanded', 'false');
      return;
    }
    for (const s of filtered) {
      const li = el('li', { class: 'combobox-item', tabindex: '-1' });
      li.append(el('span', {}, s.orderValue));
      if (s.tag) {
        li.append(el('span', { class: 'order-search-tag' }, ` (${s.tag})`));
      }
      li.addEventListener('click', () => selectOrder(s.orderValue));
      dropdown.append(li);
    }
    dropdown.classList.add('open');
    wrapper.setAttribute('aria-expanded', 'true');
  }

  // API-based search (fallback when no suggestions)
  const doApiSearch = debounce(async () => {
    const text = input.value.trim();
    if (!text) {
      dropdown.classList.remove('open');
      wrapper.setAttribute('aria-expanded', 'false');
      return;
    }
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();
    try {
      const result = await searchOrdersByTag(
        options.testsuite, text, { limit: 10 }, abortCtrl.signal,
      );
      dropdown.replaceChildren();
      if (result.items.length === 0) {
        dropdown.classList.remove('open');
        wrapper.setAttribute('aria-expanded', 'false');
        return;
      }
      for (const order of result.items) {
        const pv = primaryOrderValue(order.fields);
        const li = el('li', { class: 'combobox-item', tabindex: '-1' });
        li.append(el('span', {}, pv));
        if (order.tag) {
          li.append(el('span', { class: 'order-search-tag' }, ` (${order.tag})`));
        }
        li.addEventListener('click', () => selectOrder(pv));
        dropdown.append(li);
      }
      dropdown.classList.add('open');
      wrapper.setAttribute('aria-expanded', 'true');
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
    }
  }, 300);

  function isValidOrder(value: string): boolean {
    if (!useSuggestionsMode) return true;
    return suggestions.some(s => s.orderValue === value);
  }

  function updateValidationState(): void {
    const text = input.value.trim();
    if (!text || !useSuggestionsMode) {
      input.classList.remove('order-search-invalid');
    } else {
      // Only show invalid when there are no partial matches (dropdown is empty)
      const hasMatches = suggestions.some(s =>
        s.orderValue.toLowerCase().startsWith(text.toLowerCase()) ||
        (s.tag && s.tag.toLowerCase().startsWith(text.toLowerCase())));
      if (hasMatches) {
        input.classList.remove('order-search-invalid');
      } else {
        input.classList.add('order-search-invalid');
      }
    }
  }

  input.addEventListener('input', () => {
    if (useSuggestionsMode) {
      showSuggestions();
      updateValidationState();
    } else {
      (doApiSearch as EventListener)(new Event('input'));
    }
  });

  input.addEventListener('focus', () => {
    if (useSuggestionsMode) {
      showSuggestions();
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const first = dropdown.querySelector<HTMLElement>('.combobox-item');
      if (first) first.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const text = input.value.trim();
      if (text && isValidOrder(text)) selectOrder(text);
    } else if (e.key === 'Escape') {
      dropdown.classList.remove('open');
      wrapper.setAttribute('aria-expanded', 'false');
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
      wrapper.setAttribute('aria-expanded', 'false');
      input.focus();
    }
  });

  // Close dropdown when clicking outside
  function onDocClick(e: MouseEvent): void {
    if (!wrapper.contains(e.target as Node)) {
      dropdown.classList.remove('open');
      wrapper.setAttribute('aria-expanded', 'false');
    }
  }
  document.addEventListener('click', onDocClick);

  return {
    destroy() {
      document.removeEventListener('click', onDocClick);
      if (abortCtrl) abortCtrl.abort();
    },
    setSuggestions(s: OrderSuggestion[]) {
      suggestions = s;
    },
  };
}
