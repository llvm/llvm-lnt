// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createTestSelectionTable, type TestSelectionEntry } from '../../../pages/graph/test-selection-table';
import { GRAPH_TABLE_HOVER } from '../../../events';

// jsdom doesn't provide CSS.escape — polyfill for tests
if (typeof CSS === 'undefined' || !CSS.escape) {
  (globalThis as Record<string, unknown>).CSS = {
    escape: (s: string) => s.replace(/([^\w-])/g, '\\$1'),
  };
}

function makeEntries(
  selected: string[],
  unselected: string[],
  opts?: { loading?: string[] },
): TestSelectionEntry[] {
  return [
    ...selected.map((name, i) => ({
      testName: name,
      selected: true,
      color: `#color${i}`,
      loading: opts?.loading?.includes(name),
    })),
    ...unselected.map(name => ({
      testName: name,
      selected: false,
      loading: opts?.loading?.includes(name),
    })),
  ];
}

describe('createTestSelectionTable', () => {
  let container: HTMLElement;
  const onSelectionChange = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    container = document.createElement('div');
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('renders all entries as rows with checkboxes', () => {
    const entries = makeEntries(['test-A'], ['test-B', 'test-C']);
    createTestSelectionTable(container, { entries, onSelectionChange });

    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(3);

    const checkboxes = container.querySelectorAll('tbody input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
    expect(checkboxes).toHaveLength(3);
  });

  it('selected entries have checked checkboxes and colored symbol', () => {
    const entries = makeEntries(['test-A'], ['test-B']);
    createTestSelectionTable(container, { entries, onSelectionChange });

    const rows = container.querySelectorAll('tbody tr');
    const cbA = rows[0].querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(cbA.checked).toBe(true);
    expect(rows[0].classList.contains('row-selected')).toBe(true);

    const symbol = rows[0].querySelector('.legend-symbol') as HTMLElement;
    expect(symbol).not.toBeNull();
    expect(symbol.textContent).toBe('●');
  });

  it('unselected entries have unchecked checkboxes and no symbol', () => {
    const entries = makeEntries([], ['test-B']);
    createTestSelectionTable(container, { entries, onSelectionChange });

    const row = container.querySelector('tr')!;
    const cb = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(cb.checked).toBe(false);
    expect(row.classList.contains('row-selected')).toBe(false);
    expect(row.querySelector('.legend-symbol')).toBeNull();
  });

  it('single click toggles selection after 200ms delay', () => {
    const entries = makeEntries([], ['test-A', 'test-B']);
    createTestSelectionTable(container, { entries, onSelectionChange });

    const row = container.querySelector('tr[data-test="test-A"]') as HTMLElement;
    row.click();

    expect(onSelectionChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    const sel = onSelectionChange.mock.calls[0][0] as Set<string>;
    expect(sel.has('test-A')).toBe(true);
    expect(sel.has('test-B')).toBe(false);
  });

  it('single click deselects a selected test', () => {
    const entries = makeEntries(['test-A'], ['test-B']);
    createTestSelectionTable(container, { entries, onSelectionChange });

    const row = container.querySelector('tr[data-test="test-A"]') as HTMLElement;
    row.click();

    vi.advanceTimersByTime(200);
    const sel = onSelectionChange.mock.calls[0][0] as Set<string>;
    expect(sel.has('test-A')).toBe(false);
  });

  it('clicking directly on checkbox triggers correct selection change', () => {
    const entries = makeEntries([], ['test-A', 'test-B']);
    createTestSelectionTable(container, { entries, onSelectionChange });

    // Click the checkbox element directly (not the row)
    const cb = container.querySelector('tr[data-test="test-A"] input[type="checkbox"]') as HTMLInputElement;
    expect(cb.checked).toBe(false);
    cb.click();

    // The native toggle is undone, so checkbox stays unchecked during the 200ms delay
    expect(cb.checked).toBe(false);

    vi.advanceTimersByTime(200);
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    const sel = onSelectionChange.mock.calls[0][0] as Set<string>;
    expect(sel.has('test-A')).toBe(true);
  });

  it('shift-click selects range immediately (no 200ms delay)', () => {
    const entries = makeEntries([], ['a-test', 'b-test', 'c-test', 'd-test']);
    createTestSelectionTable(container, { entries, onSelectionChange });

    // First click (normal) on a-test
    const rowA = container.querySelector('tr[data-test="a-test"]') as HTMLElement;
    rowA.click();
    vi.advanceTimersByTime(200);
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    onSelectionChange.mockClear();

    // Shift-click on c-test — should fire immediately
    const rowC = container.querySelector('tr[data-test="c-test"]') as HTMLElement;
    rowC.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));

    // Should fire immediately, not after 200ms
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    const sel = onSelectionChange.mock.calls[0][0] as Set<string>;
    expect(sel.has('a-test')).toBe(true);
    expect(sel.has('b-test')).toBe(true);
    expect(sel.has('c-test')).toBe(true);
    expect(sel.has('d-test')).toBe(false);
  });

  it('shift-click is additive to existing selection', () => {
    // d-test is already selected
    const entries = makeEntries(['d-test'], ['a-test', 'b-test', 'c-test']);
    createTestSelectionTable(container, { entries, onSelectionChange });

    // Click a-test first
    const rowA = container.querySelector('tr[data-test="a-test"]') as HTMLElement;
    rowA.click();
    vi.advanceTimersByTime(200);
    onSelectionChange.mockClear();

    // Shift-click b-test — adds a-test and b-test, d-test stays selected
    const rowB = container.querySelector('tr[data-test="b-test"]') as HTMLElement;
    rowB.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));

    const sel = onSelectionChange.mock.calls[0][0] as Set<string>;
    expect(sel.has('a-test')).toBe(true);
    expect(sel.has('b-test')).toBe(true);
    expect(sel.has('d-test')).toBe(true); // preserved
  });

  it('shift-click with stale lastClickedTest acts as normal click', () => {
    const entries = makeEntries([], ['test-A', 'test-B']);
    const handle = createTestSelectionTable(container, { entries, onSelectionChange });

    // Click test-A
    container.querySelector('tr[data-test="test-A"]')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    vi.advanceTimersByTime(200);
    onSelectionChange.mockClear();

    // Update entries without test-A — lastClickedTest becomes stale and is reset
    handle.update(makeEntries([], ['test-B', 'test-C']));

    // Shift-click test-C — lastClickedTest is null, falls through to normal toggle
    container.querySelector('tr[data-test="test-C"]')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, shiftKey: true }),
    );

    // Normal click with 200ms delay
    expect(onSelectionChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    const sel = onSelectionChange.mock.calls[0][0] as Set<string>;
    expect(sel.has('test-C')).toBe(true);
  });

  it('double-click isolates (select only this test)', () => {
    const entries = makeEntries(['test-A', 'test-B'], ['test-C']);
    createTestSelectionTable(container, { entries, onSelectionChange });

    const row = container.querySelector('tr[data-test="test-A"]') as HTMLElement;
    row.click();
    row.click();
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    vi.advanceTimersByTime(200);

    // Should have called onSelectionChange with only test-A
    expect(onSelectionChange).toHaveBeenCalled();
    const lastCall = onSelectionChange.mock.calls[onSelectionChange.mock.calls.length - 1];
    const sel = lastCall[0] as Set<string>;
    expect(sel.size).toBe(1);
    expect(sel.has('test-A')).toBe(true);
  });

  it('double-click restores all when already the sole selection', () => {
    const entries = makeEntries(['test-A'], ['test-B', 'test-C']);
    createTestSelectionTable(container, { entries, onSelectionChange });

    const row = container.querySelector('tr[data-test="test-A"]') as HTMLElement;
    row.click();
    row.click();
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    vi.advanceTimersByTime(200);

    const lastCall = onSelectionChange.mock.calls[onSelectionChange.mock.calls.length - 1];
    const sel = lastCall[0] as Set<string>;
    // Should select ALL entries
    expect(sel.size).toBe(3);
    expect(sel.has('test-A')).toBe(true);
    expect(sel.has('test-B')).toBe(true);
    expect(sel.has('test-C')).toBe(true);
  });

  it('loading entries show loading class and disabled checkbox', () => {
    const entries = makeEntries(['test-A'], [], { loading: ['test-A'] });
    createTestSelectionTable(container, { entries, onSelectionChange });

    const row = container.querySelector('tr[data-test="test-A"]')!;
    expect(row.classList.contains('row-loading')).toBe(true);

    const cb = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(cb.disabled).toBe(true);
  });

  it('dispatches GRAPH_TABLE_HOVER with bare test name on hover', () => {
    document.body.append(container);
    const entries = makeEntries([], ['test-A']);
    createTestSelectionTable(container, { entries, onSelectionChange });

    const events: Array<string | null> = [];
    document.addEventListener(GRAPH_TABLE_HOVER, ((e: CustomEvent) => {
      events.push(e.detail);
    }) as EventListener);

    const row = container.querySelector('tr[data-test="test-A"]') as HTMLElement;
    row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    row.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));

    expect(events).toEqual(['test-A', null]);
  });

  it('highlightRow adds and removes highlight class', () => {
    const entries = makeEntries([], ['test-A', 'test-B']);
    const handle = createTestSelectionTable(container, { entries, onSelectionChange });

    handle.highlightRow('test-A');
    const rowA = container.querySelector('tr[data-test="test-A"]')!;
    expect(rowA.classList.contains('row-highlighted')).toBe(true);

    handle.highlightRow('test-B');
    expect(rowA.classList.contains('row-highlighted')).toBe(false);
    const rowB = container.querySelector('tr[data-test="test-B"]')!;
    expect(rowB.classList.contains('row-highlighted')).toBe(true);

    handle.highlightRow(null);
    expect(rowB.classList.contains('row-highlighted')).toBe(false);
  });

  it('update() replaces content', () => {
    const entries = makeEntries(['test-A'], []);
    const handle = createTestSelectionTable(container, { entries, onSelectionChange });

    handle.update(makeEntries([], ['test-B', 'test-C']), '0 of 2 tests selected');

    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-test')).toBe('test-B');
    expect(rows[1].getAttribute('data-test')).toBe('test-C');

    const message = container.querySelector('.test-selection-message');
    expect(message?.textContent).toBe('0 of 2 tests selected');
  });

  it('shows message when provided', () => {
    const entries = makeEntries(['a'], []);
    createTestSelectionTable(container, {
      entries,
      onSelectionChange,
      message: '1 of 100 tests selected',
    });

    const msg = container.querySelector('.test-selection-message');
    expect(msg?.textContent).toBe('1 of 100 tests selected');
  });

  it('destroy() removes the table and cleans up click timer', () => {
    const entries = makeEntries([], ['test-A']);
    const handle = createTestSelectionTable(container, { entries, onSelectionChange });

    expect(container.querySelector('.test-selection-table')).not.toBeNull();
    handle.destroy();
    expect(container.querySelector('.test-selection-table')).toBeNull();
  });

  // --- Header "check all" checkbox ---

  it('renders header checkbox in thead', () => {
    const entries = makeEntries([], ['test-A', 'test-B']);
    createTestSelectionTable(container, { entries, onSelectionChange });

    const thead = container.querySelector('thead');
    expect(thead).not.toBeNull();
    const headerCb = thead!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(headerCb).not.toBeNull();
    expect(headerCb.checked).toBe(false);
    expect(headerCb.indeterminate).toBe(false);
  });

  it('header checkbox selects all when none selected', () => {
    const entries = makeEntries([], ['test-A', 'test-B', 'test-C']);
    createTestSelectionTable(container, { entries, onSelectionChange });

    const headerCb = container.querySelector('thead input[type="checkbox"]') as HTMLInputElement;
    headerCb.click();

    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    const sel = onSelectionChange.mock.calls[0][0] as Set<string>;
    expect(sel.size).toBe(3);
    expect(sel.has('test-A')).toBe(true);
    expect(sel.has('test-B')).toBe(true);
    expect(sel.has('test-C')).toBe(true);
  });

  it('header checkbox deselects all when all selected', () => {
    const entries = makeEntries(['test-A', 'test-B'], []);
    createTestSelectionTable(container, { entries, onSelectionChange });

    const headerCb = container.querySelector('thead input[type="checkbox"]') as HTMLInputElement;
    expect(headerCb.checked).toBe(true);
    headerCb.click();

    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    const sel = onSelectionChange.mock.calls[0][0] as Set<string>;
    expect(sel.size).toBe(0);
  });

  it('header checkbox shows indeterminate when some selected', () => {
    const entries = makeEntries(['test-A'], ['test-B', 'test-C']);
    createTestSelectionTable(container, { entries, onSelectionChange });

    const headerCb = container.querySelector('thead input[type="checkbox"]') as HTMLInputElement;
    expect(headerCb.checked).toBe(false);
    expect(headerCb.indeterminate).toBe(true);
  });

  it('header checkbox selects all when in indeterminate state', () => {
    const entries = makeEntries(['test-A'], ['test-B', 'test-C']);
    createTestSelectionTable(container, { entries, onSelectionChange });

    const headerCb = container.querySelector('thead input[type="checkbox"]') as HTMLInputElement;
    headerCb.click();

    const sel = onSelectionChange.mock.calls[0][0] as Set<string>;
    expect(sel.size).toBe(3);
  });

  it('header checkbox updates after update() call', () => {
    const entries = makeEntries([], ['test-A', 'test-B']);
    const handle = createTestSelectionTable(container, { entries, onSelectionChange });

    const headerCb = container.querySelector('thead input[type="checkbox"]') as HTMLInputElement;
    expect(headerCb.checked).toBe(false);
    expect(headerCb.indeterminate).toBe(false);

    // Update to all selected
    handle.update(makeEntries(['test-A', 'test-B'], []));
    expect(headerCb.checked).toBe(true);
    expect(headerCb.indeterminate).toBe(false);

    // Update to partial
    handle.update(makeEntries(['test-A'], ['test-B']));
    expect(headerCb.checked).toBe(false);
    expect(headerCb.indeterminate).toBe(true);
  });
});

describe('setFilter (display:none fast path)', () => {
  let container: HTMLElement;

  beforeEach(() => { container = document.createElement('div'); });

  it('hides non-matching rows via display:none', () => {
    const entries = makeEntries(['test-A'], ['test-B', 'other-C']);
    const handle = createTestSelectionTable(container, {
      entries, onSelectionChange: vi.fn(),
    });

    handle.setFilter('test');

    const rowA = container.querySelector<HTMLElement>('tr[data-test="test-A"]');
    const rowB = container.querySelector<HTMLElement>('tr[data-test="test-B"]');
    const rowC = container.querySelector<HTMLElement>('tr[data-test="other-C"]');
    expect(rowA!.style.display).toBe('');
    expect(rowB!.style.display).toBe('');
    expect(rowC!.style.display).toBe('none');

    handle.destroy();
  });

  it('shows all rows when filter is cleared', () => {
    const entries = makeEntries(['test-A'], ['test-B', 'other-C']);
    const handle = createTestSelectionTable(container, {
      entries, onSelectionChange: vi.fn(),
    });

    handle.setFilter('test');
    handle.setFilter('');

    const rows = container.querySelectorAll<HTMLElement>('tr[data-test]');
    for (const tr of rows) {
      expect(tr.style.display).toBe('');
    }

    handle.destroy();
  });

  it('hides all rows on invalid regex', () => {
    const entries = makeEntries(['test-A'], ['test-B']);
    const handle = createTestSelectionTable(container, {
      entries, onSelectionChange: vi.fn(),
    });

    handle.setFilter('re:invalid[');

    const rows = container.querySelectorAll<HTMLElement>('tr[data-test]');
    for (const tr of rows) {
      expect(tr.style.display).toBe('none');
    }

    handle.destroy();
  });

  it('header checkbox reflects only visible entries', () => {
    const entries = makeEntries(['test-A', 'test-B'], ['other-C']);
    const handle = createTestSelectionTable(container, {
      entries, onSelectionChange: vi.fn(),
    });

    // All 3 entries, 2 selected → indeterminate
    const headerCb = container.querySelector('thead input[type="checkbox"]') as HTMLInputElement;
    expect(headerCb.indeterminate).toBe(true);

    // Filter to only "test-" rows → 2 visible, both selected → checked
    handle.setFilter('test');
    expect(headerCb.checked).toBe(true);
    expect(headerCb.indeterminate).toBe(false);

    handle.destroy();
  });

  it('filter persists across update() calls', () => {
    const entries = makeEntries(['test-A'], ['other-B']);
    const handle = createTestSelectionTable(container, {
      entries, onSelectionChange: vi.fn(),
    });

    handle.setFilter('test');

    // Update with new entries — filter should still be applied
    handle.update(makeEntries(['test-X', 'test-Y'], ['other-Z']));

    const rowX = container.querySelector<HTMLElement>('tr[data-test="test-X"]');
    const rowZ = container.querySelector<HTMLElement>('tr[data-test="other-Z"]');
    expect(rowX!.style.display).toBe('');
    expect(rowZ!.style.display).toBe('none');

    handle.destroy();
  });

  it('updates checkbox state from entry data (prevents stale checkboxes)', () => {
    const entries = makeEntries(['test-A', 'test-B'], ['other-C']);
    const handle = createTestSelectionTable(container, {
      entries, onSelectionChange: vi.fn(),
    });

    // Update entries: deselect test-B
    handle.update(makeEntries(['test-A'], ['test-B', 'other-C']));

    // Apply filter to show only test- rows
    handle.setFilter('test');

    const cbB = container.querySelector<HTMLElement>('tr[data-test="test-B"] input[type="checkbox"]') as HTMLInputElement;
    expect(cbB.checked).toBe(false);

    handle.destroy();
  });
});
