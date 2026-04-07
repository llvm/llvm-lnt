// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the API module — hoisted, but inert for pure function tests since
// buildTraces/computeActiveTests/etc. don't call any API functions.
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    getFields: vi.fn(),
    getOrders: vi.fn().mockResolvedValue([]),
    fetchOneCursorPage: vi.fn(),
    apiUrl: vi.fn(),
    queryDataPoints: vi.fn(),
  };
});

vi.mock('../../router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../router')>();
  return { ...actual, navigate: vi.fn(), getTestsuites: vi.fn(() => ['nts']) };
});

const mockMachineComboHandle = { destroy: vi.fn(), clear: vi.fn() };
vi.mock('../../components/machine-combobox', () => ({
  renderMachineCombobox: vi.fn(() => mockMachineComboHandle),
}));

const mockOrderPickerHandle = {
  element: document.createElement('div'),
  input: document.createElement('input'),
  destroy: vi.fn(),
};
vi.mock('../../combobox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../combobox')>();
  return {
    ...actual,
    createOrderPicker: vi.fn(() => mockOrderPickerHandle),
    fetchMachineOrderSet: vi.fn().mockResolvedValue(new Set<string>()),
  };
});

const mockChartHandle = { update: vi.fn(), destroy: vi.fn(), hoverTrace: vi.fn() };
vi.mock('../../components/time-series-chart', () => ({
  createTimeSeriesChart: vi.fn(() => mockChartHandle),
}));

const mockLegendHandle = { update: vi.fn(), destroy: vi.fn(), highlightRow: vi.fn() };
vi.mock('../../components/legend-table', () => ({
  createLegendTable: vi.fn(() => mockLegendHandle),
}));

(globalThis as unknown as Record<string, unknown>).Plotly = {
  newPlot: vi.fn(),
  react: vi.fn(),
  purge: vi.fn(),
  Fx: { hover: vi.fn(), unhover: vi.fn() },
};

import { getFields, fetchOneCursorPage } from '../../api';
import { getTestsuites } from '../../router';
import { buildTraces, computeActiveTests, buildBaselinesFromData, setsEqual, TRACE_SEP, graphPage } from '../../pages/graph';
import { renderMachineCombobox } from '../../components/machine-combobox';
import type { QueryDataPoint, FieldInfo } from '../../types';

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

function makePoint(test: string, orderValue: string, value: number, runUuid = 'r1'): QueryDataPoint {
  return {
    test,
    machine: 'm1',
    metric: 'exec_time',
    value,
    order: { rev: orderValue },
    run_uuid: runUuid,
    timestamp: null,
  };
}

describe('buildTraces', () => {
  it('groups points by test name into separate traces', () => {
    const points = [
      makePoint('test-A', '100', 1.0),
      makePoint('test-A', '101', 2.0),
      makePoint('test-B', '100', 3.0),
    ];

    const traces = buildTraces(points, '', 'median', 'median');

    expect(traces).toHaveLength(2);
    expect(traces[0].testName).toBe('test-A');
    expect(traces[0].points).toHaveLength(2);
    expect(traces[1].testName).toBe('test-B');
    expect(traces[1].points).toHaveLength(1);
  });

  it('applies test filter (case-insensitive substring)', () => {
    const points = [
      makePoint('compile/test-A', '100', 1.0),
      makePoint('exec/test-B', '100', 2.0),
      makePoint('compile/test-C', '100', 3.0),
    ];

    const traces = buildTraces(points, 'compile', 'median', 'median');

    expect(traces).toHaveLength(2);
    expect(traces.map(t => t.testName).sort()).toEqual(['compile/test-A', 'compile/test-C']);
  });

  it('aggregates multiple runs at same order using run aggregation', () => {
    const points = [
      makePoint('test-A', '100', 1.0, 'r1'),
      makePoint('test-A', '100', 3.0, 'r2'),
      makePoint('test-A', '100', 5.0, 'r3'),
    ];

    // Median of [1.0, 3.0, 5.0] = 3.0
    const traces = buildTraces(points, '', 'median', 'median');
    expect(traces).toHaveLength(1);
    expect(traces[0].points).toHaveLength(1);
    expect(traces[0].points[0].value).toBe(3.0);
    expect(traces[0].points[0].runCount).toBe(3);
  });

  it('uses mean aggregation when specified', () => {
    const points = [
      makePoint('test-A', '100', 1.0, 'r1'),
      makePoint('test-A', '100', 3.0, 'r2'),
    ];

    // Mean of [1.0, 3.0] = 2.0
    const traces = buildTraces(points, '', 'mean', 'median');
    expect(traces[0].points[0].value).toBe(2.0);
  });

  it('returns empty array when no points match filter', () => {
    const points = [makePoint('test-A', '100', 1.0)];

    const traces = buildTraces(points, 'nonexistent', 'median', 'median');
    expect(traces).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    const traces = buildTraces([], '', 'median', 'median');
    expect(traces).toHaveLength(0);
  });

  it('sorts traces by test name', () => {
    const points = [
      makePoint('zebra', '100', 1.0),
      makePoint('alpha', '100', 2.0),
      makePoint('middle', '100', 3.0),
    ];

    const traces = buildTraces(points, '', 'median', 'median');
    expect(traces.map(t => t.testName)).toEqual(['alpha', 'middle', 'zebra']);
  });

  it('preserves order value across aggregation', () => {
    const points = [
      makePoint('test-A', '100', 1.0),
      makePoint('test-A', '101', 2.0),
      makePoint('test-A', '102', 3.0),
    ];

    const traces = buildTraces(points, '', 'median', 'median');
    const orderValues = traces[0].points.map(p => p.orderValue);
    expect(orderValues).toEqual(['100', '101', '102']);
  });

  it('preserves insertion order for reversed input (newest-first)', () => {
    const points = [
      makePoint('test-A', '102', 3.0),
      makePoint('test-A', '101', 2.0),
      makePoint('test-A', '100', 1.0),
    ];

    const traces = buildTraces(points, '', 'median', 'median');
    // buildTraces preserves Map insertion order, so reversed input stays reversed
    const orderValues = traces[0].points.map(p => p.orderValue);
    expect(orderValues).toEqual(['102', '101', '100']);
  });

  it('handles interleaved test data in reverse order', () => {
    const points = [
      makePoint('test-A', '102', 3.0),
      makePoint('test-B', '102', 6.0),
      makePoint('test-A', '101', 2.0),
      makePoint('test-B', '101', 5.0),
      makePoint('test-A', '100', 1.0),
      makePoint('test-B', '100', 4.0),
    ];

    const traces = buildTraces(points, '', 'median', 'median');
    expect(traces).toHaveLength(2);
    // test-A comes first alphabetically
    expect(traces[0].testName).toBe('test-A');
    expect(traces[0].points.map(p => p.orderValue)).toEqual(['102', '101', '100']);
    expect(traces[1].testName).toBe('test-B');
    expect(traces[1].points.map(p => p.orderValue)).toEqual(['102', '101', '100']);
  });
});

describe('computeActiveTests', () => {
  const names = ['alpha', 'beta', 'charlie', 'delta', 'echo',
    'foxtrot', 'golf', 'hotel', 'india', 'juliet',
    'kilo', 'lima', 'mike', 'november', 'oscar',
    'papa', 'quebec', 'romeo', 'sierra', 'tango',
    'uniform', 'victor', 'whiskey'];

  it('caps at 20 when autoCapped=true and no filter/hidden', () => {
    const active = computeActiveTests(names, '', new Set(), true);
    expect(active.size).toBe(20);
    expect(active.has('alpha')).toBe(true);
    expect(active.has('tango')).toBe(true);  // 20th
    expect(active.has('uniform')).toBe(false);  // 21st
  });

  it('disables cap when filter is non-empty', () => {
    const active = computeActiveTests(names, 'a', new Set(), true);
    // 'alpha', 'charlie', 'delta', 'tango', 'papa', 'sierra', 'whiskey' — all with 'a'
    for (const n of names) {
      if (n.toLowerCase().includes('a')) {
        expect(active.has(n)).toBe(true);
      } else {
        expect(active.has(n)).toBe(false);
      }
    }
  });

  it('removes manually hidden tests', () => {
    const hidden = new Set(['beta', 'charlie']);
    const active = computeActiveTests(names, '', hidden, false);
    expect(active.has('alpha')).toBe(true);
    expect(active.has('beta')).toBe(false);
    expect(active.has('charlie')).toBe(false);
    expect(active.has('delta')).toBe(true);
  });

  it('cap is disabled when manuallyHidden is non-empty', () => {
    const hidden = new Set(['alpha']);
    // autoCapped=true but hidden is non-empty → cap disabled
    const active = computeActiveTests(names, '', hidden, true);
    // All names except 'alpha' should be active (no 20-cap)
    expect(active.size).toBe(names.length - 1);
    expect(active.has('alpha')).toBe(false);
    expect(active.has('uniform')).toBe(true);  // would be capped otherwise
  });

  it('returns empty set for empty input', () => {
    const active = computeActiveTests([], '', new Set(), true);
    expect(active.size).toBe(0);
  });

  it('double-click isolation is just manuallyHidden with all others hidden', () => {
    // Simulates what onIsolate does: hide all except 'charlie'
    const hidden = new Set(names.filter(n => n !== 'charlie'));
    const active = computeActiveTests(names, '', hidden, false);
    expect(active.size).toBe(1);
    expect(active.has('charlie')).toBe(true);
  });

  it('after isolation, single-click unhide works naturally', () => {
    // After isolating 'charlie', user single-clicks 'alpha' to unhide it
    const hidden = new Set(names.filter(n => n !== 'charlie'));
    hidden.delete('alpha');
    const active = computeActiveTests(names, '', hidden, false);
    expect(active.size).toBe(2);
    expect(active.has('charlie')).toBe(true);
    expect(active.has('alpha')).toBe(true);
  });

  it('filters multi-machine trace names by test name portion only', () => {
    const traceNames = [
      `compile/test-A${TRACE_SEP}clang-x86`,
      `compile/test-A${TRACE_SEP}gcc-arm`,
      `exec/test-B${TRACE_SEP}clang-x86`,
      `exec/test-B${TRACE_SEP}gcc-arm`,
    ];
    const active = computeActiveTests(traceNames, 'compile', new Set(), false);
    expect(active.size).toBe(2);
    expect(active.has(`compile/test-A${TRACE_SEP}clang-x86`)).toBe(true);
    expect(active.has(`compile/test-A${TRACE_SEP}gcc-arm`)).toBe(true);
    expect(active.has(`exec/test-B${TRACE_SEP}clang-x86`)).toBe(false);
  });

  it('filter does not match machine name', () => {
    const traceNames = [
      `test-A${TRACE_SEP}clang-x86`,
      `test-A${TRACE_SEP}gcc-arm`,
    ];
    const active = computeActiveTests(traceNames, 'clang', new Set(), false);
    expect(active.size).toBe(0);
  });
});

describe('buildBaselinesFromData', () => {
  function makeRefPoint(test: string, orderValue: string, value: number, machine = 'm1'): QueryDataPoint {
    return {
      test,
      machine,
      metric: 'exec_time',
      value,
      order: { rev: orderValue },
      run_uuid: 'r1',
      timestamp: null,
    };
  }

  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  const mean = (values: number[]): number =>
    values.reduce((s, v) => s + v, 0) / values.length;

  /** Helper to build a baseline data cache from a list of points for a given baseline. */
  function buildCache(
    baselines: Array<{ suite: string; machine: string; order: string; tag: string | null }>,
    metric: string,
    pointsPerBaseline: QueryDataPoint[][],
  ): Map<string, QueryDataPoint[]> {
    const cache = new Map<string, QueryDataPoint[]>();
    for (let i = 0; i < baselines.length; i++) {
      const bl = baselines[i];
      const key = `${bl.suite}::${bl.machine}::${bl.order}::${metric}`;
      cache.set(key, pointsPerBaseline[i] || []);
    }
    return cache;
  }

  it('aggregates multiple runs at baseline order using the provided agg function', () => {
    const baselines = [{ suite: 'nts', machine: 'm1', order: '100', tag: null }];
    const points = [
      makeRefPoint('test-A', '100', 1.0),
      makeRefPoint('test-A', '100', 3.0),
      makeRefPoint('test-A', '100', 5.0),
    ];
    const cache = buildCache(baselines, 'exec_time', [points]);

    const result = buildBaselinesFromData(baselines, cache, 'exec_time', median);

    expect(result).toHaveLength(1);
    expect(result[0].values.get('test-A')).toBe(3.0); // median of [1, 3, 5]
  });

  it('uses the same agg as buildTraces (consistency check)', () => {
    const baselines = [{ suite: 'nts', machine: 'm1', order: '100', tag: null }];
    const points = [
      makeRefPoint('test-A', '100', 1.0),
      makeRefPoint('test-A', '100', 3.0),
      makeRefPoint('test-A', '100', 5.0),
    ];
    const cache = buildCache(baselines, 'exec_time', [points]);

    const blResult = buildBaselinesFromData(baselines, cache, 'exec_time', median);
    const traces = buildTraces(points, '', 'median', 'median');

    // Both should produce exactly the same value for test-A at order 100
    const traceValue = traces.find(t => t.testName === 'test-A')!.points
      .find(p => p.orderValue === '100')!.value;
    expect(blResult[0].values.get('test-A')).toBe(traceValue);
  });

  it('uses mean aggregation when provided', () => {
    const baselines = [{ suite: 'nts', machine: 'm1', order: '100', tag: null }];
    const points = [
      makeRefPoint('test-A', '100', 1.0),
      makeRefPoint('test-A', '100', 3.0),
    ];
    const cache = buildCache(baselines, 'exec_time', [points]);

    const result = buildBaselinesFromData(baselines, cache, 'exec_time', mean);

    expect(result[0].values.get('test-A')).toBe(2.0); // mean of [1, 3]
  });

  it('handles single data point (no aggregation needed)', () => {
    const baselines = [{ suite: 'nts', machine: 'm1', order: '100', tag: null }];
    const points = [makeRefPoint('test-A', '100', 42.0)];
    const cache = buildCache(baselines, 'exec_time', [points]);

    const result = buildBaselinesFromData(baselines, cache, 'exec_time', median);

    expect(result[0].values.get('test-A')).toBe(42.0);
  });

  it('handles multiple tests at the same baseline order', () => {
    const baselines = [{ suite: 'nts', machine: 'm1', order: '100', tag: null }];
    const points = [
      makeRefPoint('test-A', '100', 1.0),
      makeRefPoint('test-A', '100', 3.0),
      makeRefPoint('test-B', '100', 10.0),
      makeRefPoint('test-B', '100', 20.0),
    ];
    const cache = buildCache(baselines, 'exec_time', [points]);

    const result = buildBaselinesFromData(baselines, cache, 'exec_time', median);

    expect(result[0].values.get('test-A')).toBe(2.0); // median of [1, 3]
    expect(result[0].values.get('test-B')).toBe(15.0); // median of [10, 20]
  });

  it('handles multiple baselines', () => {
    const baselines = [
      { suite: 'nts', machine: 'm1', order: '100', tag: 'v1' },
      { suite: 'nts', machine: 'm1', order: '101', tag: null },
    ];
    const points1 = [makeRefPoint('test-A', '100', 1.0)];
    const points2 = [makeRefPoint('test-A', '101', 5.0)];
    const cache = buildCache(baselines, 'exec_time', [points1, points2]);

    const result = buildBaselinesFromData(baselines, cache, 'exec_time', median);

    expect(result).toHaveLength(2);
    expect(result[0].values.get('test-A')).toBe(1.0);
    expect(result[0].tag).toBe('v1');
    expect(result[1].values.get('test-A')).toBe(5.0);
    expect(result[1].tag).toBeNull();
  });

  it('returns empty values map when baseline has no cached data', () => {
    const baselines = [{ suite: 'nts', machine: 'm1', order: '999', tag: null }];
    const cache = new Map<string, QueryDataPoint[]>();

    const result = buildBaselinesFromData(baselines, cache, 'exec_time', median);

    expect(result).toHaveLength(1);
    expect(result[0].values.size).toBe(0);
  });

  it('returns empty array when no baselines provided', () => {
    const cache = new Map<string, QueryDataPoint[]>();
    const result = buildBaselinesFromData([], cache, 'exec_time', median);
    expect(result).toHaveLength(0);
  });

  it('assigns distinct colors from PIN_COLORS to each baseline', () => {
    const baselines = [
      { suite: 'nts', machine: 'm1', order: '100', tag: null },
      { suite: 'nts', machine: 'm1', order: '101', tag: null },
    ];
    const points1 = [makeRefPoint('test-A', '100', 1.0)];
    const points2 = [makeRefPoint('test-A', '101', 2.0)];
    const cache = buildCache(baselines, 'exec_time', [points1, points2]);

    const result = buildBaselinesFromData(baselines, cache, 'exec_time', median);

    expect(result[0].color).not.toBe(result[1].color);
  });

  it('builds label with suite/machine/order format', () => {
    const baselines = [{ suite: 'nts', machine: 'm1', order: '100', tag: null }];
    const cache = new Map<string, QueryDataPoint[]>();

    const result = buildBaselinesFromData(baselines, cache, 'exec_time', median);

    expect(result[0].label).toBe('nts/m1/100');
  });

  it('includes tag in label when present', () => {
    const baselines = [{ suite: 'nts', machine: 'm1', order: '100', tag: 'v1.0' }];
    const cache = new Map<string, QueryDataPoint[]>();

    const result = buildBaselinesFromData(baselines, cache, 'exec_time', median);

    expect(result[0].label).toBe('nts/m1/100 (v1.0)');
  });

  it('supports cross-suite baselines', () => {
    const baselines = [
      { suite: 'nts', machine: 'm1', order: '100', tag: null },
      { suite: 'other-suite', machine: 'm2', order: '200', tag: null },
    ];
    const points1 = [makeRefPoint('test-A', '100', 1.0)];
    const points2 = [makeRefPoint('test-A', '200', 9.0)];
    const cache = buildCache(baselines, 'exec_time', [points1, points2]);

    const result = buildBaselinesFromData(baselines, cache, 'exec_time', median);

    expect(result).toHaveLength(2);
    expect(result[0].label).toBe('nts/m1/100');
    expect(result[0].values.get('test-A')).toBe(1.0);
    expect(result[1].label).toBe('other-suite/m2/200');
    expect(result[1].values.get('test-A')).toBe(9.0);
  });
});

describe('setsEqual', () => {
  it('returns true for two empty sets', () => {
    expect(setsEqual(new Set(), new Set())).toBe(true);
  });

  it('returns true for identical sets', () => {
    expect(setsEqual(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'c']))).toBe(true);
  });

  it('returns true regardless of insertion order', () => {
    expect(setsEqual(new Set(['c', 'a', 'b']), new Set(['b', 'c', 'a']))).toBe(true);
  });

  it('returns false when sizes differ', () => {
    expect(setsEqual(new Set(['a', 'b']), new Set(['a', 'b', 'c']))).toBe(false);
  });

  it('returns false when same size but different elements', () => {
    expect(setsEqual(new Set(['a', 'b']), new Set(['a', 'c']))).toBe(false);
  });

  it('returns false when one set is empty', () => {
    expect(setsEqual(new Set(), new Set(['a']))).toBe(false);
    expect(setsEqual(new Set(['a']), new Set())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mount-level tests
// ---------------------------------------------------------------------------

const mockFields: FieldInfo[] = [
  { name: 'exec_time', type: 'Real', display_name: 'Execution Time', unit: 's', unit_abbrev: 's', bigger_is_better: false },
  { name: 'compile_time', type: 'Real', display_name: 'Compile Time', unit: 's', unit_abbrev: 's', bigger_is_better: false },
  { name: 'hash', type: 'Hash', display_name: 'Hash', unit: null, unit_abbrev: null, bigger_is_better: null },
];

describe('graphPage mount', () => {
  let container: HTMLElement;
  const savedLocation = window.location;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');

    // Reset mock picker handle element (consumed by append)
    mockOrderPickerHandle.element = document.createElement('div');
    mockOrderPickerHandle.input = document.createElement('input');

    // Reset URL state
    delete (window as Record<string, unknown>).location;
    (window as Record<string, unknown>).location = {
      ...savedLocation,
      search: '?suite=nts',
      pathname: '/v5/graph',
    };
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});

    // Re-establish mocks cleared by clearAllMocks
    (getTestsuites as ReturnType<typeof vi.fn>).mockReturnValue(['nts']);
    (getFields as ReturnType<typeof vi.fn>).mockResolvedValue(mockFields);
    (fetchOneCursorPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [],
      nextCursor: null,
    });
  });

  afterEach(() => {
    graphPage.unmount?.();
    (window as Record<string, unknown>).location = savedLocation;
  });

  it('renders page header "Graph"', () => {
    graphPage.mount(container, { testsuite: 'nts' });

    expect(container.querySelector('.page-header')?.textContent).toBe('Graph');
  });

  it('renders controls panel', () => {
    graphPage.mount(container, { testsuite: 'nts' });

    expect(container.querySelector('.controls-panel')).toBeTruthy();
  });

  it('renders test filter input', () => {
    graphPage.mount(container, { testsuite: 'nts' });

    expect(container.querySelector('.test-filter-input')).toBeTruthy();
  });

  it('renders run and sample aggregation dropdowns', () => {
    graphPage.mount(container, { testsuite: 'nts' });

    const selects = container.querySelectorAll('.agg-select');
    expect(selects).toHaveLength(2);

    // Both should have median/mean/min/max options
    const options = Array.from(selects[0].querySelectorAll('option')).map(o => o.value);
    expect(options).toEqual(['median', 'mean', 'min', 'max']);
  });

  it('renders machine combobox area', () => {
    graphPage.mount(container, { testsuite: 'nts' });

    expect(renderMachineCombobox).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ testsuite: 'nts' }),
    );
  });

  it('renders baselines control group with add button', () => {
    graphPage.mount(container, { testsuite: 'nts' });

    expect(container.querySelector('.add-baseline-btn')).toBeTruthy();
    expect(container.querySelector('.add-baseline-btn')?.textContent).toBe('+ Add baseline');
  });

  it('calls getFields on mount to load metrics', () => {
    graphPage.mount(container, { testsuite: 'nts' });

    expect(getFields).toHaveBeenCalledWith('nts');
  });

  it('shows metric loading message then selector after getFields resolves', async () => {
    graphPage.mount(container, { testsuite: 'nts' });

    // Loading state should exist synchronously
    expect(container.querySelector('.progress-label')?.textContent).toBe('Loading metrics...');

    // After fields load, metric selector should appear
    await vi.waitFor(() => {
      expect(container.querySelector('.metric-select')).toBeTruthy();
    });
  });

  it('shows "No data to plot." when no machines selected', () => {
    graphPage.mount(container, { testsuite: 'nts' });

    expect(container.querySelector('.no-chart-data')?.textContent).toBe('No data to plot.');
  });

  it('shows error banner when fields load fails', async () => {
    (getFields as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

    graphPage.mount(container, { testsuite: 'nts' });

    await vi.waitFor(() => {
      const banner = container.querySelector('.error-banner');
      expect(banner).toBeTruthy();
      expect(banner!.textContent).toContain('Failed to load fields');
    });
  });

  it('parses machine URL params on mount', () => {
    (window.location as Record<string, unknown>).search = '?suite=nts&machine=clang-x86&machine=gcc-arm&metric=exec_time';

    graphPage.mount(container, { testsuite: 'nts' });

    // Machine chips should be rendered for both machines
    const chips = container.querySelectorAll('.chip');
    expect(chips).toHaveLength(2);
    expect(chips[0].textContent).toContain('clang-x86');
    expect(chips[1].textContent).toContain('gcc-arm');
  });

  it('parses test_filter URL param on mount', () => {
    (window.location as Record<string, unknown>).search = '?suite=nts&test_filter=compile';

    graphPage.mount(container, { testsuite: 'nts' });

    const filterInput = container.querySelector('.test-filter-input') as HTMLInputElement;
    expect(filterInput.value).toBe('compile');
  });

  it('parses aggregation URL params on mount', () => {
    (window.location as Record<string, unknown>).search = '?suite=nts&run_agg=mean&sample_agg=max';

    graphPage.mount(container, { testsuite: 'nts' });

    const selects = container.querySelectorAll('.agg-select') as NodeListOf<HTMLSelectElement>;
    expect(selects[0].value).toBe('mean');
    expect(selects[1].value).toBe('max');
  });

  it('parses baseline URL params on mount and renders chips', () => {
    (window.location as Record<string, unknown>).search = '?suite=nts&baseline=nts::m1::100&baseline=other::m2::200';

    graphPage.mount(container, { testsuite: 'nts' });

    const chips = container.querySelectorAll('.chip');
    expect(chips.length).toBeGreaterThanOrEqual(2);
    const chipTexts = Array.from(chips).map(c => c.textContent);
    expect(chipTexts.some(t => t?.includes('nts/m1/100'))).toBe(true);
    expect(chipTexts.some(t => t?.includes('other/m2/200'))).toBe(true);
  });

  // NOTE: Testing "machines + metric via URL triggers data loading" is not
  // feasible because graph.ts intentionally preserves module-level cache and
  // machineScaffolds across unmount/remount. Prior tests that parse machine
  // URL params populate the cache, causing subsequent fetchScaffold calls to
  // return early. This behavior is better verified via integration testing.

  it('unmount calls destroy on component handles', () => {
    graphPage.mount(container, { testsuite: 'nts' });
    graphPage.unmount!();

    expect(mockMachineComboHandle.destroy).toHaveBeenCalled();
  });

  it('unmount is safe to call without errors', () => {
    graphPage.mount(container, { testsuite: 'nts' });
    expect(() => graphPage.unmount!()).not.toThrow();
  });
});
