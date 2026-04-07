import type { SideSelection, MachineInfo } from './types';
import { getMachines, getMachineRuns } from './api';
import { el } from './utils';

// Per-side machine order filtering
let machineOrdersA: Set<string> | null = null;
let machineOrdersB: Set<string> | null = null;
let orderInputA: HTMLInputElement | null = null;
let orderInputB: HTMLInputElement | null = null;

// Per-side AbortControllers for machine-order fetches
let machineOrdersControllerA: AbortController | null = null;
let machineOrdersControllerB: AbortController | null = null;

/** Shared state that the combobox module reads but does not own. */
export interface ComboboxContext {
  /** Get per-side order values and tags. */
  getOrderData: (side: 'a' | 'b') => {
    cachedOrderValues: string[];
    orderTags: Map<string, string | null>;
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
  machineOrdersA = null;
  machineOrdersB = null;
  orderInputA = null;
  orderInputB = null;
  if (machineOrdersControllerA) { machineOrdersControllerA.abort(); machineOrdersControllerA = null; }
  if (machineOrdersControllerB) { machineOrdersControllerB.abort(); machineOrdersControllerB = null; }
}

/**
 * Fetch the set of order values for a given machine.
 * Returns a Set of primary order values extracted from the machine's runs.
 * Reusable by any consumer that needs machine-filtered orders.
 */
export async function fetchMachineOrderSet(
  testsuite: string,
  machine: string,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const page = await getMachineRuns(testsuite, machine, { limit: 500 }, signal);
  const orders = new Set<string>();
  for (const run of page.items) {
    const keys = Object.keys(run.order);
    if (keys.length > 0) {
      orders.add(run.order[keys[0]]);
    }
  }
  return orders;
}

async function fetchMachineOrders(
  side: 'a' | 'b',
  machine: string,
  testsuite: string,
): Promise<void> {
  // Abort any in-flight request for this side only
  const prev = side === 'a' ? machineOrdersControllerA : machineOrdersControllerB;
  if (prev) prev.abort();
  const ctrl = new AbortController();
  if (side === 'a') machineOrdersControllerA = ctrl;
  else machineOrdersControllerB = ctrl;

  try {
    const orders = await fetchMachineOrderSet(testsuite, machine, ctrl.signal);
    if (side === 'a') machineOrdersA = orders;
    else machineOrdersB = orders;
  } catch (err: unknown) {
    // Silently ignore aborted requests — a newer one superseded this
    if (err instanceof DOMException && err.name === 'AbortError') return;
    // On other errors, don't filter orders
    if (side === 'a') machineOrdersA = null;
    else machineOrdersB = null;
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
// createOrderPicker — reusable order combobox
// ---------------------------------------------------------------------------

export interface OrderPickerOptions {
  id: string;
  /** Called on each dropdown open/filter to get the current order data.
   *  Lazy evaluation ensures data fetched after picker creation is visible. */
  getOrderData: () => { values: string[]; tags: Map<string, string | null> };
  initialValue?: string;
  placeholder?: string;
  onSelect: (value: string) => void;
  /** Called on each dropdown render to get the machine-order filter state.
   *  - Return a Set to filter orders by machine.
   *  - Return 'loading' to show a loading hint (machine selected, orders not yet fetched).
   *  - Return null (or omit) to disable filtering (show all orders). */
  getMachineOrders?: () => Set<string> | 'loading' | null;
}

export interface OrderPickerHandle {
  element: HTMLElement;
  input: HTMLInputElement;
  destroy: () => void;
}

export function createOrderPicker(opts: OrderPickerOptions): OrderPickerHandle {
  const dropdownId = `order-dropdown-${opts.id}`;
  const wrapper = el('div', {
    class: 'combobox',
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-haspopup': 'listbox',
  });
  const input = el('input', {
    type: 'text',
    placeholder: opts.placeholder || 'Type to search orders...',
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

  // Set initial value with tag if available
  if (opts.initialValue) {
    const { tags } = opts.getOrderData();
    const tag = tags.get(opts.initialValue);
    input.value = tag ? `${opts.initialValue} (${tag})` : opts.initialValue;
  }

  function showDropdown(filter: string): void {
    const machineOrders = opts.getMachineOrders?.() ?? null;

    // Machine selected but orders not yet fetched — show loading hint.
    if (machineOrders === 'loading') {
      dropdown.replaceChildren(
        el('li', { class: 'combobox-item', style: 'color: #999; pointer-events: none' }, 'Loading orders...'),
      );
      dropdown.classList.add('open');
      setAriaExpanded(wrapper, true);
      input.classList.remove('combobox-invalid');
      return;
    }

    const { values, tags } = opts.getOrderData();
    let source = values;
    if (machineOrders instanceof Set) {
      source = source.filter(v => machineOrders.has(v));
    }
    const lf = filter.toLowerCase();
    const matches = filter
      ? source.filter(v => {
          if (v.toLowerCase().includes(lf)) return true;
          const tag = tags.get(v);
          return tag !== null && tag !== undefined && tag.toLowerCase().includes(lf);
        })
      : source;
    const limited = matches.slice(0, 100);

    dropdown.replaceChildren();
    for (const v of limited) {
      const tag = tags.get(v);
      const label = tag ? `${v} (${tag})` : v;
      const li = el('li', { class: 'combobox-item', role: 'option', tabindex: '-1' }, label);
      li.addEventListener('click', () => {
        input.value = label;
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

    // Show/hide validation halo based on whether any orders match
    if (input.value.trim() && matches.length === 0) {
      input.classList.add('combobox-invalid');
    } else {
      input.classList.remove('combobox-invalid');
    }
  }

  /** Check if a value is an exact match against available order values. */
  function isValidOrder(raw: string): boolean {
    const { values } = opts.getOrderData();
    const machineOrders = opts.getMachineOrders?.() ?? null;
    const source = machineOrders instanceof Set
      ? values.filter(v => machineOrders.has(v))
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
      if (!isValidOrder(raw)) {
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
    // Strip tag suffix if present (e.g., "abc123 (release-1)" -> "abc123")
    if (input.classList.contains('combobox-invalid')) return;
    const raw = input.value.replace(/\s*\(.*\)$/, '').trim();
    if (!raw) { opts.onSelect(raw); return; }
    if (!isValidOrder(raw)) {
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
// createOrderCombobox — Compare page wrapper around createOrderPicker
// ---------------------------------------------------------------------------

export function createOrderCombobox(
  side: 'a' | 'b',
  setSide: (partial: Partial<SideSelection>) => void,
  onOrderChange: () => void,
  ctx: ComboboxContext,
): HTMLElement {
  const { selection } = ctx.getSideState(side);

  const picker = createOrderPicker({
    id: `order-${side}`,
    getOrderData: () => {
      const { cachedOrderValues, orderTags } = ctx.getOrderData(side);
      return { values: cachedOrderValues, tags: orderTags };
    },
    initialValue: selection.order,
    placeholder: 'Type to search orders...',
    onSelect: (value) => {
      setSide(value ? { order: value } : { order: '', runs: [] });
      onOrderChange();
    },
    getMachineOrders: () => {
      const orders = side === 'a' ? machineOrdersA : machineOrdersB;
      if (orders) return orders;
      const { selection: s } = ctx.getSideState(side);
      return s.machine ? 'loading' : null;
    },
  });

  // Store refs for createMachineCombobox interaction
  if (side === 'a') orderInputA = picker.input;
  else orderInputB = picker.input;

  // Disable order input until a machine is selected
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
    // Pre-fetch orders for URL-restored machine so the order dropdown
    // is correctly filtered from the start (not showing all orders).
    fetchMachineOrders(side, selection.machine, ctx.getSuiteName(side));
  }

  async function onMachineSelect(name: string): Promise<void> {
    setSide({ machine: name });
    await fetchMachineOrders(side, name, ctx.getSuiteName(side));
    // Clear order if it's no longer valid for this machine
    const machineOrders = side === 'a' ? machineOrdersA : machineOrdersB;
    const { selection: current } = ctx.getSideState(side);
    if (machineOrders && current.order && !machineOrders.has(current.order)) {
      setSide({ order: '' });
    }
    const orderInput = side === 'a' ? orderInputA : orderInputB;
    if (orderInput) {
      orderInput.disabled = false;
      orderInput.placeholder = 'Type to search orders...';
      const { selection: updated } = ctx.getSideState(side);
      orderInput.value = updated.order || '';
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
      // Machine cleared — reset downstream state and disable order
      setSide({ machine: '', order: '', runs: [] });
      const orderInput = side === 'a' ? orderInputA : orderInputB;
      if (orderInput) {
        orderInput.disabled = true;
        orderInput.placeholder = 'Select a machine first';
        orderInput.value = '';
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
