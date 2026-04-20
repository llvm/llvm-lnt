// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderProfileStats } from '../../components/profile-stats';
import { realisticMetadataA, realisticMetadataB } from '../fixtures/profile-fixtures';

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
});

describe('renderProfileStats — single profile mode', () => {
  it('renders counter names and values', () => {
    renderProfileStats(container, { cycles: 5000000, 'branch-misses': 42000 });

    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    // Sorted alphabetically
    expect(rows[0].querySelector('td')?.textContent).toBe('branch-misses');
    expect(rows[1].querySelector('td')?.textContent).toBe('cycles');
  });

  it('renders "No counters available." for empty counters', () => {
    renderProfileStats(container, {});

    expect(container.querySelector('.no-results')?.textContent).toBe('No counters available.');
    expect(container.querySelector('table')).toBeNull();
  });

  it('has Counter and Value headers', () => {
    renderProfileStats(container, { cycles: 100 });

    const ths = container.querySelectorAll('thead th');
    expect(ths).toHaveLength(2);
    expect(ths[0].textContent).toBe('Counter');
    expect(ths[1].textContent).toBe('Value');
  });

  it('destroy() is callable without error', () => {
    const { destroy } = renderProfileStats(container, { cycles: 100 });
    expect(() => destroy()).not.toThrow();
  });
});

describe('renderProfileStats — comparison mode', () => {
  it('renders value A, value B, and delta %', () => {
    renderProfileStats(container, { cycles: 1000 }, { cycles: 1200 });

    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(1);

    const cells = rows[0].querySelectorAll('td');
    expect(cells[0].textContent).toBe('cycles');
    expect(cells[1].textContent).toBe('1,000');   // value A
    expect(cells[2].textContent).toBe('1,200');   // value B
    expect(cells[3].textContent).toContain('+20.0%'); // delta
  });

  it('has 4-column header', () => {
    renderProfileStats(container, { cycles: 100 }, { cycles: 200 });

    const ths = container.querySelectorAll('thead th');
    expect(ths).toHaveLength(4);
    expect(ths[0].textContent).toBe('Counter');
    expect(ths[1].textContent).toBe('A');
    expect(ths[2].textContent).toBe('B');
    expect(ths[3].textContent).toBe('Delta');
  });

  it('colors improvement (lower is better) green', () => {
    renderProfileStats(container, { cycles: 1000 }, { cycles: 800 });

    const delta = container.querySelector('.profile-stats-improved');
    expect(delta).toBeTruthy();
    expect(delta?.textContent).toContain('-20.0%');
  });

  it('colors regression red', () => {
    renderProfileStats(container, { cycles: 1000 }, { cycles: 1500 });

    const delta = container.querySelector('.profile-stats-regressed');
    expect(delta).toBeTruthy();
    expect(delta?.textContent).toContain('+50.0%');
  });

  it('handles A=0 gracefully (shows --)', () => {
    renderProfileStats(container, { cycles: 0 }, { cycles: 100 });

    const deltaCell = container.querySelector('.profile-stats-delta');
    expect(deltaCell?.textContent).toBe('--');
  });

  it('handles mismatched counter names (shows union)', () => {
    renderProfileStats(container, { cycles: 100 }, { 'branch-misses': 50 });

    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    const names = Array.from(rows).map(r => r.querySelector('td')?.textContent);
    expect(names).toContain('branch-misses');
    expect(names).toContain('cycles');
  });

  it('shows delta bar with capped width', () => {
    renderProfileStats(container, { cycles: 100 }, { cycles: 350 });

    const bar = container.querySelector('.profile-stats-bar') as HTMLElement;
    expect(bar).toBeTruthy();
    // 250% delta capped to 100% width
    expect(bar.style.width).toBe('100%');
  });

  it('destroy() is callable without error', () => {
    const { destroy } = renderProfileStats(container, { a: 1 }, { a: 2 });
    expect(() => destroy()).not.toThrow();
  });
});

describe('renderProfileStats — realistic data', () => {
  let container: HTMLElement;
  beforeEach(() => { container = document.createElement('div'); });

  it('renders realistic 4-counter A/B comparison with mixed results', () => {
    renderProfileStats(container, realisticMetadataA.counters, realisticMetadataB.counters);

    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(4);

    // All 4 counter names present (sorted alphabetically)
    const names = Array.from(rows).map(r => r.querySelector('td')?.textContent);
    expect(names).toEqual(['branch-misses', 'cache-misses', 'cycles', 'instructions']);

    // branch-misses improved (18742 -> 15903 = -15.1%)
    const bmRow = Array.from(rows).find(r => r.querySelector('td')?.textContent === 'branch-misses');
    expect(bmRow?.querySelector('.profile-stats-improved')).toBeTruthy();

    // cycles regressed (4523891 -> 4891204 = +8.1%)
    const cyclesRow = Array.from(rows).find(r => r.querySelector('td')?.textContent === 'cycles');
    expect(cyclesRow?.querySelector('.profile-stats-regressed')).toBeTruthy();

    // instructions unchanged (same value → delta = 0%)
    const instrRow = Array.from(rows).find(r => r.querySelector('td')?.textContent === 'instructions');
    const instrDelta = instrRow?.querySelector('.profile-stats-delta');
    expect(instrDelta?.textContent).toContain('+0.0%');
  });
});
