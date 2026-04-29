// components/machine-combobox.ts — Machine typeahead selector.
//
// Thin wrapper around the generic combobox base. Fetches the full machine
// list once on creation and filters locally on each keystroke.

import { matchesFilter } from '../utils';
import { getMachines } from '../api';
import type { MachineInfo } from '../types';
import { createCombobox } from './combobox';

export interface MachineComboboxOptions {
  testsuite: string;
  initialValue?: string;
  onSelect: (name: string) => void;
  onClear?: () => void;
}

export function renderMachineCombobox(
  container: HTMLElement,
  opts: MachineComboboxOptions,
): { destroy: () => void; getValue: () => string; clear: () => void } {
  let abortCtrl: AbortController | null = null;
  let selectedValue = opts.initialValue || '';
  let machines: MachineInfo[] | null = null;

  const handle = createCombobox({
    id: `machine-${opts.testsuite}`,
    placeholder: 'Type to search machines...',
    initialValue: opts.initialValue,
    getItems(filter: string) {
      if (machines === null) return [];
      const matches = filter.trim()
        ? machines.filter(m => matchesFilter(m.name, filter))
        : machines;
      return matches.map(m => ({ value: m.name, display: m.name }));
    },
    onSelect(item) {
      selectedValue = item.value;
      opts.onSelect(item.value);
    },
    onEnter(text: string): boolean {
      if (machines === null) return false;
      const matches = text.trim()
        ? machines.filter(m => matchesFilter(m.name, text))
        : machines;
      if (matches.length > 0) {
        selectedValue = text;
        opts.onSelect(text);
        return true;
      }
      return false;
    },
    onClear() {
      selectedValue = '';
      if (opts.onClear) opts.onClear();
    },
    getStatus() {
      if (machines === null) return { text: 'Loading machines...' };
      return null;
    },
  });

  container.append(handle.element);

  if (opts.testsuite) {
    abortCtrl = new AbortController();
    getMachines(opts.testsuite, { limit: 500 }, abortCtrl.signal)
      .then((result) => {
        machines = result.items;
        if (document.activeElement === handle.input) {
          handle.input.dispatchEvent(new Event('input'));
        }
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
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
      return selectedValue;
    },
    clear() {
      selectedValue = '';
      handle.clear();
    },
  };
}
