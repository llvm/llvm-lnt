import type { SideSelection, MachineInfo } from './types';
import { getMachines, getMachineRuns } from './api';
import { el } from './utils';

// Per-side machine commit filtering
let machineCommitsA: Set<string> | null = null;
let machineCommitsB: Set<string> | null = null;
let commitInputA: HTMLInputElement | null = null;
let commitInputB: HTMLInputElement | null = null;

// Per-side AbortControllers for machine-commit fetches
let machineCommitsControllerA: AbortController | null = null;
let machineCommitsControllerB: AbortController | null = null;

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
}

/** Reset per-panel mutable state.  Call this at the start of renderSelectionPanel. */
export function resetComboboxState(): void {
  machineCommitsA = null;
  machineCommitsB = null;
  commitInputA = null;
  commitInputB = null;
  if (machineCommitsControllerA) { machineCommitsControllerA.abort(); machineCommitsControllerA = null; }
  if (machineCommitsControllerB) { machineCommitsControllerB.abort(); machineCommitsControllerB = null; }
}

/**
 * Fetch the set of commit values for a given machine.
 * Returns a Set of commit strings extracted from the machine's runs.
 * Reusable by any consumer that needs machine-filtered commits.
 */
export async function fetchMachineCommitSet(
  testsuite: string,
  machine: string,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const page = await getMachineRuns(testsuite, machine, { limit: 500 }, signal);
  const commits = new Set<string>();
  for (const run of page.items) {
    commits.add(run.commit);
  }
  return commits;
}

async function fetchMachineCommits(
  side: 'a' | 'b',
  machine: string,
  testsuite: string,
): Promise<void> {
  // Abort any in-flight request for this side only
  const prev = side === 'a' ? machineCommitsControllerA : machineCommitsControllerB;
  if (prev) prev.abort();
  const ctrl = new AbortController();
  if (side === 'a') machineCommitsControllerA = ctrl;
  else machineCommitsControllerB = ctrl;

  try {
    const commits = await fetchMachineCommitSet(testsuite, machine, ctrl.signal);
    if (side === 'a') machineCommitsA = commits;
    else machineCommitsB = commits;
  } catch (err: unknown) {
    // Silently ignore aborted requests — a newer one superseded this
    if (err instanceof DOMException && err.name === 'AbortError') return;
    // On other errors, don't filter commits
    if (side === 'a') machineCommitsA = null;
    else machineCommitsB = null;
  }
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
  /** Called on each dropdown render to get the machine-commit filter state.
   *  - Return a Set to filter commits by machine.
   *  - Return 'loading' to show a loading hint (machine selected, commits not yet fetched).
   *  - Return null (or omit) to disable filtering (show all commits). */
  getMachineCommits?: () => Set<string> | 'loading' | null;
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
    const machineCommits = opts.getMachineCommits?.() ?? null;

    // Machine selected but commits not yet fetched — show loading hint.
    if (machineCommits === 'loading') {
      dropdown.replaceChildren(
        el('li', { class: 'combobox-item', style: 'color: #999; pointer-events: none' }, 'Loading commits...'),
      );
      dropdown.classList.add('open');
      setAriaExpanded(wrapper, true);
      input.classList.remove('combobox-invalid');
      return;
    }

    const { values, displayMap } = opts.getCommitData();
    let source = values;
    if (machineCommits instanceof Set) {
      source = source.filter(v => machineCommits.has(v));
    }
    const lf = filter.toLowerCase();
    const matches = filter
      ? source.filter(v => {
          if (v.toLowerCase().includes(lf)) return true;
          const display = displayMap?.get(v);
          return display ? display.toLowerCase().includes(lf) : false;
        })
      : source;
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
    const machineCommits = opts.getMachineCommits?.() ?? null;
    const source = machineCommits instanceof Set
      ? values.filter(v => machineCommits.has(v))
      : values;
    return source.includes(raw);
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
    getMachineCommits: () => {
      const commits = side === 'a' ? machineCommitsA : machineCommitsB;
      if (commits) return commits;
      const { selection: s } = ctx.getSideState(side);
      return s.machine ? 'loading' : null;
    },
  });

  // Store refs for createMachineCombobox interaction
  if (side === 'a') commitInputA = picker.input;
  else commitInputB = picker.input;

  // Disable commit input until a machine is selected
  if (!selection.machine) {
    picker.input.disabled = true;
    picker.input.placeholder = 'Select a machine first';
  }

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
    fetchMachineCommits(side, selection.machine, ctx.getSuiteName(side));
  }

  async function onMachineSelect(name: string): Promise<void> {
    setSide({ machine: name });
    await fetchMachineCommits(side, name, ctx.getSuiteName(side));
    // Clear commit if it's no longer valid for this machine
    const machineCommits = side === 'a' ? machineCommitsA : machineCommitsB;
    const { selection: current } = ctx.getSideState(side);
    if (machineCommits && current.commit && !machineCommits.has(current.commit)) {
      setSide({ commit: '' });
    }
    const commitInput = side === 'a' ? commitInputA : commitInputB;
    if (commitInput) {
      commitInput.disabled = false;
      commitInput.placeholder = 'Type to search commits...';
      const { selection: updated } = ctx.getSideState(side);
      commitInput.value = updated.commit || '';
    }
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
      const commitInput = side === 'a' ? commitInputA : commitInputB;
      if (commitInput) {
        commitInput.disabled = true;
        commitInput.placeholder = 'Select a machine first';
        commitInput.value = '';
      }
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
