// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the API module — hoisted, but inert for pure function tests since
// buildTraces/etc. don't call any API functions.
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    getFields: vi.fn(),
    getCommits: vi.fn().mockResolvedValue([]),
    fetchOneCursorPage: vi.fn(),
    postOneCursorPage: vi.fn(),
    apiUrl: vi.fn((suite: string, path: string) => `/api/v5/${suite}/${path}`),
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

const mockCommitPickerHandle = {
  element: document.createElement('div'),
  input: document.createElement('input'),
  destroy: vi.fn(),
};
vi.mock('../../combobox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../combobox')>();
  return {
    ...actual,
    createCommitPicker: vi.fn(() => mockCommitPickerHandle),
    fetchMachineCommitSet: vi.fn().mockResolvedValue(new Set<string>()),
  };
});

const mockChartHandle = { update: vi.fn(), destroy: vi.fn(), hoverTrace: vi.fn() };
vi.mock('../../components/time-series-chart', () => ({
  createTimeSeriesChart: vi.fn(() => mockChartHandle),
}));

const mockTableHandle = { update: vi.fn(), destroy: vi.fn(), highlightRow: vi.fn() };
vi.mock('../../components/test-selection-table', () => ({
  createTestSelectionTable: vi.fn(() => mockTableHandle),
}));

(globalThis as unknown as Record<string, unknown>).Plotly = {
  newPlot: vi.fn(),
  react: vi.fn(),
  purge: vi.fn(),
  Fx: { hover: vi.fn(), unhover: vi.fn() },
};

import { getFields, fetchOneCursorPage, postOneCursorPage } from '../../api';
import { getTestsuites } from '../../router';
import { buildTraces, buildBaselinesFromData, TRACE_SEP, graphPage } from '../../pages/graph';
import { renderMachineCombobox } from '../../components/machine-combobox';
import type { QueryDataPoint, FieldInfo } from '../../types';

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

function makePoint(test: string, commitValue: string, value: number, runUuid = 'r1'): QueryDataPoint {
  return {
    test,
    machine: 'm1',
    metric: 'exec_time',
    value,
    commit: commitValue,
    ordinal: null,
    run_uuid: runUuid,
    submitted_at: null,
  };
}

describe('buildTraces', () => {
  it('groups points by test name into separate traces', () => {
    const points = [
      makePoint('test-A', '100', 1.0),
      makePoint('test-A', '101', 2.0),
      makePoint('test-B', '100', 3.0),
    ];

    const traces = buildTraces(points, 'median', 'median');

    expect(traces).toHaveLength(2);
    expect(traces[0].testName).toBe('test-A');
    expect(traces[0].points).toHaveLength(2);
    expect(traces[1].testName).toBe('test-B');
    expect(traces[1].points).toHaveLength(1);
  });

  it('handles pre-filtered input (single test)', () => {
    const points = [
      makePoint('compile/test-A', '100', 1.0),
      makePoint('compile/test-A', '101', 2.0),
    ];

    const traces = buildTraces(points, 'median', 'median');

    expect(traces).toHaveLength(1);
    expect(traces[0].testName).toBe('compile/test-A');
  });

  it('aggregates multiple runs at same commit using run aggregation', () => {
    const points = [
      makePoint('test-A', '100', 1.0, 'r1'),
      makePoint('test-A', '100', 3.0, 'r2'),
      makePoint('test-A', '100', 5.0, 'r3'),
    ];

    // Median of [1.0, 3.0, 5.0] = 3.0
    const traces = buildTraces(points, 'median', 'median');
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
    const traces = buildTraces(points, 'mean', 'median');
    expect(traces[0].points[0].value).toBe(2.0);
  });

  it('applies sample aggregation within a single run', () => {
    // One run with 3 samples (repetitions)
    const points = [
      makePoint('test-A', '100', 1.0, 'r1'),
      makePoint('test-A', '100', 3.0, 'r1'),
      makePoint('test-A', '100', 5.0, 'r1'),
    ];

    // sampleAgg(median) within run r1: median([1,3,5]) = 3.0
    // runAgg(median) across 1 run: median([3.0]) = 3.0
    const traces = buildTraces(points, 'median', 'median');
    expect(traces[0].points[0].value).toBe(3.0);
    // runCount should be 1 (one run), not 3 (three samples)
    expect(traces[0].points[0].runCount).toBe(1);
  });

  it('applies sampleAgg then runAgg in two steps', () => {
    // 2 runs, each with 2 samples
    const points = [
      makePoint('test-A', '100', 1.0, 'r1'),
      makePoint('test-A', '100', 3.0, 'r1'),
      makePoint('test-A', '100', 10.0, 'r2'),
      makePoint('test-A', '100', 20.0, 'r2'),
    ];

    // sampleAgg(median): r1 → median([1,3]) = 2.0, r2 → median([10,20]) = 15.0
    // runAgg(median): median([2.0, 15.0]) = 8.5
    const traces = buildTraces(points, 'median', 'median');
    expect(traces[0].points[0].value).toBe(8.5);
    expect(traces[0].points[0].runCount).toBe(2);

    // With mean sampleAgg:
    // sampleAgg(mean): r1 → 2.0, r2 → 15.0
    // runAgg(median): median([2.0, 15.0]) = 8.5 (same in this case)
    const traces2 = buildTraces(points, 'median', 'mean');
    expect(traces2[0].points[0].value).toBe(8.5);

    // With mean runAgg + median sampleAgg:
    // sampleAgg(median): r1 → 2.0, r2 → 15.0
    // runAgg(mean): mean([2.0, 15.0]) = 8.5 (same in this case)
    const traces3 = buildTraces(points, 'mean', 'median');
    expect(traces3[0].points[0].value).toBe(8.5);
  });

  it('two-step aggregation differs from flat aggregation', () => {
    // This test demonstrates that the two-step pipeline produces
    // different results than flattening all samples together.
    const points = [
      makePoint('test-A', '100', 1.0, 'r1'),
      makePoint('test-A', '100', 1.0, 'r1'),
      makePoint('test-A', '100', 1.0, 'r1'),
      makePoint('test-A', '100', 100.0, 'r2'),
    ];

    // Two-step: sampleAgg(median) r1 → 1.0, r2 → 100.0
    //           runAgg(mean) → mean([1.0, 100.0]) = 50.5
    // Flat:     mean([1.0, 1.0, 1.0, 100.0]) = 25.75
    const traces = buildTraces(points, 'mean', 'median');
    expect(traces[0].points[0].value).toBe(50.5); // NOT 25.75
  });

  it('returns empty array for single empty-points input', () => {
    const traces = buildTraces([makePoint('test-A', '100', 1.0)], 'median', 'median');
    expect(traces).toHaveLength(1);
  });

  it('returns empty array for empty input', () => {
    const traces = buildTraces([], 'median', 'median');
    expect(traces).toHaveLength(0);
  });

  it('sorts traces by test name', () => {
    const points = [
      makePoint('zebra', '100', 1.0),
      makePoint('alpha', '100', 2.0),
      makePoint('middle', '100', 3.0),
    ];

    const traces = buildTraces(points, 'median', 'median');
    expect(traces.map(t => t.testName)).toEqual(['alpha', 'middle', 'zebra']);
  });

  it('preserves commit value across aggregation', () => {
    const points = [
      makePoint('test-A', '100', 1.0),
      makePoint('test-A', '101', 2.0),
      makePoint('test-A', '102', 3.0),
    ];

    const traces = buildTraces(points, 'median', 'median');
    const commitValues = traces[0].points.map(p => p.commit);
    expect(commitValues).toEqual(['100', '101', '102']);
  });

  it('preserves insertion order for reversed input (newest-first)', () => {
    const points = [
      makePoint('test-A', '102', 3.0),
      makePoint('test-A', '101', 2.0),
      makePoint('test-A', '100', 1.0),
    ];

    const traces = buildTraces(points, 'median', 'median');
    // buildTraces preserves Map insertion order, so reversed input stays reversed
    const commitValues = traces[0].points.map(p => p.commit);
    expect(commitValues).toEqual(['102', '101', '100']);
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

    const traces = buildTraces(points, 'median', 'median');
    expect(traces).toHaveLength(2);
    // test-A comes first alphabetically
    expect(traces[0].testName).toBe('test-A');
    expect(traces[0].points.map(p => p.commit)).toEqual(['102', '101', '100']);
    expect(traces[1].testName).toBe('test-B');
    expect(traces[1].points.map(p => p.commit)).toEqual(['102', '101', '100']);
  });
});

describe('buildBaselinesFromData', () => {
  function makeRefPoint(test: string, commitValue: string, value: number, machine = 'm1'): QueryDataPoint {
    return {
      test,
      machine,
      metric: 'exec_time',
      value,
      commit: commitValue,
      ordinal: null,
      run_uuid: 'r1',
      submitted_at: null,
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

  /** Helper to build a lookup function from a list of points for a given baseline. */
  function buildLookup(
    baselines: Array<{ suite: string; machine: string; commit: string }>,
    metric: string,
    pointsPerBaseline: QueryDataPoint[][],
  ): (suite: string, machine: string, commit: string, met: string) => QueryDataPoint[] {
    const cache = new Map<string, QueryDataPoint[]>();
    for (let i = 0; i < baselines.length; i++) {
      const bl = baselines[i];
      const key = `${bl.suite}::${bl.machine}::${bl.commit}::${metric}`;
      cache.set(key, pointsPerBaseline[i] || []);
    }
    return (s, m, o, met) => cache.get(`${s}::${m}::${o}::${met}`) ?? [];
  }

  it('aggregates multiple runs at baseline commit using the provided agg function', () => {
    const baselines = [{ suite: 'nts', machine: 'm1', commit: '100' }];
    const points = [
      makeRefPoint('test-A', '100', 1.0),
      makeRefPoint('test-A', '100', 3.0),
      makeRefPoint('test-A', '100', 5.0),
    ];
    const cache = buildLookup(baselines, 'exec_time', [points]);

    const result = buildBaselinesFromData(baselines, cache, 'exec_time', median);

    expect(result).toHaveLength(1);
    expect(result[0].values.get('test-A')).toBe(3.0); // median of [1, 3, 5]
  });

  it('uses the same agg as buildTraces (consistency check)', () => {
    const baselines = [{ suite: 'nts', machine: 'm1', commit: '100' }];
    const points = [
      makeRefPoint('test-A', '100', 1.0),
      makeRefPoint('test-A', '100', 3.0),
      makeRefPoint('test-A', '100', 5.0),
    ];
    const cache = buildLookup(baselines, 'exec_time', [points]);

    const blResult = buildBaselinesFromData(baselines, cache, 'exec_time', median);
    const traces = buildTraces(points, 'median', 'median');

    // Both should produce exactly the same value for test-A at commit 100
    const traceValue = traces.find(t => t.testName === 'test-A')!.points
      .find(p => p.commit === '100')!.value;
    expect(blResult[0].values.get('test-A')).toBe(traceValue);
  });

  it('uses mean aggregation when provided', () => {
    const baselines = [{ suite: 'nts', machine: 'm1', commit: '100' }];
    const points = [
      makeRefPoint('test-A', '100', 1.0),
      makeRefPoint('test-A', '100', 3.0),
    ];
    const cache = buildLookup(baselines, 'exec_time', [points]);

    const result = buildBaselinesFromData(baselines, cache, 'exec_time', mean);

    expect(result[0].values.get('test-A')).toBe(2.0); // mean of [1, 3]
  });

  it('handles single data point (no aggregation needed)', () => {
    const baselines = [{ suite: 'nts', machine: 'm1', commit: '100' }];
    const points = [makeRefPoint('test-A', '100', 42.0)];
    const cache = buildLookup(baselines, 'exec_time', [points]);

    const result = buildBaselinesFromData(baselines, cache, 'exec_time', median);

    expect(result[0].values.get('test-A')).toBe(42.0);
  });

  it('handles multiple tests at the same baseline commit', () => {
    const baselines = [{ suite: 'nts', machine: 'm1', commit: '100' }];
    const points = [
      makeRefPoint('test-A', '100', 1.0),
      makeRefPoint('test-A', '100', 3.0),
      makeRefPoint('test-B', '100', 10.0),
      makeRefPoint('test-B', '100', 20.0),
    ];
    const cache = buildLookup(baselines, 'exec_time', [points]);

    const result = buildBaselinesFromData(baselines, cache, 'exec_time', median);

    expect(result[0].values.get('test-A')).toBe(2.0); // median of [1, 3]
    expect(result[0].values.get('test-B')).toBe(15.0); // median of [10, 20]
  });

  it('handles multiple baselines', () => {
    const baselines = [
      { suite: 'nts', machine: 'm1', commit: '100' },
      { suite: 'nts', machine: 'm1', commit: '101' },
    ];
    const points1 = [makeRefPoint('test-A', '100', 1.0)];
    const points2 = [makeRefPoint('test-A', '101', 5.0)];
    const cache = buildLookup(baselines, 'exec_time', [points1, points2]);

    const result = buildBaselinesFromData(baselines, cache, 'exec_time', median);

    expect(result).toHaveLength(2);
    expect(result[0].values.get('test-A')).toBe(1.0);
    expect(result[1].values.get('test-A')).toBe(5.0);
  });

  const emptyLookup = () => [] as QueryDataPoint[];

  it('returns empty values map when baseline has no cached data', () => {
    const baselines = [{ suite: 'nts', machine: 'm1', commit: '999' }];

    const result = buildBaselinesFromData(baselines, emptyLookup, 'exec_time', median);

    expect(result).toHaveLength(1);
    expect(result[0].values.size).toBe(0);
  });

  it('returns empty array when no baselines provided', () => {
    const result = buildBaselinesFromData([], emptyLookup, 'exec_time', median);
    expect(result).toHaveLength(0);
  });

  it('does not include a color field on returned baselines', () => {
    const baselines = [
      { suite: 'nts', machine: 'm1', commit: '100' },
    ];
    const points1 = [makeRefPoint('test-A', '100', 1.0)];
    const cache = buildLookup(baselines, 'exec_time', [points1]);

    const result = buildBaselinesFromData(baselines, cache, 'exec_time', median);

    expect(result[0]).not.toHaveProperty('color');
  });

  it('builds label with suite/machine/commit format', () => {
    const baselines = [{ suite: 'nts', machine: 'm1', commit: '100' }];

    const result = buildBaselinesFromData(baselines, emptyLookup, 'exec_time', median);

    expect(result[0].label).toBe('nts/m1/100');
  });

  it('supports cross-suite baselines', () => {
    const baselines = [
      { suite: 'nts', machine: 'm1', commit: '100' },
      { suite: 'other-suite', machine: 'm2', commit: '200' },
    ];
    const points1 = [makeRefPoint('test-A', '100', 1.0)];
    const points2 = [makeRefPoint('test-A', '200', 9.0)];
    const cache = buildLookup(baselines, 'exec_time', [points1, points2]);

    const result = buildBaselinesFromData(baselines, cache, 'exec_time', median);

    expect(result).toHaveLength(2);
    expect(result[0].label).toBe('nts/m1/100');
    expect(result[0].values.get('test-A')).toBe(1.0);
    expect(result[1].label).toBe('other-suite/m2/200');
    expect(result[1].values.get('test-A')).toBe(9.0);
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
    mockCommitPickerHandle.element = document.createElement('div');
    mockCommitPickerHandle.input = document.createElement('input');

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
    (postOneCursorPage as ReturnType<typeof vi.fn>).mockResolvedValue({
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

  it('shows disabled metric selector then enabled selector after getFields resolves', async () => {
    graphPage.mount(container, { testsuite: 'nts' });

    // Loading state: disabled metric selector with placeholder
    const loading = container.querySelector('.metric-select') as HTMLSelectElement;
    expect(loading).toBeTruthy();
    expect(loading.disabled).toBe(true);

    // After fields load, metric selector should be enabled
    await vi.waitFor(() => {
      const select = container.querySelector('.metric-select') as HTMLSelectElement;
      expect(select).toBeTruthy();
      expect(select.disabled).toBe(false);
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
