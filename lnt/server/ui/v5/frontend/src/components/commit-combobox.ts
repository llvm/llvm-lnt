// components/commit-combobox.ts — Commit typeahead selector.
//
// Thin wrapper around the generic combobox base. Takes lazy commit data
// (values + optional displayMap) and requires exact-match validation on
// Enter/change.

import { matchesFilter } from '../utils';
import { createCombobox, type ComboboxItem } from './combobox';

export interface CommitPickerOptions {
  id: string;
  getCommitData: () => { values: string[]; displayMap?: Map<string, string> };
  initialValue?: string;
  placeholder?: string;
  onSelect: (value: string) => void;
}

export interface CommitPickerHandle {
  element: HTMLElement;
  input: HTMLInputElement;
  setValue: (raw: string) => void;
  destroy: () => void;
}

export function createCommitPicker(opts: CommitPickerOptions): CommitPickerHandle {
  function resolveDisplay(raw: string): string {
    const { displayMap } = opts.getCommitData();
    return displayMap?.get(raw) ?? raw;
  }

  function extractRaw(text: string): string {
    return text.replace(/\s*\(.*\)$/, '').trim();
  }

  function isValidCommit(raw: string): boolean {
    const { values } = opts.getCommitData();
    return values.includes(raw);
  }

  const handle = createCombobox({
    id: `commit-${opts.id}`,
    placeholder: opts.placeholder || 'Type to search commits...',
    initialValue: opts.initialValue ? resolveDisplay(opts.initialValue) : undefined,
    getItems(filter: string): ComboboxItem[] {
      const { values, displayMap } = opts.getCommitData();
      const matches = filter
        ? values.filter(v => {
            if (matchesFilter(v, filter)) return true;
            const display = displayMap?.get(v);
            return display ? matchesFilter(display, filter) : false;
          })
        : values;
      return matches.map(v => ({
        value: v,
        display: displayMap?.get(v) ?? v,
      }));
    },
    onSelect(item: ComboboxItem) {
      opts.onSelect(item.value);
    },
    onEnter(text: string): boolean {
      const raw = extractRaw(text);
      if (!raw) return false;
      if (!isValidCommit(raw)) return false;
      opts.onSelect(raw);
      return true;
    },
  });

  handle.input.addEventListener('change', () => {
    if (handle.input.classList.contains('combobox-invalid')) return;
    const raw = extractRaw(handle.input.value);
    if (!raw) { opts.onSelect(raw); return; }
    if (!isValidCommit(raw)) {
      handle.input.classList.add('combobox-invalid');
      return;
    }
    opts.onSelect(raw);
  });

  return {
    element: handle.element,
    input: handle.input,
    setValue: (raw: string) => { handle.setValue(resolveDisplay(raw)); },
    destroy: () => { handle.destroy(); },
  };
}
