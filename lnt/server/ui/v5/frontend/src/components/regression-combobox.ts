// components/regression-combobox.ts — Regression typeahead selector.
//
// Thin wrapper around the generic combobox base. Fetches the full regression
// list once on creation and filters locally on each keystroke.

import { truncate, matchesFilter } from '../utils';
import { getRegressions } from '../api';
import type { RegressionListItem } from '../types';
import { createCombobox } from './combobox';

export interface RegressionComboboxOptions {
  testsuite: string;
  onSelect: (uuid: string, title: string | null) => void;
  onClear?: () => void;
}

export function renderRegressionCombobox(
  container: HTMLElement,
  opts: RegressionComboboxOptions,
): { destroy: () => void; getValue: () => string; clear: () => void } {
  let abortCtrl: AbortController | null = null;
  let selectedUuid = '';
  let regressions: RegressionListItem[] | null = null;
  let fetchError = false;

  function displayText(r: RegressionListItem): string {
    return truncate(r.title || `(untitled) ${r.uuid.slice(0, 8)}`, 60);
  }

  const handle = createCombobox({
    id: `regression-${opts.testsuite}`,
    placeholder: 'Type to search regressions...',
    getItems(filter: string) {
      if (regressions === null || regressions.length === 0) return [];
      const matches = filter.trim()
        ? regressions.filter(r => matchesFilter(r.title || '', filter))
        : regressions;
      return matches.map(r => ({ value: r.uuid, display: displayText(r) }));
    },
    onSelect(item) {
      selectedUuid = item.value;
      const r = regressions?.find(r => r.uuid === item.value);
      opts.onSelect(item.value, r?.title ?? null);
    },
    onClear() {
      selectedUuid = '';
      if (opts.onClear) opts.onClear();
    },
    getStatus() {
      if (fetchError) return { text: 'Failed to load regressions', isError: true };
      if (regressions === null) return { text: 'Loading regressions...' };
      if (regressions.length === 0) return { text: 'No regressions found' };
      return null;
    },
  });

  container.append(handle.element);

  handle.input.addEventListener('input', () => {
    selectedUuid = '';
  });

  if (opts.testsuite) {
    abortCtrl = new AbortController();
    getRegressions(opts.testsuite, { limit: 500 }, abortCtrl.signal)
      .then((result) => {
        regressions = result.items;
        if (document.activeElement === handle.input) {
          handle.input.dispatchEvent(new Event('input'));
        }
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        fetchError = true;
        regressions = [];
        if (document.activeElement === handle.input) {
          handle.input.dispatchEvent(new Event('input'));
        }
      });
  } else {
    handle.input.disabled = true;
    handle.input.placeholder = 'Select a suite first';
  }

  return {
    destroy() {
      handle.destroy();
      if (abortCtrl) abortCtrl.abort();
    },
    getValue() {
      return selectedUuid;
    },
    clear() {
      selectedUuid = '';
      handle.clear();
    },
  };
}
