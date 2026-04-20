import type { SideSelection, MachineInfo } from './types';
import { getMachines } from './api';
import { el } from './utils';

// Per-side commit input references for enabling/disabling from machine combobox
let commitInputA: HTMLInputElement | null = null;
let commitInputB: HTMLInputElement | null = null;

/** Shared state that the combobox module reads but does not own. */
export interface ComboboxContext {
  /** Get per-side commit values and display map. */
  getCommitData: (side: 'a' | 'b') => {
    cachedCommitValues: string[];
    displayMap?: Map<string, string>;
  };
  /** Get the testsuite name for a given side. */
  getSuiteName: (side: 'a' | 'b') => string;
  getSideState: (side: 'a' | 'b') => {
    selection: SideSelection;
    setSide: (partial: Partial<SideSelection>) => void;
    label: string;
  };
  /** Fetch commits filtered by machine for a side. */
  fetchCommitsForMachine: (side: 'a' | 'b', machine: string) => Promise<void>;
}

/** Reset per-panel mutable state.  Call this at the start of renderSelectionPanel. */
export function resetComboboxState(): void {
  commitInputA = null;
  commitInputB = null;
}

/** Set the commit input to one of three states: no machine selected, loading commits, or ready. */
function setCommitInputState(
  input: HTMLInputElement | null,
  state: 'no-machine' | 'loading' | 'ready',
  value?: string,
): void {
  if (!input) return;
  if (state === 'no-machine') {
    input.disabled = true;
    input.placeholder = 'Select a machine first';
  } else if (state === 'loading') {
    input.disabled = true;
    input.placeholder = 'Loading commits...';
  } else {
    input.disabled = false;
    input.placeholder = 'Type to search commits...';
  }
  if (value !== undefined) input.value = value;
}

function setAriaExpanded(wrapper: HTMLElement, expanded: boolean): void {
  wrapper.setAttribute('aria-expanded', String(expanded));
}

function setupComboboxKeyboard(
  input: HTMLInputElement,
  dropdown: HTMLUListElement,
  wrapper: HTMLElement,
): void {
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const first = dropdown.querySelector<HTMLLIElement>('li');
      if (first) first.focus();
    } else if (e.key === 'Escape') {
      dropdown.classList.remove('open');
      setAriaExpanded(wrapper, false);
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
      dropdown.classList.remove('open');
      setAriaExpanded(wrapper, false);
      input.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// createCommitPicker — reusable commit combobox
// ---------------------------------------------------------------------------

export interface CommitPickerOptions {
  id: string;
  /** Called on each dropdown open/filter to get the current commit data.
   *  Lazy evaluation ensures data fetched after picker creation is visible. */
  getCommitData: () => { values: string[]; displayMap?: Map<string, string> };
  initialValue?: string;
  placeholder?: string;
  onSelect: (value: string) => void;
}

export interface CommitPickerHandle {
  element: HTMLElement;
  input: HTMLInputElement;
  destroy: () => void;
}

export function createCommitPicker(opts: CommitPickerOptions): CommitPickerHandle {
  const dropdownId = `commit-dropdown-${opts.id}`;
  const wrapper = el('div', {
    class: 'combobox',
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-haspopup': 'listbox',
  });
  const input = el('input', {
    type: 'text',
    placeholder: opts.placeholder || 'Type to search commits...',
    class: 'combobox-input',
    role: 'searchbox',
    'aria-autocomplete': 'list',
    'aria-controls': dropdownId,
  });
  const dropdown = el('ul', { class: 'combobox-dropdown', role: 'listbox', id: dropdownId });
  wrapper.append(input, dropdown);

  // Prevent blur from firing when clicking a dropdown item
  dropdown.addEventListener('mousedown', (e) => e.preventDefault());

  // Keyboard navigation
  setupComboboxKeyboard(input, dropdown, wrapper);

  // Set initial value
  if (opts.initialValue) {
    input.value = opts.initialValue;
  }

  function showDropdown(filter: string): void {
    const { values, displayMap } = opts.getCommitData();
    const lf = filter.toLowerCase();
    const matches = filter
      ? values.filter(v => {
          if (v.toLowerCase().includes(lf)) return true;
          const display = displayMap?.get(v);
          return display ? display.toLowerCase().includes(lf) : false;
        })
      : values;
    const limited = matches.slice(0, 100);

    dropdown.replaceChildren();
    for (const v of limited) {
      const displayText = displayMap?.get(v) ?? v;
      const li = el('li', { class: 'combobox-item', role: 'option', tabindex: '-1' }, displayText);
      li.addEventListener('click', () => {
        input.value = v;
        input.classList.remove('combobox-invalid');
        dropdown.classList.remove('open');
        setAriaExpanded(wrapper, false);
        opts.onSelect(v);
      });
      dropdown.append(li);
    }
    const isOpen = limited.length > 0;
    dropdown.classList.toggle('open', isOpen);
    setAriaExpanded(wrapper, isOpen);

    // Show/hide validation halo based on whether any commits match
    if (input.value.trim() && matches.length === 0) {
      input.classList.add('combobox-invalid');
    } else {
      input.classList.remove('combobox-invalid');
    }
  }

  /** Check if a value is an exact match against available commit values. */
  function isValidCommit(raw: string): boolean {
    const { values } = opts.getCommitData();
    return values.includes(raw);
  }

  input.addEventListener('focus', () => showDropdown(input.value));
  input.addEventListener('input', () => showDropdown(input.value));
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (input.classList.contains('combobox-invalid')) return;
      const raw = input.value.replace(/\s*\(.*\)$/, '').trim();
      if (!raw) return;
      if (!isValidCommit(raw)) {
        input.classList.add('combobox-invalid');
        return;
      }
      dropdown.classList.remove('open');
      setAriaExpanded(wrapper, false);
      opts.onSelect(raw);
    }
  });
  input.addEventListener('blur', (e: FocusEvent) => {
    if (wrapper.contains(e.relatedTarget as Node)) return;
    dropdown.classList.remove('open');
    setAriaExpanded(wrapper, false);
  });
  input.addEventListener('change', () => {
    // Strip any trailing parenthetical if present
    if (input.classList.contains('combobox-invalid')) return;
    const raw = input.value.replace(/\s*\(.*\)$/, '').trim();
    if (!raw) { opts.onSelect(raw); return; }
    if (!isValidCommit(raw)) {
      input.classList.add('combobox-invalid');
      return;
    }
    opts.onSelect(raw);
  });

  return {
    element: wrapper,
    input,
    destroy: () => { /* no internal fetches to abort */ },
  };
}

// ---------------------------------------------------------------------------
// createCommitCombobox — Compare page wrapper around createCommitPicker
// ---------------------------------------------------------------------------

export function createCommitCombobox(
  side: 'a' | 'b',
  setSide: (partial: Partial<SideSelection>) => void,
  onCommitChange: () => void,
  ctx: ComboboxContext,
): HTMLElement {
  const { selection } = ctx.getSideState(side);

  const picker = createCommitPicker({
    id: `commit-${side}`,
    getCommitData: () => {
      const { cachedCommitValues, displayMap } = ctx.getCommitData(side);
      return { values: cachedCommitValues, displayMap };
    },
    initialValue: selection.commit,
    placeholder: 'Type to search commits...',
    onSelect: (value) => {
      setSide(value ? { commit: value } : { commit: '', runs: [] });
      onCommitChange();
    },
  });

  // Store refs for createMachineCombobox interaction
  if (side === 'a') commitInputA = picker.input;
  else commitInputB = picker.input;

  // Disable commit input until a machine is selected.
  // When machine is set (URL-restored), commits are being fetched by the
  // machine combobox pre-fetch — keep disabled with a loading placeholder.
  setCommitInputState(picker.input, selection.machine ? 'loading' : 'no-machine');

  return picker.element;
}

export function createMachineCombobox(
  side: 'a' | 'b',
  setSide: (partial: Partial<SideSelection>) => void,
  onMachineChange: () => void,
  ctx: ComboboxContext,
): HTMLElement {
  const dropdownId = `machine-dropdown-${side}`;
  const wrapper = el('div', {
    class: 'combobox',
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-haspopup': 'listbox',
  });
  const input = el('input', {
    type: 'text',
    placeholder: 'Type to search machines...',
    class: 'combobox-input',
    role: 'searchbox',
    'aria-autocomplete': 'list',
    'aria-controls': dropdownId,
  });
  const dropdown = el('ul', { class: 'combobox-dropdown', role: 'listbox', id: dropdownId });
  wrapper.append(input, dropdown);

  // Prevent blur from firing when clicking a dropdown item
  dropdown.addEventListener('mousedown', (e) => e.preventDefault());

  // Keyboard navigation
  setupComboboxKeyboard(input, dropdown, wrapper);

  const { selection } = ctx.getSideState(side);
  if (selection.machine) {
    input.value = selection.machine;
    // Pre-fetch commits for URL-restored machine so the commit dropdown
    // is correctly filtered from the start (not showing all commits).
    // Fire-and-forget: the commit input doesn't exist yet (created later
    // by createCommitCombobox), so use a null-check on completion.
    ctx.fetchCommitsForMachine(side, selection.machine)
      .then(() => {
        const commitInput = side === 'a' ? commitInputA : commitInputB;
        const { selection: updated } = ctx.getSideState(side);
        setCommitInputState(commitInput, 'ready', updated.commit || '');
      })
      .catch(() => {});
  }

  async function onMachineSelect(name: string): Promise<void> {
    setSide({ machine: name });

    const commitInput = side === 'a' ? commitInputA : commitInputB;
    setCommitInputState(commitInput, 'loading');

    await ctx.fetchCommitsForMachine(side, name);

    // Clear commit if it's no longer valid for this machine
    const { cachedCommitValues } = ctx.getCommitData(side);
    const { selection: current } = ctx.getSideState(side);
    if (current.commit && !cachedCommitValues.includes(current.commit)) {
      setSide({ commit: '' });
    }
    const { selection: updated } = ctx.getSideState(side);
    setCommitInputState(commitInput, 'ready', updated.commit || '');
    onMachineChange();
  }

  // Fetch the full machine list once; filter locally on each keystroke.
  let machines: MachineInfo[] | null = null;
  const suite = ctx.getSuiteName(side);
  if (suite) {
    getMachines(suite, { limit: 500 })
      .then((result) => {
        machines = result.items;
        // If the input has focus, refresh the dropdown with the loaded data
        if (document.activeElement === input) {
          showDropdown(input.value);
        }
      })
      .catch(() => { /* ignore — combobox destroyed or suite changed */ });
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

    const lf = filter.toLowerCase();
    const matches = filter.trim()
      ? machines.filter(m => m.name.toLowerCase().includes(lf))
      : machines;

    for (const m of matches) {
      const li = el('li', { class: 'combobox-item', role: 'option', tabindex: '-1' }, m.name);
      li.addEventListener('click', () => {
        input.value = m.name;
        input.classList.remove('combobox-invalid');
        dropdown.classList.remove('open');
        setAriaExpanded(wrapper, false);
        onMachineSelect(m.name);
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

  input.addEventListener('focus', () => showDropdown(input.value));
  input.addEventListener('input', () => showDropdown(input.value));
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      const hasItems = dropdown.querySelector('.combobox-item') !== null;
      if (hasItems) {
        input.classList.remove('combobox-invalid');
        dropdown.classList.remove('open');
        setAriaExpanded(wrapper, false);
        onMachineSelect(text);
      } else {
        input.classList.add('combobox-invalid');
      }
    }
  });
  input.addEventListener('blur', (e: FocusEvent) => {
    if (wrapper.contains(e.relatedTarget as Node)) return;
    dropdown.classList.remove('open');
    setAriaExpanded(wrapper, false);
  });
  input.addEventListener('change', () => {
    const text = input.value.trim();
    if (!text) {
      // Machine cleared — reset downstream state and disable commit
      setSide({ machine: '', commit: '', runs: [] });
      setCommitInputState(side === 'a' ? commitInputA : commitInputB, 'no-machine', '');
      input.classList.remove('combobox-invalid');
      onMachineChange();
      return;
    }
    const hasItems = dropdown.querySelector('.combobox-item') !== null;
    if (hasItems) {
      input.classList.remove('combobox-invalid');
      onMachineSelect(input.value);
    } else {
      input.classList.add('combobox-invalid');
    }
  });

  // Disable machine input until a suite is selected
  if (!ctx.getSuiteName(side)) {
    input.disabled = true;
    input.placeholder = 'Select a suite first';
  }

  return wrapper;
}
