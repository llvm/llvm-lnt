// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createLegendTable, type LegendEntry } from '../components/legend-table';
import { GRAPH_TABLE_HOVER } from '../events';

// jsdom doesn't provide CSS.escape — polyfill for tests
if (typeof CSS === 'undefined' || !CSS.escape) {
  (globalThis as Record<string, unknown>).CSS = {
    escape: (s: string) => s.replace(/([^\w-])/g, '\\$1'),
  };
}

function makeEntries(active: string[], inactive: string[]): LegendEntry[] {
  return [
    ...active.map((name, i) => ({ testName: name, color: `#color${i}`, active: true })),
    ...inactive.map((name, i) => ({ testName: name, color: `#gray${i}`, active: false })),
  ];
}

const noop = vi.fn();

describe('createLegendTable', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('renders rows in entry order with inactive rows grayed out', () => {
    const container = document.createElement('div');
    const entries: LegendEntry[] = [
      { testName: 'alpha', color: '#c0', active: true },
      { testName: 'beta', color: '#c1', active: false },
      { testName: 'gamma', color: '#c2', active: true },
    ];
    createLegendTable(container, { entries, onToggle: noop, onIsolate: noop });

    const rows = container.querySelectorAll('tr');
    expect(rows).toHaveLength(3);
    expect(rows[0].getAttribute('data-test')).toBe('alpha');
    expect(rows[0].classList.contains('legend-row-inactive')).toBe(false);
    expect(rows[1].getAttribute('data-test')).toBe('beta');
    expect(rows[1].classList.contains('legend-row-inactive')).toBe(true);
    expect(rows[2].getAttribute('data-test')).toBe('gamma');
    expect(rows[2].classList.contains('legend-row-inactive')).toBe(false);
  });

  it('shows colored symbol with correct color', () => {
    const container = document.createElement('div');
    const entries: LegendEntry[] = [
      { testName: 'test-A', color: '#ff0000', active: true },
    ];
    createLegendTable(container, { entries, onToggle: noop, onIsolate: noop });

    const symbol = container.querySelector('.legend-symbol') as HTMLElement;
    expect(symbol).not.toBeNull();
    expect(symbol.style.color).toBe('rgb(255, 0, 0)');
    expect(symbol.textContent).toBe('●'); // default symbol when none specified
  });

  it('calls onToggle when a row is single-clicked (after delay)', () => {
    const container = document.createElement('div');
    const onToggle = vi.fn();
    createLegendTable(container, { entries: makeEntries(['test-A'], []), onToggle, onIsolate: noop });

    const row = container.querySelector('tr[data-test="test-A"]') as HTMLElement;
    row.click();

    // Not called yet (delayed to distinguish from double-click)
    expect(onToggle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(onToggle).toHaveBeenCalledWith('test-A');
  });

  it('calls onIsolate on double-click without triggering onToggle', () => {
    const container = document.createElement('div');
    const onToggle = vi.fn();
    const onIsolate = vi.fn();
    createLegendTable(container, { entries: makeEntries(['test-A'], []), onToggle, onIsolate });

    const row = container.querySelector('tr[data-test="test-A"]') as HTMLElement;
    // Simulate double-click: two clicks then dblclick
    row.click();
    row.click();
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    vi.advanceTimersByTime(200);

    expect(onIsolate).toHaveBeenCalledWith('test-A');
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('update() replaces table content', () => {
    const container = document.createElement('div');
    const handle = createLegendTable(container, {
      entries: makeEntries(['test-A'], []),
      onToggle: noop,
      onIsolate: noop,
    });

    handle.update(makeEntries(['test-B', 'test-C'], []));

    const rows = container.querySelectorAll('tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-test')).toBe('test-B');
    expect(rows[1].getAttribute('data-test')).toBe('test-C');
  });

  it('highlightRow() adds and removes highlight class', () => {
    const container = document.createElement('div');
    const handle = createLegendTable(container, {
      entries: makeEntries(['test-A', 'test-B'], []),
      onToggle: noop,
      onIsolate: noop,
    });

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

  it('dispatches GRAPH_TABLE_HOVER on mouseenter/mouseleave', () => {
    const container = document.createElement('div');
    document.body.append(container);
    createLegendTable(container, {
      entries: makeEntries(['test-A'], []),
      onToggle: noop,
      onIsolate: noop,
    });

    const events: Array<string | null> = [];
    document.addEventListener(GRAPH_TABLE_HOVER, ((e: CustomEvent) => {
      events.push(e.detail);
    }) as EventListener);

    const row = container.querySelector('tr[data-test="test-A"]') as HTMLElement;
    row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    row.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));

    expect(events).toEqual(['test-A', null]);
  });

  it('destroy() removes the table', () => {
    const container = document.createElement('div');
    const handle = createLegendTable(container, {
      entries: makeEntries(['test-A'], []),
      onToggle: noop,
      onIsolate: noop,
    });

    expect(container.querySelector('.legend-table')).not.toBeNull();
    handle.destroy();
    expect(container.querySelector('.legend-table')).toBeNull();
  });
});
