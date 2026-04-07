import type { SideSelection } from './types';
import { getMachines, getMachineRuns } from './api';
import { debounce, el } from './utils';

// Per-side machine order filtering
let machineOrdersA: Set<string> | null = null;
let machineOrdersB: Set<string> | null = null;
let orderInputA: HTMLInputElement | null = null;
let orderInputB: HTMLInputElement | null = null;

// Per-side AbortControllers for machine-order fetches
let machineOrdersControllerA: AbortController | null = null;
let machineOrdersControllerB: AbortController | null = null;
// Shared controller for machine name search (only one search active at a time)
let machineSearchController: AbortController | null = null;

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
  if (machineSearchController) { machineSearchController.abort(); machineSearchController = null; }
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
    // Fetch a single large page of machine runs instead of all pages.
    // getMachineRuns returns lighter payloads (no machine/parameters fields)
    // and a limit of 500 avoids unbounded pagination for machines with
    // thousands of runs while still covering most real-world cases.
    const page = await getMachineRuns(testsuite, machine, { limit: 500 }, ctrl.signal);
    const orders = new Set<string>();
    for (const run of page.items) {
      const keys = Object.keys(run.order);
      if (keys.length > 0) {
        orders.add(run.order[keys[0]]);
      }
    }
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

export function createOrderCombobox(
  side: 'a' | 'b',
  setSide: (partial: Partial<SideSelection>) => void,
  onOrderChange: () => void,
  ctx: ComboboxContext,
): HTMLElement {
  const dropdownId = `order-dropdown-${side}`;
  const wrapper = el('div', {
    class: 'combobox',
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-haspopup': 'listbox',
  });
  const input = el('input', {
    type: 'text',
    placeholder: 'Type to search orders...',
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

  // Store ref for external clearing
  if (side === 'a') orderInputA = input;
  else orderInputB = input;

  const { selection } = ctx.getSideState(side);
  if (selection.order) {
    const { orderTags } = ctx.getOrderData(side);
    const tag = orderTags.get(selection.order);
    input.value = tag ? `${selection.order} (${tag})` : selection.order;
  }

  function showDropdown(filter: string): void {
    const machineOrders = side === 'a' ? machineOrdersA : machineOrdersB;
    const { selection: sideState } = ctx.getSideState(side);

    // If a machine is selected but its orders haven't loaded yet,
    // don't show unfiltered results — show a loading hint instead.
    if (sideState.machine && !machineOrders) {
      dropdown.replaceChildren(
        el('li', { class: 'combobox-item', style: 'color: #999; pointer-events: none' }, 'Loading orders...'),
      );
      dropdown.classList.add('open');
      setAriaExpanded(wrapper, true);
      return;
    }

    const { cachedOrderValues, orderTags } = ctx.getOrderData(side);
    let source = cachedOrderValues;
    if (machineOrders) {
      source = source.filter(v => machineOrders.has(v));
    }
    const lf = filter.toLowerCase();
    const matches = filter
      ? source.filter(v => {
          if (v.toLowerCase().includes(lf)) return true;
          const tag = orderTags.get(v);
          return tag !== null && tag !== undefined && tag.toLowerCase().includes(lf);
        })
      : source;
    const limited = matches.slice(0, 100);

    dropdown.replaceChildren();
    for (const v of limited) {
      const tag = orderTags.get(v);
      const label = tag ? `${v} (${tag})` : v;
      const li = el('li', { class: 'combobox-item', role: 'option', tabindex: '-1' }, label);
      li.addEventListener('click', () => {
        input.value = label;
        dropdown.classList.remove('open');
        setAriaExpanded(wrapper, false);
        setSide({ order: v });
        onOrderChange();
      });
      dropdown.append(li);
    }
    const isOpen = limited.length > 0;
    dropdown.classList.toggle('open', isOpen);
    setAriaExpanded(wrapper, isOpen);
  }

  input.addEventListener('focus', () => showDropdown(input.value));
  input.addEventListener('input', () => showDropdown(input.value));
  input.addEventListener('blur', () => {
    dropdown.classList.remove('open');
    setAriaExpanded(wrapper, false);
  });
  input.addEventListener('change', () => {
    // Strip tag suffix if present (e.g., "abc123 (release-1)" → "abc123")
    const raw = input.value.replace(/\s*\(.*\)$/, '');
    setSide({ order: raw });
    onOrderChange();
  });

  return wrapper;
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
      const { selection: updated } = ctx.getSideState(side);
      orderInput.value = updated.order || '';
    }
    onMachineChange();
  }

  const doSearch = debounce(async () => {
    // Abort any in-flight machine search request
    if (machineSearchController) machineSearchController.abort();
    machineSearchController = new AbortController();
    const { signal } = machineSearchController;

    const prefix = input.value;
    try {
      const result = await getMachines(ctx.getSuiteName(side), {
        namePrefix: prefix || undefined,
        limit: 20,
      }, signal);
      dropdown.replaceChildren();
      for (const m of result.items) {
        const li = el('li', { class: 'combobox-item', role: 'option', tabindex: '-1' }, m.name);
        li.addEventListener('click', () => {
          input.value = m.name;
          dropdown.classList.remove('open');
          setAriaExpanded(wrapper, false);
          onMachineSelect(m.name);
        });
        dropdown.append(li);
      }
      const isOpen = result.items.length > 0;
      dropdown.classList.toggle('open', isOpen);
      setAriaExpanded(wrapper, isOpen);
    } catch (err: unknown) {
      // Silently ignore aborted requests — a newer one superseded this
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // Ignore other errors during typeahead
    }
  }, 300);

  input.addEventListener('focus', () => doSearch());
  input.addEventListener('input', () => doSearch());
  input.addEventListener('blur', () => {
    dropdown.classList.remove('open');
    setAriaExpanded(wrapper, false);
  });
  input.addEventListener('change', () => {
    onMachineSelect(input.value);
  });

  return wrapper;
}
