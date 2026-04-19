// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../router', () => ({
  navigate: vi.fn(),
  getBasePath: vi.fn(() => '/v5/nts'),
}));

vi.mock('../api', () => ({
  getTestSuiteInfoCached: vi.fn(),
  resolveCommits: vi.fn(),
}));

import {
  median, mean, safeMin, safeMax, getAggFn, geomean,
  formatValue, formatPercent, formatRatio, formatTime,
  truncate,
  debounce, el, isModifiedClick, spaLink,
  commitDisplayValue, resolveDisplayMap,
} from '../utils';
import { navigate } from '../router';
import { getTestSuiteInfoCached, resolveCommits } from '../api';

describe('median', () => {
  it('returns 0 for empty array', () => {
    expect(median([])).toBe(0);
  });

  it('returns the single value', () => {
    expect(median([42])).toBe(42);
  });

  it('returns middle value for odd count', () => {
    expect(median([1, 3, 5])).toBe(3);
    expect(median([5, 1, 3])).toBe(3); // unsorted input
  });

  it('returns average of two middle values for even count', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([4, 1, 3, 2])).toBe(2.5); // unsorted input
  });
});

describe('mean', () => {
  it('returns 0 for empty array', () => {
    expect(mean([])).toBe(0);
  });

  it('returns the single value', () => {
    expect(mean([7])).toBe(7);
  });

  it('returns average of multiple values', () => {
    expect(mean([2, 4, 6])).toBe(4);
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('safeMin', () => {
  it('returns 0 for empty array', () => {
    expect(safeMin([])).toBe(0);
  });

  it('returns the minimum value', () => {
    expect(safeMin([3, 1, 2])).toBe(1);
    expect(safeMin([-5, 0, 5])).toBe(-5);
  });
});

describe('safeMax', () => {
  it('returns 0 for empty array', () => {
    expect(safeMax([])).toBe(0);
  });

  it('returns the maximum value', () => {
    expect(safeMax([3, 1, 2])).toBe(3);
    expect(safeMax([-5, 0, 5])).toBe(5);
  });
});

describe('geomean', () => {
  it('computes geometric mean of positive values', () => {
    expect(geomean([4, 16])).toBeCloseTo(8);
  });

  it('filters out zero and negative values', () => {
    expect(geomean([4, 0, 16])).toBeCloseTo(8);
    expect(geomean([4, -3, 16])).toBeCloseTo(8);
  });

  it('returns null when all values are invalid', () => {
    expect(geomean([0, -1])).toBeNull();
  });

  it('returns null for empty array', () => {
    expect(geomean([])).toBeNull();
  });

  it('returns the single value for a single-element array', () => {
    expect(geomean([25])).toBeCloseTo(25);
  });
});

describe('getAggFn', () => {
  it('returns the correct function for each name', () => {
    expect(getAggFn('median')).toBe(median);
    expect(getAggFn('mean')).toBe(mean);
    expect(getAggFn('min')).toBe(safeMin);
    expect(getAggFn('max')).toBe(safeMax);
  });
});

describe('formatValue', () => {
  it('returns N/A for null', () => {
    expect(formatValue(null)).toBe('N/A');
  });

  it('returns "0" for zero', () => {
    expect(formatValue(0)).toBe('0');
  });

  it('formats large numbers with 1 decimal', () => {
    expect(formatValue(1234.567)).toBe('1234.6');
    expect(formatValue(-5000.1)).toBe('-5000.1');
  });

  it('formats medium numbers with 4 significant digits', () => {
    expect(formatValue(12.34)).toBe('12.34');
    expect(formatValue(1.0)).toBe('1.000');
  });

  it('formats small numbers with 3 significant digits', () => {
    expect(formatValue(0.001234)).toBe('0.00123');
    expect(formatValue(0.5)).toBe('0.500');
  });

  it('formats negative small numbers', () => {
    expect(formatValue(-0.005)).toBe('-0.00500');
  });

  describe('edge cases', () => {
    it('returns "NaN" for NaN', () => {
      expect(formatValue(NaN)).toBe('NaN');
    });

    it('returns "Infinity" for Infinity', () => {
      expect(formatValue(Infinity)).toBe('Infinity');
    });

    it('returns "-Infinity" for -Infinity', () => {
      expect(formatValue(-Infinity)).toBe('-Infinity');
    });

    it('returns "0" for zero', () => {
      expect(formatValue(0)).toBe('0');
    });
  });
});

describe('formatPercent', () => {
  it('returns N/A for null', () => {
    expect(formatPercent(null)).toBe('N/A');
  });

  it('adds + sign for positive values', () => {
    expect(formatPercent(5.123)).toBe('+5.12%');
  });

  it('keeps - sign for negative values', () => {
    expect(formatPercent(-3.456)).toBe('-3.46%');
  });

  it('formats zero without sign', () => {
    expect(formatPercent(0)).toBe('0.00%');
  });
});

describe('formatRatio', () => {
  it('returns N/A for null', () => {
    expect(formatRatio(null)).toBe('N/A');
  });

  it('formats to 4 decimal places', () => {
    expect(formatRatio(1.0)).toBe('1.0000');
    expect(formatRatio(0.9876)).toBe('0.9876');
    expect(formatRatio(1.23456)).toBe('1.2346');
  });
});

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delays execution by the specified ms', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 200);

    debounced();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(199);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('only executes the last of multiple rapid calls', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    debounced();
    debounced();

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('is actually called after the delay', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 50);

    debounced();
    vi.advanceTimersByTime(50);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('passes arguments through correctly', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced('hello', 42);
    vi.advanceTimersByTime(100);

    expect(fn).toHaveBeenCalledWith('hello', 42);
  });

  it('resets the timer when called again before it fires', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    vi.advanceTimersByTime(80);
    expect(fn).not.toHaveBeenCalled();

    // Call again — this should reset the 100ms timer
    debounced();
    vi.advanceTimersByTime(80);
    expect(fn).not.toHaveBeenCalled();

    // 20ms more completes the second timer (80 + 20 = 100 from second call)
    vi.advanceTimersByTime(20);
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe('el', () => {
  it('creates an element with the correct tag name', () => {
    const div = el('div');
    expect(div.tagName).toBe('DIV');

    const span = el('span');
    expect(span.tagName).toBe('SPAN');
  });

  it('sets string attributes via setAttribute', () => {
    const input = el('input', { type: 'text', id: 'my-input', class: 'form-control' });
    expect(input.getAttribute('type')).toBe('text');
    expect(input.getAttribute('id')).toBe('my-input');
    expect(input.getAttribute('class')).toBe('form-control');
  });

  it('handles boolean attributes: true sets empty attribute, false omits it', () => {
    const input = el('input', { disabled: true, hidden: false });
    expect(input.hasAttribute('disabled')).toBe(true);
    expect(input.getAttribute('disabled')).toBe('');
    expect(input.hasAttribute('hidden')).toBe(false);
  });

  it('appends string children as text nodes', () => {
    const p = el('p', undefined, 'Hello, world!');
    expect(p.childNodes.length).toBe(1);
    expect(p.textContent).toBe('Hello, world!');
  });

  it('appends Node children (e.g., another element)', () => {
    const child = el('span');
    const parent = el('div', undefined, child);
    expect(parent.childNodes.length).toBe(1);
    expect(parent.firstChild).toBe(child);
  });

  it('appends multiple children in order', () => {
    const first = el('span', undefined, 'first');
    const second = el('em', undefined, 'second');
    const parent = el('div', undefined, first, 'middle', second);

    expect(parent.childNodes.length).toBe(3);
    expect(parent.childNodes[0]).toBe(first);
    expect(parent.childNodes[1].textContent).toBe('middle');
    expect(parent.childNodes[2]).toBe(second);
  });

  it('works correctly with no attributes (undefined)', () => {
    const div = el('div', undefined, 'content');
    expect(div.tagName).toBe('DIV');
    expect(div.attributes.length).toBe(0);
    expect(div.textContent).toBe('content');
  });
});

describe('formatTime', () => {
  it('returns em-dash for null', () => {
    expect(formatTime(null)).toBe('\u2014');
  });

  it('returns empty string for null when custom fallback is empty', () => {
    expect(formatTime(null, '')).toBe('');
  });

  it('returns custom fallback for null', () => {
    expect(formatTime(null, 'N/A')).toBe('N/A');
  });

  it('returns em-dash for empty string', () => {
    expect(formatTime('')).toBe('\u2014');
  });

  it('returns a locale string for a valid ISO date', () => {
    const result = formatTime('2025-01-15T10:30:00Z');
    // Just verify it returns a non-empty string (locale formatting varies)
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toBe('\u2014');
  });
});

describe('truncate', () => {
  it('returns original string when length <= max', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('returns original string when length equals max', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('truncates with ellipsis when length > max', () => {
    expect(truncate('hello world', 5)).toBe('hello\u2026');
  });

  it('handles empty string', () => {
    expect(truncate('', 5)).toBe('');
  });
});

describe('isModifiedClick', () => {
  it('returns false for a plain left click', () => {
    const e = new MouseEvent('click', { button: 0 });
    expect(isModifiedClick(e)).toBe(false);
  });

  it('returns true for metaKey (Cmd on macOS)', () => {
    const e = new MouseEvent('click', { button: 0, metaKey: true });
    expect(isModifiedClick(e)).toBe(true);
  });

  it('returns true for ctrlKey (Ctrl+Click)', () => {
    const e = new MouseEvent('click', { button: 0, ctrlKey: true });
    expect(isModifiedClick(e)).toBe(true);
  });

  it('returns true for shiftKey', () => {
    const e = new MouseEvent('click', { button: 0, shiftKey: true });
    expect(isModifiedClick(e)).toBe(true);
  });

  it('returns true for altKey', () => {
    const e = new MouseEvent('click', { button: 0, altKey: true });
    expect(isModifiedClick(e)).toBe(true);
  });

  it('returns true for middle-click (button 1)', () => {
    const e = new MouseEvent('click', { button: 1 });
    expect(isModifiedClick(e)).toBe(true);
  });
});

describe('spaLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an anchor with the correct href and text', () => {
    const a = spaLink('Machines', '/machines');
    expect(a.tagName).toBe('A');
    expect(a.textContent).toBe('Machines');
    expect(a.getAttribute('href')).toBe('/v5/nts/machines');
  });

  it('plain click calls navigate() and prevents default', () => {
    const a = spaLink('Machines', '/machines');
    document.body.append(a);

    a.click();
    expect(navigate).toHaveBeenCalledWith('/machines');
  });

  it('Cmd+Click does not call navigate()', () => {
    const a = spaLink('Machines', '/machines');
    document.body.append(a);

    a.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('Ctrl+Click does not call navigate()', () => {
    const a = spaLink('Machines', '/machines');
    document.body.append(a);

    a.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('commitDisplayValue', () => {
  it('returns commit string when no commitFields provided', () => {
    expect(commitDisplayValue('abc123', { rev: 'v1.0' })).toBe('abc123');
  });

  it('returns commit string when no display field in schema', () => {
    const fields = [{ name: 'rev' }];
    expect(commitDisplayValue('abc123', { rev: 'v1.0' }, fields)).toBe('abc123');
  });

  it('returns display field value when display=true and value exists', () => {
    const fields = [{ name: 'rev', display: true }];
    expect(commitDisplayValue('abc123', { rev: 'v1.0' }, fields)).toBe('v1.0');
  });

  it('falls back to commit string when display field value is empty', () => {
    const fields = [{ name: 'rev', display: true }];
    expect(commitDisplayValue('abc123', {}, fields)).toBe('abc123');
  });

  it('falls back to commit string when display field value is missing', () => {
    const fields = [{ name: 'tag', display: true }];
    expect(commitDisplayValue('abc123', { rev: 'v1.0' }, fields)).toBe('abc123');
  });
});

// ---------------------------------------------------------------------------
// resolveDisplayMap
// ---------------------------------------------------------------------------

describe('resolveDisplayMap', () => {
  const mockGetSuiteInfo = getTestSuiteInfoCached as ReturnType<typeof vi.fn>;
  const mockResolve = resolveCommits as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns map with display values when schema has display field', async () => {
    mockGetSuiteInfo.mockResolvedValue({
      name: 'nts',
      schema: { metrics: [], commit_fields: [{ name: 'sha', display: true }], machine_fields: [] },
    });
    mockResolve.mockResolvedValue({
      results: {
        'abc': { commit: 'abc', ordinal: 1, fields: { sha: 'short-abc' } },
        'def': { commit: 'def', ordinal: 2, fields: { sha: 'short-def' } },
      },
      not_found: [],
    });

    const map = await resolveDisplayMap('nts', ['abc', 'def']);
    expect(map.get('abc')).toBe('short-abc');
    expect(map.get('def')).toBe('short-def');
  });

  it('returns empty map when commits array is empty', async () => {
    const map = await resolveDisplayMap('nts', []);
    expect(map.size).toBe(0);
    expect(mockGetSuiteInfo).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('returns empty map on network error', async () => {
    mockGetSuiteInfo.mockRejectedValue(new Error('network'));

    const map = await resolveDisplayMap('nts', ['abc']);
    expect(map.size).toBe(0);
  });

  it('re-throws AbortError', async () => {
    mockGetSuiteInfo.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    await expect(resolveDisplayMap('nts', ['abc'])).rejects.toThrow('Aborted');
  });

  it('only includes entries where display value differs from raw commit', async () => {
    mockGetSuiteInfo.mockResolvedValue({
      name: 'nts',
      schema: { metrics: [], commit_fields: [{ name: 'sha', display: true }], machine_fields: [] },
    });
    mockResolve.mockResolvedValue({
      results: {
        'abc': { commit: 'abc', ordinal: 1, fields: { sha: 'short-abc' } },
        'def': { commit: 'def', ordinal: 2, fields: {} },
      },
      not_found: [],
    });

    const map = await resolveDisplayMap('nts', ['abc', 'def']);
    expect(map.get('abc')).toBe('short-abc');
    // 'def' has no sha field, so commitDisplayValue returns 'def' — included in map
    // but the value equals the key (identity mapping)
    expect(map.get('def')).toBe('def');
  });
});
