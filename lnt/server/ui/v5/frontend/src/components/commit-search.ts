// components/commit-search.ts — Commit search with prefix autocomplete.

import { el, debounce, commitDisplayValue } from '../utils';
import { searchCommits } from '../api';
import type { CommitSummary } from '../types';
import { navigate } from '../router';

export interface CommitSearchOptions {
  testsuite: string;
  placeholder?: string;
  /** If provided, called instead of navigating to Commit Detail. */
  onSelect?: (commitValue: string) => void;
  /** Pre-loaded suggestions shown on focus. Commits with ordinals should come first. */
  suggestions?: CommitSummary[];
  /** Schema commit_fields for display field resolution. */
  commitFields?: Array<{ name: string; display?: boolean }>;
}

let commitSearchCounter = 0;

/**
 * Render a commit search input with autocomplete dropdown.
 *
 * - If suggestions are provided, shows them on focus (filtered by input text)
 * - Otherwise, typing triggers a debounced search via the API
 * - Enter selects the current input value directly
 * - Clicking a dropdown item selects that commit
 */
export function renderCommitSearch(
  container: HTMLElement,
  options: CommitSearchOptions,
): { destroy: () => void; setSuggestions: (s: CommitSummary[]) => void } {
  const dropdownId = `commit-search-list-${++commitSearchCounter}`;
  const wrapper = el('div', {
    class: 'commit-search',
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-haspopup': 'listbox',
  });
  const input = el('input', {
    type: 'text',
    class: 'commit-search-input combobox-input',
    placeholder: options.placeholder || 'Search commits...',
    role: 'searchbox',
    'aria-autocomplete': 'list',
    'aria-controls': dropdownId,
  }) as HTMLInputElement;
  const dropdown = el('ul', { class: 'commit-search-dropdown combobox-dropdown', role: 'listbox', id: dropdownId });
  wrapper.append(input, dropdown);
  container.append(wrapper);

  // Prevent dropdown clicks from blurring the input
  dropdown.addEventListener('mousedown', (e) => e.preventDefault());

  let abortCtrl: AbortController | null = null;
  let suggestions: CommitSummary[] = options.suggestions || [];
  // When suggestions are explicitly provided (even as []), use suggestions mode:
  // only show from the suggestions list, never fall back to API search.
  const useSuggestionsMode = options.suggestions !== undefined;

  function selectCommit(value: string): void {
    input.value = '';
    dropdown.classList.remove('open');
    wrapper.setAttribute('aria-expanded', 'false');
    if (options.onSelect) {
      options.onSelect(value);
    } else {
      navigate(`/commits/${encodeURIComponent(value)}`);
    }
  }

  function showSuggestions(): void {
    const text = input.value.trim().toLowerCase();
    const filtered = text
      ? suggestions.filter(s =>
          s.commit.toLowerCase().startsWith(text) ||
          Object.values(s.fields).some(v => v.toLowerCase().startsWith(text)))
      : suggestions;

    dropdown.replaceChildren();
    if (filtered.length === 0) {
      dropdown.classList.remove('open');
      wrapper.setAttribute('aria-expanded', 'false');
      return;
    }
    for (const s of filtered) {
      const li = el('li', { class: 'combobox-item', tabindex: '-1' });
      li.append(el('span', {}, s.commit));
      const display = commitDisplayValue(s.commit, s.fields, options.commitFields);
      if (display !== s.commit) {
        li.append(el('span', { class: 'commit-search-field' }, ` (${display})`));
      } else if (s.ordinal != null) {
        li.append(el('span', { class: 'commit-search-field' }, ` #${s.ordinal}`));
      }
      li.addEventListener('click', () => selectCommit(s.commit));
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
      const result = await searchCommits(
        options.testsuite, text, { limit: 10 }, abortCtrl.signal,
      );
      dropdown.replaceChildren();
      if (result.items.length === 0) {
        dropdown.classList.remove('open');
        wrapper.setAttribute('aria-expanded', 'false');
        return;
      }
      for (const item of result.items) {
        const li = el('li', { class: 'combobox-item', tabindex: '-1' });
        li.append(el('span', {}, item.commit));
        const display = commitDisplayValue(item.commit, item.fields, options.commitFields);
        if (display !== item.commit) {
          li.append(el('span', { class: 'commit-search-field' }, ` (${display})`));
        } else if (item.ordinal != null) {
          li.append(el('span', { class: 'commit-search-field' }, ` #${item.ordinal}`));
        }
        li.addEventListener('click', () => selectCommit(item.commit));
        dropdown.append(li);
      }
      dropdown.classList.add('open');
      wrapper.setAttribute('aria-expanded', 'true');
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
    }
  }, 300);

  function isValidCommit(value: string): boolean {
    if (!useSuggestionsMode) return true;
    return suggestions.some(s => s.commit === value);
  }

  function updateValidationState(): void {
    const text = input.value.trim();
    if (!text || !useSuggestionsMode) {
      input.classList.remove('commit-search-invalid');
    } else {
      // Only show invalid when there are no partial matches (dropdown is empty)
      const hasMatches = suggestions.some(s =>
        s.commit.toLowerCase().startsWith(text.toLowerCase()) ||
        Object.values(s.fields).some(v => v.toLowerCase().startsWith(text.toLowerCase())));
      if (hasMatches) {
        input.classList.remove('commit-search-invalid');
      } else {
        input.classList.add('commit-search-invalid');
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
      if (text && isValidCommit(text)) selectCommit(text);
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
    setSuggestions(s: CommitSummary[]) {
      suggestions = s;
    },
  };
}
