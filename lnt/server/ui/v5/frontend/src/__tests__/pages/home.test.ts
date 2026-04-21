// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the API module
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    getTestSuiteInfo: vi.fn(),
    getRunsPage: vi.fn(),
    fetchTrends: vi.fn(),
  };
});

// Mock router (getTestsuites)
vi.mock('../../router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../router')>();
  return {
    ...actual,
    getTestsuites: vi.fn(() => ['nts', 'compile-suite']),
    getUrlBase: vi.fn(() => ''),
  };
});

// Mock Plotly
(globalThis as unknown as Record<string, unknown>).Plotly = {
  newPlot: vi.fn().mockResolvedValue(document.createElement('div')),
  react: vi.fn(),
  purge: vi.fn(),
  Fx: { hover: vi.fn(), unhover: vi.fn() },
};
(globalThis as unknown as Record<string, unknown>).lnt_url_base = '';

import { getTestSuiteInfo, getRunsPage, fetchTrends } from '../../api';
import type { CursorPageResult, TrendsDataPoint } from '../../api';
import { homePage } from '../../pages/home';
import type { RunInfo, TestSuiteInfo } from '../../types';

const mockSuiteInfo: TestSuiteInfo = {
  name: 'nts',
  schema: {
    metrics: [
      { name: 'execution_time', type: 'real', display_name: 'Execution Time', unit: 'seconds', unit_abbrev: 's', bigger_is_better: false },
      { name: 'compile_time', type: 'real', display_name: 'Compile Time', unit: 'seconds', unit_abbrev: 's', bigger_is_better: false },
    ],
    commit_fields: [{ name: 'llvm_project_revision', type: 'text' }],
    machine_fields: [],
  },
};

const mockSuiteInfo2: TestSuiteInfo = {
  name: 'compile-suite',
  schema: {
    metrics: [
      { name: 'score', type: 'real', display_name: 'Score', unit: null, unit_abbrev: null, bigger_is_better: true },
    ],
    commit_fields: [{ name: 'revision', type: 'text' }],
    machine_fields: [],
  },
};

const mockRuns: RunInfo[] = [
  { uuid: 'r1', machine: 'machine-a', commit: '100', submitted_at: '2026-01-01T10:00:00Z' },
  { uuid: 'r2', machine: 'machine-b', commit: '101', submitted_at: '2026-01-02T10:00:00Z' },
  { uuid: 'r3', machine: 'machine-a', commit: '102', submitted_at: '2026-01-03T10:00:00Z' },
];

function mockRunsPage(items: RunInfo[], nextCursor: string | null = null): CursorPageResult<RunInfo> {
  return { items, nextCursor };
}

const mockTrendsData: TrendsDataPoint[] = [
  { machine: 'machine-a', commit: '100', ordinal: 100, tag: null, submitted_at: '2026-01-01T10:00:00Z', value: 14.14 },
];

let container: HTMLElement;
let savedReplaceState: typeof window.history.replaceState;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);

  // Mock window.history.replaceState
  savedReplaceState = window.history.replaceState;
  window.history.replaceState = vi.fn();

  // Default mock implementations
  (getTestSuiteInfo as ReturnType<typeof vi.fn>).mockImplementation((suite: string) => {
    if (suite === 'nts') return Promise.resolve(mockSuiteInfo);
    return Promise.resolve(mockSuiteInfo2);
  });
  (getRunsPage as ReturnType<typeof vi.fn>).mockResolvedValue(mockRunsPage(mockRuns));
  (fetchTrends as ReturnType<typeof vi.fn>).mockResolvedValue(mockTrendsData);
});

afterEach(() => {
  if (homePage.unmount) homePage.unmount();
  container.remove();
  window.history.replaceState = savedReplaceState;
});

describe('Dashboard page', () => {
  it('renders a Dashboard heading', async () => {
    homePage.mount(container, { testsuite: '' });

    expect(container.querySelector('h2')?.textContent).toBe('Dashboard');
  });

  it('renders a suite section header for each test suite', async () => {
    homePage.mount(container, { testsuite: '' });

    const h3s = container.querySelectorAll('h3');
    expect(h3s.length).toBe(2);
    expect(h3s[0].textContent).toBe('nts');
    expect(h3s[1].textContent).toBe('compile-suite');
  });

  it('renders commit range buttons with Last 500 active by default', () => {
    homePage.mount(container, { testsuite: '' });

    const buttons = container.querySelectorAll('.dashboard-range-btn');
    expect(buttons.length).toBe(3);
    expect(buttons[0].textContent).toBe('Last 100');
    expect(buttons[1].textContent).toBe('Last 500');
    expect(buttons[2].textContent).toBe('Last 1000');
    expect(buttons[1].classList.contains('dashboard-range-btn-active')).toBe(true);
    expect(buttons[0].classList.contains('dashboard-range-btn-active')).toBe(false);
  });

  it('renders sparkline cards with correct metric titles after data loads', async () => {
    homePage.mount(container, { testsuite: '' });

    // Wait for async data loading to complete
    await vi.waitFor(() => {
      const titles = container.querySelectorAll('.sparkline-title');
      expect(titles.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 500 });

    const titles = Array.from(container.querySelectorAll('.sparkline-title'));
    const titleTexts = titles.map(t => t.textContent);
    expect(titleTexts).toContain('Execution Time (s)');
    expect(titleTexts).toContain('Compile Time (s)');
    expect(titleTexts).toContain('Score');
  });

  it('fetches suite info and runs for each suite', async () => {
    homePage.mount(container, { testsuite: '' });

    await vi.waitFor(() => {
      expect(getTestSuiteInfo).toHaveBeenCalledWith('nts', expect.anything());
      expect(getTestSuiteInfo).toHaveBeenCalledWith('compile-suite', expect.anything());
      expect(getRunsPage).toHaveBeenCalledTimes(2);
    }, { timeout: 500 });
  });

  it('passes lastN to fetchTrends', async () => {
    homePage.mount(container, { testsuite: '' });

    await vi.waitFor(() => {
      expect(fetchTrends).toHaveBeenCalled();
    }, { timeout: 500 });

    // Default range is 500, so lastN should be 500
    const call = (fetchTrends as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toHaveProperty('lastN', 500);
  });

  it('passes trend data through to Plotly sparkline charts', async () => {
    homePage.mount(container, { testsuite: '' });

    await vi.waitFor(() => {
      const calls = ((globalThis as Record<string, unknown>).Plotly as Record<string, ReturnType<typeof vi.fn>>).newPlot.mock.calls;
      // Find a call with non-empty trace data (not a loading placeholder)
      const dataCall = calls.find(
        (c: unknown[]) => Array.isArray(c[1]) && c[1].length > 0 && c[1][0].x?.length > 0,
      );
      expect(dataCall).toBeTruthy();
    }, { timeout: 500 });
  });
});
