// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the API module
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    getMachines: vi.fn(),
    getRunsPage: vi.fn(),
    getCommitsPage: vi.fn(),
    getRegressions: vi.fn(),
    getFields: vi.fn(),
    getToken: vi.fn(),
  };
});

// Mock router (getTestsuites)
vi.mock('../../router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../router')>();
  return {
    ...actual,
    getTestsuites: vi.fn(() => ['nts', 'test-suite-2']),
  };
});

// Mock Plotly (may be loaded by transitive imports)
(globalThis as unknown as Record<string, unknown>).Plotly = {
  newPlot: vi.fn(),
  react: vi.fn(),
  purge: vi.fn(),
  Fx: { hover: vi.fn(), unhover: vi.fn() },
};
// Mock lnt_url_base
(globalThis as unknown as Record<string, unknown>).lnt_url_base = '';

import { getMachines, getRunsPage, getCommitsPage, getRegressions, getFields, getToken } from '../../api';
import type { CursorPageResult } from '../../api';
import { getTestsuites } from '../../router';
import { testSuitesPage } from '../../pages/test-suites';
import type { RunInfo, MachineInfo, CommitSummary, RegressionListItem } from '../../types';

const mockMachines: MachineInfo[] = [
  { name: 'clang-x86', info: { os: 'linux' } },
  { name: 'gcc-arm', info: { os: 'linux' } },
];

const mockRuns: RunInfo[] = [
  { uuid: 'aaaa-1111', machine: 'clang-x86', commit: '100', submitted_at: '2026-01-01T10:00:00Z' },
  { uuid: 'bbbb-2222', machine: 'gcc-arm', commit: '101', submitted_at: '2026-01-02T10:00:00Z' },
];

const mockCommits: CommitSummary[] = [
  { commit: '100', ordinal: 1, tag: null, fields: {} },
  { commit: '101', ordinal: null, tag: null, fields: {} },
];

const mockRegressions: RegressionListItem[] = [
  { uuid: 'reg-1111', title: 'compile_time regression', bug: null, state: 'active', commit: '100', machine_count: 2, test_count: 3 },
  { uuid: 'reg-2222', title: 'exec_time regression', bug: null, state: 'detected', commit: null, machine_count: 1, test_count: 1 },
];

function mockRunsPage(items: RunInfo[], nextCursor: string | null = null): CursorPageResult<RunInfo> {
  return { items, nextCursor };
}

function mockCommitsPage(items: CommitSummary[], nextCursor: string | null = null): CursorPageResult<CommitSummary> {
  return { items, nextCursor };
}

function mockRegressionsPage(items: RegressionListItem[], nextCursor: string | null = null): CursorPageResult<RegressionListItem> {
  return { items, nextCursor };
}

describe('testSuitesPage', () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');

    // Reset router mock
    (getTestsuites as ReturnType<typeof vi.fn>).mockReturnValue(['nts', 'test-suite-2']);

    // Default mocks
    (getMachines as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: mockMachines,
      total: mockMachines.length,
    });
    (getRunsPage as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockRunsPage(mockRuns),
    );
    (getCommitsPage as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockCommitsPage(mockCommits),
    );
    (getRegressions as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockRegressionsPage(mockRegressions),
    );
    (getToken as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (getFields as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    // Clear URL query params
    window.history.replaceState(null, '', window.location.pathname);
  });

  afterEach(() => {
    testSuitesPage.unmount?.();
  });

  it('renders Test Suites heading', () => {
    testSuitesPage.mount(container, { testsuite: '' });
    expect(container.querySelector('.page-header')?.textContent).toBe('Test Suites');
  });

  it('renders suite picker cards from getTestsuites()', () => {
    testSuitesPage.mount(container, { testsuite: '' });

    const cards = container.querySelectorAll('.suite-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toBe('nts');
    expect(cards[1].textContent).toBe('test-suite-2');
  });

  it('does not show tabs when no suite is selected', () => {
    testSuitesPage.mount(container, { testsuite: '' });

    const tabBar = container.querySelector('.v5-tab-bar') as HTMLElement;
    expect(tabBar).toBeTruthy();
    expect(tabBar.style.display).toBe('none');
  });

  it('shows tabs after clicking a suite card', async () => {
    testSuitesPage.mount(container, { testsuite: '' });

    // Click the first suite card
    const card = container.querySelector('.suite-card') as HTMLElement;
    card.click();

    const tabBar = container.querySelector('.v5-tab-bar') as HTMLElement;
    expect(tabBar.style.display).not.toBe('none');

    // Should have 5 tabs
    const tabs = tabBar.querySelectorAll('.v5-tab');
    expect(tabs).toHaveLength(5);
    expect(tabs[0].textContent).toBe('Recent Activity');
    expect(tabs[1].textContent).toBe('Machines');
    expect(tabs[2].textContent).toBe('Runs');
    expect(tabs[3].textContent).toBe('Commits');
    expect(tabs[4].textContent).toBe('Regressions');
  });

  it('highlights the selected suite card', () => {
    testSuitesPage.mount(container, { testsuite: '' });

    const cards = container.querySelectorAll('.suite-card');
    (cards[0] as HTMLElement).click();

    expect(cards[0].classList.contains('suite-card-active')).toBe(true);
    expect(cards[1].classList.contains('suite-card-active')).toBe(false);
  });

  it('loads Recent Activity tab by default when suite is selected', async () => {
    testSuitesPage.mount(container, { testsuite: '' });

    (container.querySelector('.suite-card') as HTMLElement).click();

    // Recent Activity tab should be active
    const activeTab = container.querySelector('.v5-tab-active');
    expect(activeTab?.textContent).toBe('Recent Activity');

    // Should call getRunsPage for recent activity
    await vi.waitFor(() => {
      expect(getRunsPage).toHaveBeenCalledWith(
        'nts',
        expect.objectContaining({ sort: '-submitted_at', limit: 25 }),
        expect.any(AbortSignal),
      );
    });
  });

  it('Recent Activity tab renders run table', async () => {
    testSuitesPage.mount(container, { testsuite: '' });
    (container.querySelector('.suite-card') as HTMLElement).click();

    await vi.waitFor(() => {
      const headers = Array.from(container.querySelectorAll('th')).map(h => h.textContent);
      expect(headers).toContain('Machine');
      expect(headers).toContain('Commit');
      expect(headers).toContain('Submitted');
      expect(headers).toContain('Run');
    });
  });

  it('Machines tab loads machine list with offset pagination', async () => {
    testSuitesPage.mount(container, { testsuite: '' });
    (container.querySelector('.suite-card') as HTMLElement).click();

    // Click Machines tab
    const machinesTab = Array.from(container.querySelectorAll('.v5-tab'))
      .find(t => t.textContent === 'Machines') as HTMLElement;
    machinesTab.click();

    await vi.waitFor(() => {
      expect(getMachines).toHaveBeenCalledWith(
        'nts',
        expect.objectContaining({ limit: 25, offset: 0 }),
        expect.any(AbortSignal),
      );
    });

    // Should show machine names
    await vi.waitFor(() => {
      expect(container.textContent).toContain('clang-x86');
      expect(container.textContent).toContain('gcc-arm');
    });
  });

  it('Machines tab has search input', async () => {
    testSuitesPage.mount(container, { testsuite: '' });
    (container.querySelector('.suite-card') as HTMLElement).click();

    // Switch to Machines tab
    const machinesTab = Array.from(container.querySelectorAll('.v5-tab'))
      .find(t => t.textContent === 'Machines') as HTMLElement;
    machinesTab.click();

    await vi.waitFor(() => {
      const searchInput = container.querySelector('.test-filter-input') as HTMLInputElement;
      expect(searchInput).toBeTruthy();
      expect(searchInput.placeholder).toContain('Filter by name');
    });
  });

  it('Runs tab loads runs with cursor pagination', async () => {
    testSuitesPage.mount(container, { testsuite: '' });
    (container.querySelector('.suite-card') as HTMLElement).click();

    // Click Runs tab
    const runsTab = Array.from(container.querySelectorAll('.v5-tab'))
      .find(t => t.textContent === 'Runs') as HTMLElement;
    runsTab.click();

    await vi.waitFor(() => {
      // Should call getRunsPage (once for Recent Activity, once for Runs tab)
      const calls = (getRunsPage as ReturnType<typeof vi.fn>).mock.calls;
      const runsTabCall = calls.find(
        (c: unknown[]) => (c[1] as Record<string, unknown>)?.sort === '-submitted_at',
      );
      expect(runsTabCall).toBeTruthy();
    });
  });

  it('Runs tab has machine filter input', async () => {
    testSuitesPage.mount(container, { testsuite: '' });
    (container.querySelector('.suite-card') as HTMLElement).click();

    const runsTab = Array.from(container.querySelectorAll('.v5-tab'))
      .find(t => t.textContent === 'Runs') as HTMLElement;
    runsTab.click();

    await vi.waitFor(() => {
      const searchInput = container.querySelector('.test-filter-input') as HTMLInputElement;
      expect(searchInput).toBeTruthy();
      expect(searchInput.placeholder).toContain('machine');
    });
  });

  it('Commits tab loads commits with cursor pagination', async () => {
    testSuitesPage.mount(container, { testsuite: '' });
    (container.querySelector('.suite-card') as HTMLElement).click();

    // Click Commits tab
    const commitsTab = Array.from(container.querySelectorAll('.v5-tab'))
      .find(t => t.textContent === 'Commits') as HTMLElement;
    commitsTab.click();

    await vi.waitFor(() => {
      expect(getCommitsPage).toHaveBeenCalledWith(
        'nts',
        expect.objectContaining({ limit: 25 }),
        expect.any(AbortSignal),
      );
    });
  });

  it('Commits tab shows commit values and ordinals', async () => {
    testSuitesPage.mount(container, { testsuite: '' });
    (container.querySelector('.suite-card') as HTMLElement).click();

    // Wait for Recent Activity to load first
    await vi.waitFor(() => {
      expect(container.querySelector('table')).toBeTruthy();
    });

    const commitsTab = Array.from(container.querySelectorAll('.v5-tab'))
      .find(t => t.textContent === 'Commits') as HTMLElement;
    commitsTab.click();

    await vi.waitFor(() => {
      // Check the table has Commit and Ordinal columns
      const headers = Array.from(container.querySelectorAll('th')).map(h => h.textContent);
      expect(headers).toContain('Commit');
      expect(headers).toContain('Ordinal');
      expect(container.textContent).toContain('100');
      expect(container.textContent).toContain('1');
      expect(container.textContent).toContain('101');
    });
  });

  it('restores state from URL query params on mount', async () => {
    // Set URL with suite and tab pre-selected
    window.history.replaceState(null, '', '?suite=nts&tab=machines');

    testSuitesPage.mount(container, { testsuite: '' });

    // Suite card should be highlighted
    const activeCard = container.querySelector('.suite-card-active');
    expect(activeCard?.textContent).toBe('nts');

    // Tabs should be visible
    const tabBar = container.querySelector('.v5-tab-bar') as HTMLElement;
    expect(tabBar.style.display).not.toBe('none');

    // Machines tab should be active
    const activeTab = container.querySelector('.v5-tab-active');
    expect(activeTab?.textContent).toBe('Machines');

    // Should load machines
    await vi.waitFor(() => {
      expect(getMachines).toHaveBeenCalled();
    });
  });

  it('tab switching updates the active tab class', async () => {
    testSuitesPage.mount(container, { testsuite: '' });
    (container.querySelector('.suite-card') as HTMLElement).click();

    // Default: Recent Activity is active
    expect(container.querySelector('.v5-tab-active')?.textContent).toBe('Recent Activity');

    // Click Machines tab
    const machinesTab = Array.from(container.querySelectorAll('.v5-tab'))
      .find(t => t.textContent === 'Machines') as HTMLElement;
    machinesTab.click();

    expect(container.querySelector('.v5-tab-active')?.textContent).toBe('Machines');
  });

  it('switching suites resets to Recent Activity tab', async () => {
    testSuitesPage.mount(container, { testsuite: '' });

    // Select first suite and switch to Machines tab
    const cards = container.querySelectorAll('.suite-card');
    (cards[0] as HTMLElement).click();

    const machinesTab = Array.from(container.querySelectorAll('.v5-tab'))
      .find(t => t.textContent === 'Machines') as HTMLElement;
    machinesTab.click();

    // Now select second suite
    (cards[1] as HTMLElement).click();

    // Should reset to Recent Activity
    expect(container.querySelector('.v5-tab-active')?.textContent).toBe('Recent Activity');
  });

  it('unmount aborts without error', () => {
    (getRunsPage as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    testSuitesPage.mount(container, { testsuite: '' });
    expect(() => testSuitesPage.unmount!()).not.toThrow();
  });

  it('shows empty message when no test suites available', () => {
    // Override getTestsuites to return empty
    (getTestsuites as ReturnType<typeof vi.fn>).mockReturnValue([]);

    testSuitesPage.mount(container, { testsuite: '' });

    expect(container.textContent).toContain('No test suites available');
  });

  it('shows error banner when Recent Activity fails to load', async () => {
    (getRunsPage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

    testSuitesPage.mount(container, { testsuite: '' });
    (container.querySelector('.suite-card') as HTMLElement).click();

    await vi.waitFor(() => {
      const banner = container.querySelector('.error-banner');
      expect(banner).toBeTruthy();
      expect(banner!.textContent).toContain('Failed to load recent activity');
    });
  });

  it('shows error banner when Machines tab fails to load', async () => {
    (getMachines as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Server error'));

    testSuitesPage.mount(container, { testsuite: '' });
    (container.querySelector('.suite-card') as HTMLElement).click();

    // Wait for Recent Activity to render, then switch to Machines
    await vi.waitFor(() => expect(container.querySelector('table')).toBeTruthy());

    const machinesTab = Array.from(container.querySelectorAll('.v5-tab'))
      .find(t => t.textContent === 'Machines') as HTMLElement;
    machinesTab.click();

    await vi.waitFor(() => {
      const banner = container.querySelector('.error-banner');
      expect(banner).toBeTruthy();
      expect(banner!.textContent).toContain('Failed to load machines');
    });
  });

  it('shows "No recent activity" when no runs exist', async () => {
    (getRunsPage as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockRunsPage([]),
    );

    testSuitesPage.mount(container, { testsuite: '' });
    (container.querySelector('.suite-card') as HTMLElement).click();

    await vi.waitFor(() => {
      expect(container.textContent).toContain('No recent activity');
    });
  });

  describe('Regressions tab', () => {
    it('clicking Regressions tab calls getRegressions with correct suite', async () => {
      testSuitesPage.mount(container, { testsuite: '' });
      (container.querySelector('.suite-card') as HTMLElement).click();

      // Wait for initial tab content to load
      await vi.waitFor(() => expect(container.querySelector('table')).toBeTruthy());

      const regressionsTab = Array.from(container.querySelectorAll('.v5-tab'))
        .find(t => t.textContent === 'Regressions') as HTMLElement;
      regressionsTab.click();

      await vi.waitFor(() => {
        expect(getRegressions).toHaveBeenCalledWith(
          'nts',
          expect.objectContaining({ limit: 25 }),
          expect.any(AbortSignal),
        );
      });
    });

    it('renders state filter chips and table rows', async () => {
      testSuitesPage.mount(container, { testsuite: '' });
      (container.querySelector('.suite-card') as HTMLElement).click();

      await vi.waitFor(() => expect(container.querySelector('table')).toBeTruthy());

      const regressionsTab = Array.from(container.querySelectorAll('.v5-tab'))
        .find(t => t.textContent === 'Regressions') as HTMLElement;
      regressionsTab.click();

      await vi.waitFor(() => {
        // State chips should be present
        const chips = container.querySelectorAll('.state-chip');
        expect(chips.length).toBe(5);

        // Table columns
        const headers = Array.from(container.querySelectorAll('th')).map(h => h.textContent);
        expect(headers).toContain('Title');
        expect(headers).toContain('State');
        expect(headers).toContain('Commit');
        expect(headers).toContain('Machines');
        expect(headers).toContain('Tests');

        // Check data is rendered
        expect(container.textContent).toContain('compile_time regression');
        expect(container.textContent).toContain('exec_time regression');

        // Title should be a link using full suite-scoped URL
        const titleLink = container.querySelector('a[href*="/regressions/reg-1111"]') as HTMLAnchorElement;
        expect(titleLink).toBeTruthy();
        expect(titleLink.textContent).toBe('compile_time regression');
      });
    });

    it('empty state when no regressions', async () => {
      (getRegressions as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockRegressionsPage([]),
      );

      testSuitesPage.mount(container, { testsuite: '' });
      (container.querySelector('.suite-card') as HTMLElement).click();

      await vi.waitFor(() => expect(container.querySelector('table')).toBeTruthy());

      const regressionsTab = Array.from(container.querySelectorAll('.v5-tab'))
        .find(t => t.textContent === 'Regressions') as HTMLElement;
      regressionsTab.click();

      await vi.waitFor(() => {
        expect(container.textContent).toContain('No regressions found.');
      });
    });
  });
});
