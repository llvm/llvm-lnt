// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { computeSummaryCounts, renderSummaryBar } from '../../components/comparison-summary';
import type { ComparisonRow } from '../../types';

function makeRow(overrides: Partial<ComparisonRow>): ComparisonRow {
  return {
    test: 'test',
    valueA: 100,
    valueB: 120,
    delta: 20,
    deltaPct: 20,
    ratio: 1.2,
    status: 'improved',
    sidePresent: 'both',
    noiseReasons: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeSummaryCounts
// ---------------------------------------------------------------------------

describe('computeSummaryCounts', () => {
  it('counts each status category correctly', () => {
    const rows: ComparisonRow[] = [
      makeRow({ test: 'a', status: 'improved' }),
      makeRow({ test: 'b', status: 'improved' }),
      makeRow({ test: 'c', status: 'regressed' }),
      makeRow({ test: 'd', status: 'noise' }),
      makeRow({ test: 'e', status: 'unchanged' }),
      makeRow({ test: 'f', status: 'missing', sidePresent: 'a_only' }),
      makeRow({ test: 'g', status: 'missing', sidePresent: 'b_only' }),
      makeRow({ test: 'h', status: 'na' }),
    ];
    const counts = computeSummaryCounts(rows, '', null);
    expect(counts.improved).toBe(2);
    expect(counts.regressed).toBe(1);
    expect(counts.noise).toBe(1);
    expect(counts.unchanged).toBe(1);
    expect(counts.onlyInA).toBe(1);
    expect(counts.onlyInB).toBe(1);
    expect(counts.na).toBe(1);
    expect(counts.total).toBe(8);
  });

  it('maps missing + a_only to onlyInA and missing + b_only to onlyInB', () => {
    const rows: ComparisonRow[] = [
      makeRow({ test: 'x', status: 'missing', sidePresent: 'a_only' }),
      makeRow({ test: 'y', status: 'missing', sidePresent: 'a_only' }),
      makeRow({ test: 'z', status: 'missing', sidePresent: 'b_only' }),
    ];
    const counts = computeSummaryCounts(rows, '', null);
    expect(counts.onlyInA).toBe(2);
    expect(counts.onlyInB).toBe(1);
    expect(counts.total).toBe(3);
  });

  it('counts unchanged status correctly', () => {
    const rows: ComparisonRow[] = [
      makeRow({ test: 'a', status: 'unchanged', delta: 0 }),
      makeRow({ test: 'b', status: 'unchanged', delta: 0 }),
    ];
    const counts = computeSummaryCounts(rows, '', null);
    expect(counts.unchanged).toBe(2);
    expect(counts.total).toBe(2);
  });

  it('applies text filter (case-insensitive substring)', () => {
    const rows: ComparisonRow[] = [
      makeRow({ test: 'foo-bar', status: 'improved' }),
      makeRow({ test: 'FOO-baz', status: 'regressed' }),
      makeRow({ test: 'other', status: 'improved' }),
    ];
    const counts = computeSummaryCounts(rows, 'foo', null);
    expect(counts.improved).toBe(1);
    expect(counts.regressed).toBe(1);
    expect(counts.total).toBe(2);
  });

  it('applies zoom filter', () => {
    const rows: ComparisonRow[] = [
      makeRow({ test: 'a', status: 'improved' }),
      makeRow({ test: 'b', status: 'regressed' }),
      makeRow({ test: 'c', status: 'noise' }),
    ];
    const counts = computeSummaryCounts(rows, '', new Set(['a', 'c']));
    expect(counts.improved).toBe(1);
    expect(counts.noise).toBe(1);
    expect(counts.regressed).toBe(0);
    expect(counts.total).toBe(2);
  });

  it('applies text + zoom filter as intersection', () => {
    const rows: ComparisonRow[] = [
      makeRow({ test: 'foo-a', status: 'improved' }),
      makeRow({ test: 'foo-b', status: 'regressed' }),
      makeRow({ test: 'bar-c', status: 'noise' }),
    ];
    const counts = computeSummaryCounts(rows, 'foo', new Set(['foo-a', 'bar-c']));
    expect(counts.improved).toBe(1);
    expect(counts.total).toBe(1);
  });

  it('returns all zeros for empty rows', () => {
    const counts = computeSummaryCounts([], '', null);
    expect(counts.total).toBe(0);
    expect(counts.improved).toBe(0);
    expect(counts.regressed).toBe(0);
    expect(counts.noise).toBe(0);
    expect(counts.unchanged).toBe(0);
    expect(counts.onlyInA).toBe(0);
    expect(counts.onlyInB).toBe(0);
    expect(counts.na).toBe(0);
  });

  it('returns all zeros when text filter matches nothing', () => {
    const rows: ComparisonRow[] = [
      makeRow({ test: 'foo', status: 'improved' }),
    ];
    const counts = computeSummaryCounts(rows, 'zzz', null);
    expect(counts.total).toBe(0);
  });

  it('returns all zeros when zoom filter has no intersection', () => {
    const rows: ComparisonRow[] = [
      makeRow({ test: 'foo', status: 'improved' }),
    ];
    const counts = computeSummaryCounts(rows, '', new Set(['bar']));
    expect(counts.total).toBe(0);
  });

  it('handles all rows with same status', () => {
    const rows: ComparisonRow[] = [
      makeRow({ test: 'a', status: 'improved' }),
      makeRow({ test: 'b', status: 'improved' }),
      makeRow({ test: 'c', status: 'improved' }),
    ];
    const counts = computeSummaryCounts(rows, '', null);
    expect(counts.improved).toBe(3);
    expect(counts.total).toBe(3);
    expect(counts.regressed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// renderSummaryBar
// ---------------------------------------------------------------------------

describe('renderSummaryBar', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
  });

  it('renders 7 summary items', () => {
    const counts = {
      improved: 10, regressed: 5, noise: 20, unchanged: 2,
      onlyInA: 1, onlyInB: 3, na: 1, total: 42,
    };
    renderSummaryBar(container, counts);
    const items = container.querySelectorAll('.summary-item');
    expect(items).toHaveLength(7);
  });

  it('renders correct labels', () => {
    const counts = {
      improved: 1, regressed: 1, noise: 1, unchanged: 1,
      onlyInA: 1, onlyInB: 1, na: 1, total: 7,
    };
    renderSummaryBar(container, counts);
    const labels = Array.from(container.querySelectorAll('.summary-label')).map(
      el => el.textContent,
    );
    expect(labels).toEqual([
      'Improved', 'Regressed', 'Noise', 'Unchanged',
      'Only in A', 'Only in B', 'N/A',
    ]);
  });

  it('renders correct dot colors', () => {
    const counts = {
      improved: 1, regressed: 1, noise: 1, unchanged: 1,
      onlyInA: 1, onlyInB: 1, na: 1, total: 7,
    };
    renderSummaryBar(container, counts);
    const dots = Array.from(container.querySelectorAll('.summary-dot')) as HTMLElement[];
    expect(dots[0].style.backgroundColor).toBe('rgb(44, 160, 44)');   // #2ca02c
    expect(dots[1].style.backgroundColor).toBe('rgb(214, 39, 40)');   // #d62728
    expect(dots[2].style.backgroundColor).toBe('rgb(153, 153, 153)'); // #999999
    expect(dots[3].style.backgroundColor).toBe('rgb(153, 153, 153)'); // #999999
    expect(dots[4].style.backgroundColor).toBe('rgb(136, 136, 136)'); // #888888
    expect(dots[5].style.backgroundColor).toBe('rgb(136, 136, 136)'); // #888888
    expect(dots[6].style.backgroundColor).toBe('rgb(136, 136, 136)'); // #888888
  });

  it('renders correct count and percentage text', () => {
    const counts = {
      improved: 10, regressed: 5, noise: 20, unchanged: 0,
      onlyInA: 0, onlyInB: 0, na: 0, total: 35,
    };
    renderSummaryBar(container, counts);
    const countTexts = Array.from(container.querySelectorAll('.summary-count')).map(
      el => el.textContent,
    );
    // comparableTotal = 35
    expect(countTexts[0]).toBe('10 (28.6%)');  // improved
    expect(countTexts[1]).toBe('5 (14.3%)');   // regressed
    expect(countTexts[2]).toBe('20 (57.1%)');  // noise
    expect(countTexts[3]).toBe('0 (0%)');      // unchanged
    expect(countTexts[4]).toBe('0');           // onlyInA
    expect(countTexts[5]).toBe('0');           // onlyInB
    expect(countTexts[6]).toBe('0');           // na
  });

  it('formats percentages with one decimal place', () => {
    const counts = {
      improved: 2, regressed: 1, noise: 0, unchanged: 0,
      onlyInA: 0, onlyInB: 0, na: 0, total: 3,
    };
    renderSummaryBar(container, counts);
    const countTexts = Array.from(container.querySelectorAll('.summary-count')).map(
      el => el.textContent,
    );
    // comparableTotal = 3
    expect(countTexts[0]).toBe('2 (66.7%)');
    expect(countTexts[1]).toBe('1 (33.3%)');
  });

  it('applies summary-item-zero class to zero-count categories', () => {
    const counts = {
      improved: 5, regressed: 0, noise: 3, unchanged: 0,
      onlyInA: 0, onlyInB: 0, na: 0, total: 8,
    };
    renderSummaryBar(container, counts);
    const items = container.querySelectorAll('.summary-item');
    expect(items[0].classList.contains('summary-item-zero')).toBe(false); // improved=5
    expect(items[1].classList.contains('summary-item-zero')).toBe(true);  // regressed=0
    expect(items[2].classList.contains('summary-item-zero')).toBe(false); // noise=3
    expect(items[3].classList.contains('summary-item-zero')).toBe(true);  // unchanged=0
  });

  it('renders nothing when total is 0', () => {
    const counts = {
      improved: 0, regressed: 0, noise: 0, unchanged: 0,
      onlyInA: 0, onlyInB: 0, na: 0, total: 0,
    };
    renderSummaryBar(container, counts);
    expect(container.children).toHaveLength(0);
  });

  it('clears previous content on re-render', () => {
    const counts1 = {
      improved: 5, regressed: 0, noise: 0, unchanged: 0,
      onlyInA: 0, onlyInB: 0, na: 0, total: 5,
    };
    const counts2 = {
      improved: 0, regressed: 3, noise: 0, unchanged: 0,
      onlyInA: 0, onlyInB: 0, na: 0, total: 3,
    };
    renderSummaryBar(container, counts1);
    expect(container.querySelectorAll('.comparison-summary')).toHaveLength(1);

    renderSummaryBar(container, counts2);
    expect(container.querySelectorAll('.comparison-summary')).toHaveLength(1);

    const countTexts = Array.from(container.querySelectorAll('.summary-count')).map(
      el => el.textContent,
    );
    expect(countTexts[0]).toBe('0 (0%)');    // improved now 0
    expect(countTexts[1]).toBe('3 (100%)');  // regressed now 3
    expect(countTexts[4]).toBe('0');         // onlyInA
    expect(countTexts[5]).toBe('0');         // onlyInB
    expect(countTexts[6]).toBe('0');         // na
  });

  it('uses comparable denominator, not total', () => {
    const counts = {
      improved: 3, regressed: 1, noise: 2, unchanged: 4,
      onlyInA: 5, onlyInB: 5, na: 10, total: 30,
    };
    renderSummaryBar(container, counts);
    const countTexts = Array.from(container.querySelectorAll('.summary-count')).map(
      el => el.textContent,
    );
    // comparableTotal = 10, not 30
    expect(countTexts[0]).toBe('3 (30%)');    // improved
    expect(countTexts[1]).toBe('1 (10%)');    // regressed
    expect(countTexts[2]).toBe('2 (20%)');    // noise
    expect(countTexts[3]).toBe('4 (40%)');    // unchanged
    expect(countTexts[4]).toBe('5');          // onlyInA
    expect(countTexts[5]).toBe('5');          // onlyInB
    expect(countTexts[6]).toBe('10');         // na
  });

  it('shows no percentage when comparableTotal is 0', () => {
    const counts = {
      improved: 0, regressed: 0, noise: 0, unchanged: 0,
      onlyInA: 3, onlyInB: 2, na: 5, total: 10,
    };
    renderSummaryBar(container, counts);
    const countTexts = Array.from(container.querySelectorAll('.summary-count')).map(
      el => el.textContent,
    );
    // comparableTotal = 0 — no division by zero
    expect(countTexts[0]).toBe('0');  // improved
    expect(countTexts[1]).toBe('0');  // regressed
    expect(countTexts[2]).toBe('0');  // noise
    expect(countTexts[3]).toBe('0');  // unchanged
    expect(countTexts[4]).toBe('3');  // onlyInA
    expect(countTexts[5]).toBe('2');  // onlyInB
    expect(countTexts[6]).toBe('5');  // na
  });

  it('drops .0 for whole-number percentages', () => {
    const counts = {
      improved: 1, regressed: 1, noise: 1, unchanged: 1,
      onlyInA: 0, onlyInB: 0, na: 0, total: 4,
    };
    renderSummaryBar(container, counts);
    const countTexts = Array.from(container.querySelectorAll('.summary-count')).map(
      el => el.textContent,
    );
    // comparableTotal = 4; 25.0% → displayed as "25%"
    expect(countTexts[0]).toBe('1 (25%)');
    expect(countTexts[1]).toBe('1 (25%)');
    expect(countTexts[2]).toBe('1 (25%)');
    expect(countTexts[3]).toBe('1 (25%)');
  });

  it('shows 1 decimal place for non-whole percentages', () => {
    const counts = {
      improved: 1, regressed: 1, noise: 1, unchanged: 0,
      onlyInA: 0, onlyInB: 0, na: 0, total: 3,
    };
    renderSummaryBar(container, counts);
    const countTexts = Array.from(container.querySelectorAll('.summary-count')).map(
      el => el.textContent,
    );
    // comparableTotal = 3
    expect(countTexts[0]).toBe('1 (33.3%)');
    expect(countTexts[1]).toBe('1 (33.3%)');
    expect(countTexts[2]).toBe('1 (33.3%)');
    expect(countTexts[3]).toBe('0 (0%)');
  });

  it('shows tooltip on comparable percentage spans', () => {
    const counts = {
      improved: 3, regressed: 1, noise: 0, unchanged: 0,
      onlyInA: 2, onlyInB: 0, na: 1, total: 7,
    };
    renderSummaryBar(container, counts);
    const spans = Array.from(container.querySelectorAll('.summary-count')) as HTMLElement[];
    const expectedTooltip = 'Percentage of comparable tests (excludes Only in A, Only in B, N/A)';
    // comparable categories get tooltip (even zero-count ones when comparable > 0)
    expect(spans[0].getAttribute('title')).toBe(expectedTooltip); // improved
    expect(spans[1].getAttribute('title')).toBe(expectedTooltip); // regressed
    expect(spans[2].getAttribute('title')).toBe(expectedTooltip); // noise (count=0)
    expect(spans[3].getAttribute('title')).toBe(expectedTooltip); // unchanged (count=0)
    // non-comparable categories have no tooltip
    expect(spans[4].getAttribute('title')).toBeNull(); // onlyInA
    expect(spans[5].getAttribute('title')).toBeNull(); // onlyInB
    expect(spans[6].getAttribute('title')).toBeNull(); // na
  });

  it('zero-count comparable category still shows percentage and tooltip', () => {
    const counts = {
      improved: 0, regressed: 0, noise: 7, unchanged: 0,
      onlyInA: 3, onlyInB: 0, na: 0, total: 10,
    };
    renderSummaryBar(container, counts);
    const countTexts = Array.from(container.querySelectorAll('.summary-count')).map(
      el => el.textContent,
    );
    const spans = Array.from(container.querySelectorAll('.summary-count')) as HTMLElement[];
    // comparable > 0 but specific category has count=0 — still shows percentage and tooltip
    expect(countTexts[0]).toBe('0 (0%)');     // improved
    expect(countTexts[1]).toBe('0 (0%)');     // regressed
    expect(countTexts[2]).toBe('7 (100%)');   // noise
    expect(countTexts[3]).toBe('0 (0%)');     // unchanged
    expect(countTexts[4]).toBe('3');          // onlyInA
    // tooltip present on all comparable categories, including zero-count
    expect(spans[0].getAttribute('title')).toBeTruthy();
    expect(spans[3].getAttribute('title')).toBeTruthy();
    expect(spans[4].getAttribute('title')).toBeNull();
  });
});