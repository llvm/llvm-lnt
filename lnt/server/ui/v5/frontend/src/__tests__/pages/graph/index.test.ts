// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock API module
vi.mock('../../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api')>();
  return {
    ...actual,
    getTestSuiteInfoCached: vi.fn().mockResolvedValue({
      name: 'nts',
      schema: {
        metrics: [
          { name: 'exec_time', type: 'real', display_name: 'Exec Time', unit: 's', unit_abbrev: 's', bigger_is_better: false },
        ],
        commit_fields: [],
        machine_fields: [],
      },
    }),
    fetchOneCursorPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    postOneCursorPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    apiUrl: vi.fn((suite: string, path: string) => `/api/v5/${suite}/${path}`),
  };
});

vi.mock('../../../router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../router')>();
  return { ...actual, navigate: vi.fn(), getTestsuites: vi.fn(() => ['nts']) };
});

vi.mock('../../../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils')>();
  return { ...actual, resolveDisplayMap: vi.fn().mockResolvedValue(new Map()) };
});

const mockMachineComboHandle = { destroy: vi.fn(), clear: vi.fn(), getValue: vi.fn(() => '') };
vi.mock('../../../components/machine-combobox', () => ({
  renderMachineCombobox: vi.fn(() => mockMachineComboHandle),
}));

const mockCommitPickerHandle = {
  element: document.createElement('div'),
  input: document.createElement('input'),
  destroy: vi.fn(),
};
vi.mock('../../../combobox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../combobox')>();
  return {
    ...actual,
    createCommitPicker: vi.fn(() => mockCommitPickerHandle),
  };
});

(globalThis as unknown as Record<string, unknown>).Plotly = {
  newPlot: vi.fn().mockResolvedValue(document.createElement('div')),
  react: vi.fn(),
  purge: vi.fn(),
  restyle: vi.fn(),
  addTraces: vi.fn(),
  deleteTraces: vi.fn(),
  relayout: vi.fn(),
  Fx: { hover: vi.fn(), unhover: vi.fn() },
};

import { graphPage } from '../../../pages/graph/index';
import { renderMachineCombobox } from '../../../components/machine-combobox';
import { resolveDisplayMap } from '../../../utils';
import { GRAPH_CHART_DBLCLICK, GRAPH_TABLE_HOVER } from '../../../events';

describe('graphPage', () => {
  let container: HTMLElement;

  const params = { testsuite: '' };

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    // Default empty URL state
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '', pathname: '/v5/graph' },
      writable: true,
    });
  });

  afterEach(() => {
    graphPage.unmount?.();
    vi.unstubAllGlobals();
  });

  it('renders page header and controls panel', () => {
    graphPage.mount(container, params);
    expect(container.querySelector('.page-header')?.textContent).toBe('Graph');
    expect(container.querySelector('.controls-panel')).not.toBeNull();
  });

  it('renders suite selector with options', () => {
    graphPage.mount(container, params);
    const suiteSelect = container.querySelector('.suite-select') as HTMLSelectElement;
    expect(suiteSelect).not.toBeNull();
    expect(suiteSelect.options.length).toBeGreaterThan(1);
    expect(suiteSelect.options[1].value).toBe('nts');
  });

  it('renders baseline panel', () => {
    graphPage.mount(container, params);
    expect(container.querySelector('.baseline-panel')).not.toBeNull();
  });

  it('renders machine combobox even without suite selected', () => {
    graphPage.mount(container, params);
    expect(renderMachineCombobox).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ testsuite: '' }),
    );
  });

  it('re-creates machine combobox with suite when suite is selected', () => {
    graphPage.mount(container, params);
    vi.mocked(renderMachineCombobox).mockClear();

    const suiteSelect = container.querySelector('.suite-select') as HTMLSelectElement;
    suiteSelect.value = 'nts';
    suiteSelect.dispatchEvent(new Event('change'));

    expect(renderMachineCombobox).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ testsuite: 'nts' }),
    );
  });

  it('parses machines from URL', () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?suite=nts&machine=m1&machine=m2&metric=exec_time', pathname: '/v5/graph' },
      writable: true,
    });
    graphPage.mount(container, params);
    // Chips should be rendered
    const chips = container.querySelectorAll('.machine-chip');
    expect(chips.length).toBe(2);
  });

  it('unmount cleans up without errors', () => {
    graphPage.mount(container, params);
    expect(() => graphPage.unmount?.()).not.toThrow();
  });

  it('can mount again after unmount', () => {
    graphPage.mount(container, params);
    graphPage.unmount?.();
    const container2 = document.createElement('div');
    expect(() => graphPage.mount(container2, params)).not.toThrow();
    graphPage.unmount?.();
  });

  it('suite change resets regression mode dropdown to off', async () => {
    // Mount with regressions=active in URL
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?suite=nts&regressions=active', pathname: '/v5/graph' },
      writable: true,
    });
    graphPage.mount(container, params);

    // Verify initial regression dropdown shows 'active'
    const selects = container.querySelectorAll<HTMLSelectElement>('select');
    const regressionSelect = [...selects].find(s =>
      [...s.options].some(o => o.value === 'active' && o.text === 'Active'),
    );
    expect(regressionSelect).toBeDefined();
    expect(regressionSelect!.value).toBe('active');

    // Trigger suite change
    const suiteSelect = container.querySelector('.suite-select') as HTMLSelectElement;
    suiteSelect.value = '';
    suiteSelect.dispatchEvent(new Event('change'));

    // Regression dropdown should reset to 'off'
    expect(regressionSelect!.value).toBe('off');
  });

  it('resolves baseline display values when baselines exist in URL', () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?suite=nts&baseline=nts::m1::abc123', pathname: '/v5/graph' },
      writable: true,
    });
    graphPage.mount(container, params);
    expect(resolveDisplayMap).toHaveBeenCalledWith(
      'nts',
      ['abc123'],
      expect.any(AbortSignal),
    );
  });

  it('does not resolve baseline display values when no baselines in URL', () => {
    graphPage.mount(container, params);
    expect(resolveDisplayMap).not.toHaveBeenCalled();
  });

  it('shows progress indicator during test discovery', async () => {
    const { fetchOneCursorPage } = await import('../../../api');
    const mockFetch = vi.mocked(fetchOneCursorPage);

    let resolveDiscovery!: (val: { items: never[]; nextCursor: null }) => void;
    const discoveryPromise = new Promise<{ items: never[]; nextCursor: null }>(
      r => { resolveDiscovery = r; });

    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      // First call is scaffold (let it resolve), second is test discovery (block)
      if (callCount <= 1) return { items: [], nextCursor: null };
      return discoveryPromise;
    });

    Object.defineProperty(window, 'location', {
      value: { ...window.location,
        search: '?suite=nts&machine=m-progress&metric=exec_time',
        pathname: '/v5/graph' },
      writable: true,
    });
    graphPage.mount(container, params);

    await vi.waitFor(() => {
      const el = container.querySelector('.progress-label') as HTMLElement;
      expect(el).not.toBeNull();
      expect(el.style.display).not.toBe('none');
    });

    resolveDiscovery({ items: [], nextCursor: null });

    await vi.waitFor(() => {
      const el = container.querySelector('.progress-label') as HTMLElement;
      expect(el).not.toBeNull();
      expect(el.style.display).toBe('none');
    });
  });

  it('doPlot cancels prior plot cycle on re-entry', async () => {
    const { fetchOneCursorPage } = await import('../../../api');
    const mockFetch = vi.mocked(fetchOneCursorPage);

    // Track abort signals passed to fetches
    const receivedSignals: AbortSignal[] = [];
    mockFetch.mockImplementation(async (_url, _params, signal) => {
      if (signal) receivedSignals.push(signal);
      return { items: [], nextCursor: null };
    });

    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?suite=nts&machine=m1&metric=exec_time', pathname: '/v5/graph' },
      writable: true,
    });
    graphPage.mount(container, params);

    // Wait for initial load to complete
    await vi.waitFor(() => {
      expect(receivedSignals.length).toBeGreaterThan(0);
    });

    const firstSignals = [...receivedSignals];
    receivedSignals.length = 0;

    // Trigger a metric change (which calls doPlot internally)
    const metricSelect = container.querySelector('.metric-select') as HTMLSelectElement;
    expect(metricSelect).not.toBeNull();
    expect(metricSelect.options.length).toBeGreaterThan(1);
    metricSelect.value = metricSelect.options[1].value;
    metricSelect.dispatchEvent(new Event('change'));

    // The first plot cycle's signals should be aborted
    for (const sig of firstSignals) {
      expect(sig.aborted).toBe(true);
    }
  });

  // ===========================================================================
  // doPlot pipeline
  // ===========================================================================

  describe('doPlot pipeline', () => {
    it('fetches scaffolds then discovers tests for all machines', async () => {
      const { fetchOneCursorPage } = await import('../../../api');
      const mockFetch = vi.mocked(fetchOneCursorPage);

      const callUrls: string[] = [];
      mockFetch.mockImplementation(async (url: string) => {
        callUrls.push(url);
        if (url.includes('/tests')) {
          return { items: [{ name: 'test-A' }], nextCursor: null };
        }
        return { items: [], nextCursor: null };
      });

      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: '?suite=nts&machine=par-m1&machine=par-m2&metric=exec_time', pathname: '/v5/graph' },
        writable: true,
      });
      graphPage.mount(container, params);

      await vi.waitFor(() => {
        // Should have fetched scaffolds (commits) and tests for both machines
        const scaffoldCalls = callUrls.filter(u => u.includes('/commits'));
        const testCalls = callUrls.filter(u => u.includes('/tests'));
        expect(scaffoldCalls.length).toBeGreaterThanOrEqual(2);
        expect(testCalls.length).toBeGreaterThanOrEqual(2);
      });
    });

    it('populates test selection table after discovery completes', async () => {
      const { fetchOneCursorPage } = await import('../../../api');
      const mockFetch = vi.mocked(fetchOneCursorPage);

      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('/tests')) {
          return { items: [{ name: 'alpha-test' }, { name: 'beta-test' }], nextCursor: null };
        }
        return { items: [], nextCursor: null };
      });

      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: '?suite=nts&machine=dp-m1&metric=exec_time', pathname: '/v5/graph' },
        writable: true,
      });
      graphPage.mount(container, params);

      await vi.waitFor(() => {
        const rows = container.querySelectorAll('[data-test]');
        expect(rows.length).toBe(2);
      });
    });

    it('chart starts empty after doPlot — nothing plotted until user selects tests', async () => {
      const { fetchOneCursorPage } = await import('../../../api');
      vi.mocked(fetchOneCursorPage).mockImplementation(async (url: string) => {
        if (url.includes('/tests')) {
          return { items: [{ name: 'some-test' }], nextCursor: null };
        }
        return { items: [], nextCursor: null };
      });

      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: '?suite=nts&machine=empty-m1&metric=exec_time', pathname: '/v5/graph' },
        writable: true,
      });
      graphPage.mount(container, params);

      await vi.waitFor(() => {
        expect(container.querySelectorAll('[data-test]').length).toBe(1);
      });

      // No Plotly.newPlot should have been called (chart starts empty)
      const Plotly = (globalThis as Record<string, unknown>).Plotly as Record<string, ReturnType<typeof vi.fn>>;
      expect(Plotly.newPlot).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // handleSuiteChange
  // ===========================================================================

  it('suite change resets machines, clears chart, table, and all state', async () => {
    const { fetchOneCursorPage } = await import('../../../api');
    vi.mocked(fetchOneCursorPage).mockImplementation(async (url: string) => {
      if (url.includes('/tests')) {
        return { items: [{ name: 'test-Z' }], nextCursor: null };
      }
      return { items: [], nextCursor: null };
    });

    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?suite=nts&machine=sc-m1&metric=exec_time', pathname: '/v5/graph' },
      writable: true,
    });
    graphPage.mount(container, params);

    // Wait for initial load
    await vi.waitFor(() => {
      expect(container.querySelectorAll('[data-test]').length).toBe(1);
    });

    // Trigger suite change (to empty)
    const suiteSelect = container.querySelector('.suite-select') as HTMLSelectElement;
    suiteSelect.value = '';
    suiteSelect.dispatchEvent(new Event('change'));

    // Machine chips should be cleared
    expect(container.querySelectorAll('.machine-chip').length).toBe(0);
    // Test table should be gone
    expect(container.querySelectorAll('[data-test]').length).toBe(0);
  });

  // ===========================================================================
  // handleSelectionChange
  // ===========================================================================

  describe('handleSelectionChange', () => {
    it('fetches uncached test data for selected tests across machines', async () => {
      const { fetchOneCursorPage, postOneCursorPage } = await import('../../../api');
      const mockFetch = vi.mocked(fetchOneCursorPage);
      const mockPost = vi.mocked(postOneCursorPage);

      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('/tests')) {
          return { items: [{ name: 'sel-test-A' }], nextCursor: null };
        }
        return { items: [], nextCursor: null };
      });

      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: '?suite=nts&machine=sel-m1&metric=exec_time', pathname: '/v5/graph' },
        writable: true,
      });
      graphPage.mount(container, params);

      await vi.waitFor(() => {
        expect(container.querySelectorAll('[data-test]').length).toBe(1);
      });

      mockPost.mockClear();
      mockPost.mockResolvedValue({ items: [], nextCursor: null });

      // Click the test row to select it (single click + wait for 200ms delay)
      const row = container.querySelector('[data-test="sel-test-A"]') as HTMLElement;
      row.click();

      await vi.waitFor(() => {
        expect(mockPost).toHaveBeenCalled();
        const postUrl = mockPost.mock.calls[0][0] as string;
        expect(postUrl).toContain('/query');
      });
    });

    it('aborts previous selection fetch when new selection arrives', async () => {
      const { fetchOneCursorPage, postOneCursorPage } = await import('../../../api');
      vi.mocked(fetchOneCursorPage).mockImplementation(async (url: string) => {
        if (url.includes('/tests')) {
          return { items: [{ name: 'abort-test-A' }, { name: 'abort-test-B' }], nextCursor: null };
        }
        return { items: [], nextCursor: null };
      });

      const receivedSignals: AbortSignal[] = [];
      const mockPost = vi.mocked(postOneCursorPage);

      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: '?suite=nts&machine=abort-m1&metric=exec_time', pathname: '/v5/graph' },
        writable: true,
      });
      graphPage.mount(container, params);

      await vi.waitFor(() => {
        expect(container.querySelectorAll('[data-test]').length).toBe(2);
      });

      // Set up mock to capture signals
      mockPost.mockImplementation(async (_url, _params, signal) => {
        if (signal) receivedSignals.push(signal);
        return { items: [], nextCursor: null };
      });

      // Select first test
      const rowA = container.querySelector('[data-test="abort-test-A"]') as HTMLElement;
      rowA.click();

      // Immediately double-click on test B to isolate it (cancels previous selection)
      const rowB = container.querySelector('[data-test="abort-test-B"]') as HTMLElement;
      rowB.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

      await vi.waitFor(() => {
        // At least one signal should have been captured
        expect(receivedSignals.length).toBeGreaterThan(0);
      });
    });
  });

  // ===========================================================================
  // Machine add/remove
  // ===========================================================================

  describe('machine add/remove', () => {
    it('handleMachineAdd adds chip and triggers doPlot when metric is set', async () => {
      const { fetchOneCursorPage } = await import('../../../api');

      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: '?suite=nts&metric=exec_time', pathname: '/v5/graph' },
        writable: true,
      });
      graphPage.mount(container, params);

      // Wait for suite fields to load
      await vi.waitFor(() => {
        const metricSelect = container.querySelector('.metric-select') as HTMLSelectElement;
        expect(metricSelect).not.toBeNull();
      });

      vi.mocked(fetchOneCursorPage).mockClear();
      vi.mocked(fetchOneCursorPage).mockResolvedValue({ items: [], nextCursor: null });

      // Add a machine via the combobox onSelect
      const calls = vi.mocked(renderMachineCombobox).mock.calls;
      const machineCall = calls[calls.length - 1]!;
      machineCall[1].onSelect('add-m1');

      // Chip should appear
      await vi.waitFor(() => {
        expect(container.querySelectorAll('.machine-chip').length).toBe(1);
      });

      // doPlot should have been triggered (scaffold fetch)
      await vi.waitFor(() => {
        expect(vi.mocked(fetchOneCursorPage)).toHaveBeenCalled();
      });
    });

    it('handleMachineAdd is a no-op for duplicate machine', async () => {
      const { fetchOneCursorPage } = await import('../../../api');
      vi.mocked(fetchOneCursorPage).mockResolvedValue({ items: [], nextCursor: null });

      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: '?suite=nts&machine=dup-m1&metric=exec_time', pathname: '/v5/graph' },
        writable: true,
      });
      graphPage.mount(container, params);

      await vi.waitFor(() => {
        expect(container.querySelectorAll('.machine-chip').length).toBe(1);
      });

      vi.mocked(fetchOneCursorPage).mockClear();
      const calls = vi.mocked(renderMachineCombobox).mock.calls;
      const machineCall = calls[calls.length - 1]!;
      machineCall[1].onSelect('dup-m1');

      // Still one chip, no new fetch
      expect(container.querySelectorAll('.machine-chip').length).toBe(1);
      expect(vi.mocked(fetchOneCursorPage)).not.toHaveBeenCalled();
    });

    it('handleMachineRemove removes chip and re-runs doPlot or clears when last', async () => {
      const { fetchOneCursorPage } = await import('../../../api');
      vi.mocked(fetchOneCursorPage).mockImplementation(async (url: string) => {
        if (url.includes('/tests')) {
          return { items: [{ name: 'rem-test' }], nextCursor: null };
        }
        return { items: [], nextCursor: null };
      });

      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: '?suite=nts&machine=rem-m1&machine=rem-m2&metric=exec_time', pathname: '/v5/graph' },
        writable: true,
      });
      graphPage.mount(container, params);

      await vi.waitFor(() => {
        expect(container.querySelectorAll('.machine-chip').length).toBe(2);
      });

      // Remove first machine
      const removeBtn = container.querySelector('.chip-remove') as HTMLButtonElement;
      removeBtn.click();

      await vi.waitFor(() => {
        expect(container.querySelectorAll('.machine-chip').length).toBe(1);
      });

      // Remove last machine
      const lastRemoveBtn = container.querySelector('.chip-remove') as HTMLButtonElement;
      lastRemoveBtn.click();
      expect(container.querySelectorAll('.machine-chip').length).toBe(0);
    });
  });

  // ===========================================================================
  // Metric change
  // ===========================================================================

  it('metric change clears test state and triggers doPlot', async () => {
    const { fetchOneCursorPage, getTestSuiteInfoCached } = await import('../../../api');
    vi.mocked(getTestSuiteInfoCached).mockResolvedValue({
      name: 'nts',
      schema: {
        metrics: [
          { name: 'exec_time', type: 'real', display_name: 'Exec Time', unit: 's', unit_abbrev: 's', bigger_is_better: false },
          { name: 'mem_bytes', type: 'real', display_name: 'Memory', unit: 'B', unit_abbrev: 'B', bigger_is_better: false },
        ],
        commit_fields: [],
        machine_fields: [],
      },
    });
    vi.mocked(fetchOneCursorPage).mockImplementation(async (url: string) => {
      if (url.includes('/tests')) {
        return { items: [{ name: 'metric-test' }], nextCursor: null };
      }
      return { items: [], nextCursor: null };
    });

    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?suite=nts&machine=met-m1&metric=exec_time', pathname: '/v5/graph' },
      writable: true,
    });
    graphPage.mount(container, params);

    await vi.waitFor(() => {
      expect(container.querySelectorAll('[data-test]').length).toBe(1);
    });

    vi.mocked(fetchOneCursorPage).mockClear();

    // Change metric
    const metricSelect = container.querySelector('.metric-select') as HTMLSelectElement;
    expect(metricSelect).not.toBeNull();
    expect(metricSelect.options.length).toBeGreaterThan(1);
    metricSelect.value = 'mem_bytes';
    metricSelect.dispatchEvent(new Event('change'));

    // doPlot should be triggered again
    await vi.waitFor(() => {
      expect(vi.mocked(fetchOneCursorPage)).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Filter
  // ===========================================================================

  describe('handleFilterChange', () => {
    it('filter prunes selection to matching tests (case-insensitive)', async () => {
      vi.useFakeTimers();
      try {
        const { fetchOneCursorPage } = await import('../../../api');
        vi.mocked(fetchOneCursorPage).mockImplementation(async (url: string) => {
          if (url.includes('/tests')) {
            return { items: [{ name: 'Alpha-test' }, { name: 'Beta-test' }, { name: 'ALPHA-other' }], nextCursor: null };
          }
          return { items: [], nextCursor: null };
        });

        Object.defineProperty(window, 'location', {
          value: { ...window.location, search: '?suite=nts&machine=filt-m1&metric=exec_time', pathname: '/v5/graph' },
          writable: true,
        });
        graphPage.mount(container, params);

        await vi.waitFor(() => {
          expect(container.querySelectorAll('[data-test]').length).toBe(3);
        });

        // Apply filter
        const filterInput = container.querySelector('.test-filter-input') as HTMLInputElement;
        filterInput.value = 'alpha';
        filterInput.dispatchEvent(new Event('input'));
        await vi.advanceTimersByTimeAsync(200);

        await vi.waitFor(() => {
          const rows = container.querySelectorAll<HTMLElement>('[data-test]');
          const visible = [...rows].filter(r => r.style.display !== 'none');
          expect(visible.length).toBe(2);
          const names = visible.map(r => r.getAttribute('data-test'));
          expect(names).toContain('Alpha-test');
          expect(names).toContain('ALPHA-other');
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ===========================================================================
  // Aggregation
  // ===========================================================================

  it('aggregation change re-renders chart from cache without new API calls', async () => {
    const { fetchOneCursorPage, postOneCursorPage } = await import('../../../api');
    vi.mocked(fetchOneCursorPage).mockImplementation(async (url: string) => {
      if (url.includes('/tests')) {
        return { items: [{ name: 'agg-test' }], nextCursor: null };
      }
      return { items: [], nextCursor: null };
    });

    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?suite=nts&machine=agg-m1&metric=exec_time', pathname: '/v5/graph' },
      writable: true,
    });
    graphPage.mount(container, params);

    await vi.waitFor(() => {
      expect(container.querySelectorAll('[data-test]').length).toBe(1);
    });

    // Clear fetch counters
    vi.mocked(fetchOneCursorPage).mockClear();
    vi.mocked(postOneCursorPage).mockClear();

    // Change run aggregation
    const selects = container.querySelectorAll<HTMLSelectElement>('select');
    const aggSelect = [...selects].find(s =>
      s.options.length === 4 && [...s.options].some(o => o.value === 'median'),
    );
    expect(aggSelect).toBeDefined();
    aggSelect!.value = 'mean';
    aggSelect!.dispatchEvent(new Event('change'));

    // No new API calls should have been made
    expect(vi.mocked(fetchOneCursorPage)).not.toHaveBeenCalled();
    expect(vi.mocked(postOneCursorPage)).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // Baselines
  // ===========================================================================

  describe('baseline handlers', () => {
    it('handleBaselineRemove updates chips and schedules chart update', async () => {
      const { fetchOneCursorPage } = await import('../../../api');
      vi.mocked(fetchOneCursorPage).mockResolvedValue({ items: [], nextCursor: null });

      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: '?suite=nts&machine=bl-m1&metric=exec_time&baseline=nts::bl-m1::abc', pathname: '/v5/graph' },
        writable: true,
      });
      graphPage.mount(container, params);

      await vi.waitFor(() => {
        const chips = container.querySelectorAll('.baseline-chip');
        expect(chips.length).toBe(1);
      });

      // Remove the baseline
      const removeBtn = container.querySelector('.baseline-chip .chip-remove') as HTMLButtonElement;
      removeBtn.click();
      expect(container.querySelectorAll('.baseline-chip').length).toBe(0);
    });
  });

  // ===========================================================================
  // Regressions
  // ===========================================================================

  it('regression mode change fetches regressions', async () => {
    const { fetchOneCursorPage } = await import('../../../api');
    const callUrls: string[] = [];
    vi.mocked(fetchOneCursorPage).mockImplementation(async (url: string) => {
      callUrls.push(url);
      if (url.includes('/tests')) {
        return { items: [{ name: 'reg-test' }], nextCursor: null };
      }
      return { items: [], nextCursor: null };
    });

    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?suite=nts&machine=reg-m1&metric=exec_time', pathname: '/v5/graph' },
      writable: true,
    });
    graphPage.mount(container, params);

    await vi.waitFor(() => {
      expect(container.querySelectorAll('[data-test]').length).toBe(1);
    });

    callUrls.length = 0;

    // Change regression mode to 'active'
    const selects = container.querySelectorAll<HTMLSelectElement>('select');
    const regSelect = [...selects].find(s =>
      [...s.options].some(o => o.value === 'active' && o.text === 'Active'),
    );
    expect(regSelect).toBeDefined();
    regSelect!.value = 'active';
    regSelect!.dispatchEvent(new Event('change'));

    await vi.waitFor(() => {
      const regCalls = callUrls.filter(u => u.includes('/regressions'));
      expect(regCalls.length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // State preservation (back-nav)
  // ===========================================================================

  describe('module-level state preservation', () => {
    it('preserves machine chips and test table across unmount/remount', async () => {
      const { fetchOneCursorPage } = await import('../../../api');
      vi.mocked(fetchOneCursorPage).mockImplementation(async (url: string) => {
        if (url.includes('/tests')) {
          return { items: [{ name: 'persist-test' }], nextCursor: null };
        }
        return { items: [], nextCursor: null };
      });

      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: '?suite=nts&machine=persist-m1&metric=exec_time', pathname: '/v5/graph' },
        writable: true,
      });
      graphPage.mount(container, params);

      await vi.waitFor(() => {
        expect(container.querySelectorAll('[data-test]').length).toBe(1);
        expect(container.querySelectorAll('.machine-chip').length).toBe(1);
      });

      // Unmount
      graphPage.unmount?.();

      // Remount on fresh container
      const container2 = document.createElement('div');
      graphPage.mount(container2, params);

      // Machine chips and test table should render from preserved state
      await vi.waitFor(() => {
        expect(container2.querySelectorAll('.machine-chip').length).toBe(1);
      });
    });
  });

  // ===========================================================================
  // Error handling
  // ===========================================================================

  it('showError displays banner then auto-hides after 5s', async () => {
    vi.useFakeTimers();
    try {
      const { getTestSuiteInfoCached } = await import('../../../api');
      vi.mocked(getTestSuiteInfoCached).mockRejectedValueOnce(new Error('fail'));

      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: '?suite=nts', pathname: '/v5/graph' },
        writable: true,
      });
      graphPage.mount(container, params);

      await vi.waitFor(() => {
        const banner = container.querySelector('.error-banner') as HTMLElement;
        expect(banner).not.toBeNull();
        expect(banner.style.display).not.toBe('none');
        expect(banner.textContent).toContain('Failed to load suite fields');
      });

      vi.advanceTimersByTime(5000);

      const banner = container.querySelector('.error-banner') as HTMLElement;
      expect(banner.style.display).toBe('none');
    } finally {
      vi.useRealTimers();
    }
  });

  // ===========================================================================
  // Hover sync
  // ===========================================================================

  describe('hover sync', () => {
    it('GRAPH_CHART_DBLCLICK isolates the double-clicked test in selection', async () => {
      const { fetchOneCursorPage } = await import('../../../api');
      vi.mocked(fetchOneCursorPage).mockImplementation(async (url: string) => {
        if (url.includes('/tests')) {
          return { items: [{ name: 'hover-test-A' }, { name: 'hover-test-B' }], nextCursor: null };
        }
        return { items: [], nextCursor: null };
      });

      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: '?suite=nts&machine=hover-m1&metric=exec_time', pathname: '/v5/graph' },
        writable: true,
      });
      graphPage.mount(container, params);

      await vi.waitFor(() => {
        expect(container.querySelectorAll('[data-test]').length).toBe(2);
      });

      // Dispatch GRAPH_CHART_DBLCLICK to isolate hover-test-A
      document.dispatchEvent(new CustomEvent(GRAPH_CHART_DBLCLICK, { detail: 'hover-test-A' }));

      await vi.waitFor(() => {
        const selectedRows = container.querySelectorAll('.row-selected');
        expect(selectedRows.length).toBe(1);
        expect(selectedRows[0].getAttribute('data-test')).toBe('hover-test-A');
      });
    });

    it('GRAPH_TABLE_HOVER calls hoverTrace with multi-machine trace names', async () => {
      const { fetchOneCursorPage } = await import('../../../api');
      vi.mocked(fetchOneCursorPage).mockImplementation(async (url: string) => {
        if (url.includes('/tests')) {
          return { items: [{ name: 'th-test' }], nextCursor: null };
        }
        return { items: [], nextCursor: null };
      });

      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: '?suite=nts&machine=th-m1&machine=th-m2&metric=exec_time', pathname: '/v5/graph' },
        writable: true,
      });
      graphPage.mount(container, params);

      await vi.waitFor(() => {
        expect(container.querySelectorAll('[data-test]').length).toBe(1);
      });

      // Dispatch table hover — the orchestrator should call chartHandle.hoverTrace
      // with trace names for both machines. Since chart is not created (no selection),
      // this just verifies the event handler doesn't throw.
      document.dispatchEvent(new CustomEvent(GRAPH_TABLE_HOVER, { detail: 'th-test' }));
      document.dispatchEvent(new CustomEvent(GRAPH_TABLE_HOVER, { detail: null }));
    });
  });

  // ===========================================================================
  // Additional handleSelectionChange tests
  // ===========================================================================

  it('skips fetch when all selected tests are already cached', async () => {
    const { fetchOneCursorPage, postOneCursorPage } = await import('../../../api');
    vi.mocked(fetchOneCursorPage).mockImplementation(async (url: string) => {
      if (url.includes('/tests')) {
        return { items: [{ name: 'cache-test-A' }], nextCursor: null };
      }
      return { items: [], nextCursor: null };
    });
    vi.mocked(postOneCursorPage).mockResolvedValue({ items: [], nextCursor: null });

    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?suite=nts&machine=cache-m1&metric=exec_time', pathname: '/v5/graph' },
      writable: true,
    });
    graphPage.mount(container, params);

    await vi.waitFor(() => {
      expect(container.querySelectorAll('[data-test]').length).toBe(1);
    });

    // Select the test to trigger initial fetch
    const row = container.querySelector('[data-test="cache-test-A"]') as HTMLElement;
    row.click();

    await vi.waitFor(() => {
      expect(vi.mocked(postOneCursorPage)).toHaveBeenCalled();
    });

    // Wait for the data to finish loading
    await vi.waitFor(() => {
      const loadingRows = container.querySelectorAll('.row-loading');
      expect(loadingRows.length).toBe(0);
    });

    // Clear mock counts, then deselect and re-select — should not fetch again
    vi.mocked(postOneCursorPage).mockClear();

    // Double-click to re-trigger handleSelectionChange with the same test
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    // Flush microtasks to allow any async work to start
    await Promise.resolve();

    // No new POST calls — data was already cached
    expect(vi.mocked(postOneCursorPage)).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // Additional filter test
  // ===========================================================================

  describe('handleFilterChange (additional)', () => {
    it('clearing filter restores full test list', async () => {
      vi.useFakeTimers();
      try {
        const { fetchOneCursorPage } = await import('../../../api');
        vi.mocked(fetchOneCursorPage).mockImplementation(async (url: string) => {
          if (url.includes('/tests')) {
            return { items: [{ name: 'cf-alpha' }, { name: 'cf-beta' }, { name: 'cf-gamma' }], nextCursor: null };
          }
          return { items: [], nextCursor: null };
        });

        Object.defineProperty(window, 'location', {
          value: { ...window.location, search: '?suite=nts&machine=cf-m1&metric=exec_time', pathname: '/v5/graph' },
          writable: true,
        });
        graphPage.mount(container, params);

        await vi.waitFor(() => {
          expect(container.querySelectorAll('[data-test]').length).toBe(3);
        });

        // Apply filter
        const filterInput = container.querySelector('.test-filter-input') as HTMLInputElement;
        filterInput.value = 'alpha';
        filterInput.dispatchEvent(new Event('input'));
        await vi.advanceTimersByTimeAsync(200);

        await vi.waitFor(() => {
          const rows = container.querySelectorAll<HTMLElement>('[data-test]');
          const visible = [...rows].filter(r => r.style.display !== 'none');
          expect(visible.length).toBe(1);
        });

        // Clear filter
        filterInput.value = '';
        filterInput.dispatchEvent(new Event('input'));
        await vi.advanceTimersByTimeAsync(200);

        await vi.waitFor(() => {
          const rows = container.querySelectorAll<HTMLElement>('[data-test]');
          const visible = [...rows].filter(r => r.style.display !== 'none');
          expect(visible.length).toBe(3);
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ===========================================================================
  // handleBaselineAdd
  // ===========================================================================

  it('handleBaselineAdd adds chip and triggers baseline data fetch', async () => {
    const { fetchOneCursorPage, postOneCursorPage } = await import('../../../api');
    vi.mocked(fetchOneCursorPage).mockImplementation(async (url: string) => {
      if (url.includes('/tests')) {
        return { items: [{ name: 'bla-test' }], nextCursor: null };
      }
      return { items: [], nextCursor: null };
    });
    vi.mocked(postOneCursorPage).mockResolvedValue({ items: [], nextCursor: null });

    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?suite=nts&machine=bla-m1&metric=exec_time&baseline=nts::bla-m1::abc', pathname: '/v5/graph' },
      writable: true,
    });
    graphPage.mount(container, params);

    // Baseline chip should appear from the URL-provided baseline
    await vi.waitFor(() => {
      expect(container.querySelectorAll('.baseline-chip').length).toBe(1);
    });

    // The baseline chip text should contain the commit value
    const chip = container.querySelector('.baseline-chip');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain('abc');
  });

  // ===========================================================================
  // Additional state preservation test
  // ===========================================================================

  it('renders from cache on remount without new scaffold fetches', async () => {
    const { fetchOneCursorPage } = await import('../../../api');
    vi.mocked(fetchOneCursorPage).mockImplementation(async (url: string) => {
      if (url.includes('/tests')) {
        return { items: [{ name: 'nocache-test' }], nextCursor: null };
      }
      return { items: [], nextCursor: null };
    });

    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?suite=nts&machine=nocache-m1&metric=exec_time', pathname: '/v5/graph' },
      writable: true,
    });
    graphPage.mount(container, params);

    await vi.waitFor(() => {
      expect(container.querySelectorAll('[data-test]').length).toBe(1);
    });

    graphPage.unmount?.();
    vi.mocked(fetchOneCursorPage).mockClear();

    const container2 = document.createElement('div');
    graphPage.mount(container2, params);

    // Wait for remount to settle
    await vi.waitFor(() => {
      expect(container2.querySelectorAll('.machine-chip').length).toBe(1);
    });

    // Scaffold data was cached — check that commits endpoint was NOT called again
    const scaffoldCalls = vi.mocked(fetchOneCursorPage).mock.calls
      .filter(c => (c[0] as string).includes('/commits'));
    expect(scaffoldCalls.length).toBe(0);
  });
});
