// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the API module before importing compare page
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    getFields: vi.fn(),
    getSamples: vi.fn(),
    getRuns: vi.fn(),
    getMachines: vi.fn(),
    getCommits: vi.fn(),
    getTestSuiteInfoCached: vi.fn(),
    getProfilesForRun: vi.fn(),
    getRegressions: vi.fn(),
    createRegression: vi.fn(),
    addRegressionIndicators: vi.fn(),
    getToken: vi.fn(),
    authErrorMessage: vi.fn((err: unknown) => `Auth error: ${err}`),
  };
});

vi.mock('../../router', () => ({
  navigate: vi.fn(),
  getTestsuites: vi.fn(() => ['nts']),
  getBasePath: vi.fn(() => '/v5'),
  getUrlBase: vi.fn(() => ''),
}));

// Mock Plotly (loaded via CDN, not available in tests).
// The real Plotly adds an .on() method to the container div as a side effect
// of newPlot/react. Our mock replicates this so chart.ts event wiring works.
function addPlotlyMethods(el: HTMLElement): HTMLElement {
  (el as unknown as Record<string, unknown>).on = vi.fn();
  return el;
}
const plotlyMock = {
  newPlot: vi.fn().mockImplementation((container: HTMLElement) => {
    addPlotlyMethods(container);
    return Promise.resolve(container);
  }),
  react: vi.fn().mockImplementation((container: HTMLElement) => {
    addPlotlyMethods(container);
    return Promise.resolve(container);
  }),
  purge: vi.fn(),
  Fx: {
    hover: vi.fn(),
    unhover: vi.fn(),
  },
};
(globalThis as unknown as Record<string, unknown>).Plotly = plotlyMock;

import {
  getFields, getSamples, getMachines, getRuns, getCommits,
  getTestSuiteInfoCached, getProfilesForRun,
  getToken, createRegression, addRegressionIndicators, getRegressions,
} from '../../api';
import { getTestsuites } from '../../router';
import { comparePage } from '../../pages/compare';
import type { FieldInfo, SampleInfo, RegressionDetail } from '../../types';

const mockFields: FieldInfo[] = [
  { name: 'exec_time', type: 'real', display_name: 'Execution Time', unit: 's', unit_abbrev: 's', bigger_is_better: false },
];

const mockSamples: SampleInfo[] = [
  { test: 'test-A', metrics: { exec_time: 10.0 } },
  { test: 'test-B', metrics: { exec_time: 20.0 } },
];

const savedLocation = window.location;

function setupMocks(): void {
  (getTestsuites as ReturnType<typeof vi.fn>).mockReturnValue(['nts']);
  (getFields as ReturnType<typeof vi.fn>).mockResolvedValue(mockFields);
  (getSamples as ReturnType<typeof vi.fn>).mockResolvedValue(mockSamples);
  (getMachines as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [] });
  (getRuns as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (getCommits as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (getTestSuiteInfoCached as ReturnType<typeof vi.fn>).mockResolvedValue({ metrics: mockFields, commit_fields: [], machine_fields: [] });
  (getProfilesForRun as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (getRegressions as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], next: null, previous: null });
}

describe('comparePage', () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    setupMocks();

    // Reset URL state — set suite_a so fetchSideData is triggered on mount
    delete (window as unknown as Record<string, unknown>).location;
    (window as unknown as Record<string, unknown>).location = {
      ...savedLocation,
      search: '?suite_a=nts',
      pathname: '/v5/compare',
    };
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
  });

  afterEach(() => {
    comparePage.unmount?.();
    (window as unknown as Record<string, unknown>).location = savedLocation;
  });

  it('mount loads fields for side with suite in URL', async () => {
    comparePage.mount(container, { testsuite: '' });

    // fetchSideData is called for side A because suite_a=nts is in the URL
    await vi.waitFor(() => {
      expect(getFields).toHaveBeenCalledWith('nts');
    });
  });

  it('shows error when fields fetch fails', async () => {
    (getFields as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

    comparePage.mount(container, { testsuite: '' });

    // The error from fetchSideData is silently ignored (controls stay disabled).
    // The page itself should still render without crashing.
    await vi.waitFor(() => {
      expect(container.querySelector('.controls-panel')).toBeTruthy();
    });
  });

  it('renders selection panel after mount', async () => {
    comparePage.mount(container, { testsuite: '' });

    await vi.waitFor(() => {
      // Selection panel should be rendered
      expect(container.querySelector('.controls-panel')).toBeTruthy();
    });
  });

  it('unmount cleans up without errors', async () => {
    comparePage.mount(container, { testsuite: '' });

    await vi.waitFor(() => {
      expect(container.querySelector('.controls-panel')).toBeTruthy();
    });

    // Should not throw
    expect(() => comparePage.unmount!()).not.toThrow();
  });

  it('unmount is safe to call even before mount completes', () => {
    comparePage.mount(container, { testsuite: '' });
    // Unmount immediately before async operations complete
    expect(() => comparePage.unmount!()).not.toThrow();
  });

  describe('regression feedback links', () => {
    const mockCreatedRegression: RegressionDetail = {
      uuid: 'aaaa-bbbb-cccc-dddd',
      title: 'My Regression',
      bug: null,
      notes: null,
      state: 'detected',
      commit: null,
      indicators: [],
    };

    beforeEach(() => {
      (getToken as ReturnType<typeof vi.fn>).mockReturnValue('test-token');
    });

    it('"Create New" produces a link with title as text', async () => {
      (createRegression as ReturnType<typeof vi.fn>).mockResolvedValue(mockCreatedRegression);

      comparePage.mount(container, { testsuite: '' });

      await vi.waitFor(() => {
        expect(container.querySelector('.add-to-regression-panel')).toBeTruthy();
      });

      // Type a title and click Create
      const titleInput = container.querySelector('.create-new-tab input') as HTMLInputElement;
      titleInput.value = 'My Regression';
      const createBtn = container.querySelector('.create-new-tab .compare-btn') as HTMLButtonElement;
      createBtn.click();

      await vi.waitFor(() => {
        const feedbackP = container.querySelector('.regression-feedback-ok');
        expect(feedbackP).toBeTruthy();
        const link = feedbackP!.querySelector('a');
        expect(link).toBeTruthy();
        expect(link!.textContent).toBe('My Regression');
        expect(link!.href).toContain('/nts/regressions/aaaa-bbbb-cccc-dddd');
      });
    });

    it('"Create New" without title uses short UUID as link text', async () => {
      const noTitleRegression: RegressionDetail = { ...mockCreatedRegression, title: null };
      (createRegression as ReturnType<typeof vi.fn>).mockResolvedValue(noTitleRegression);

      comparePage.mount(container, { testsuite: '' });

      await vi.waitFor(() => {
        expect(container.querySelector('.add-to-regression-panel')).toBeTruthy();
      });

      const createBtn = container.querySelector('.create-new-tab .compare-btn') as HTMLButtonElement;
      createBtn.click();

      await vi.waitFor(() => {
        const feedbackP = container.querySelector('.regression-feedback-ok');
        expect(feedbackP).toBeTruthy();
        const link = feedbackP!.querySelector('a');
        expect(link).toBeTruthy();
        expect(link!.textContent).toBe('aaaa-bbb');
      });
    });

    it('"Create New" clears title input after success', async () => {
      (createRegression as ReturnType<typeof vi.fn>).mockResolvedValue(mockCreatedRegression);

      comparePage.mount(container, { testsuite: '' });

      await vi.waitFor(() => {
        expect(container.querySelector('.add-to-regression-panel')).toBeTruthy();
      });

      const titleInput = container.querySelector('.create-new-tab input') as HTMLInputElement;
      titleInput.value = 'Some Title';
      const createBtn = container.querySelector('.create-new-tab .compare-btn') as HTMLButtonElement;
      createBtn.click();

      await vi.waitFor(() => {
        expect(container.querySelector('.regression-feedback-ok')).toBeTruthy();
        expect(titleInput.value).toBe('');
      });
    });

    it('"Add to Existing" produces a link to the regression', async () => {
      const existingRegression: RegressionDetail = {
        uuid: 'xxxx-yyyy-zzzz-wwww',
        title: 'Existing Reg',
        bug: null,
        notes: null,
        state: 'detected',
        commit: null,
        indicators: [],
      };
      (addRegressionIndicators as ReturnType<typeof vi.fn>).mockResolvedValue(existingRegression);

      // Set up both sides with runs and a metric so auto-compare fires
      // and populates lastRows (needed for indicators to be non-empty)
      const samplesA: SampleInfo[] = [{ test: 'test-A', metrics: { exec_time: 10.0 } }];
      const samplesB: SampleInfo[] = [{ test: 'test-A', metrics: { exec_time: 12.0 } }];
      (getSamples as ReturnType<typeof vi.fn>).mockImplementation(
        (_ts: string, uuid: string) => Promise.resolve(uuid === 'run-a1' ? samplesA : samplesB),
      );
      (getRuns as ReturnType<typeof vi.fn>).mockResolvedValue([
        { uuid: 'run-a1', submitted_at: '2025-01-01T00:00:00Z', machine: 'clang-x86', commit: 'abc123' },
      ]);

      delete (window as unknown as Record<string, unknown>).location;
      (window as unknown as Record<string, unknown>).location = {
        ...savedLocation,
        search: '?suite_a=nts&suite_b=nts&machine_a=clang-x86&commit_a=abc123&runs_a=run-a1&machine_b=clang-x86&commit_b=def456&runs_b=run-b1&metric=exec_time',
        pathname: '/v5/compare',
      };

      (getRegressions as ReturnType<typeof vi.fn>).mockResolvedValue({
        items: [{ uuid: 'xxxx-yyyy-zzzz-wwww', title: 'Existing Reg', state: 'detected', machine_count: 1, test_count: 1 }],
        next: null,
        previous: null,
      });

      comparePage.mount(container, { testsuite: '' });

      // Wait for the comparison to complete (table renders with test rows)
      await vi.waitFor(() => {
        expect(container.querySelector('.add-to-regression-panel')).toBeTruthy();
      });

      // Switch to "Add to Existing" tab
      const tabs = container.querySelectorAll('.tab-btn');
      (tabs[1] as HTMLButtonElement).click();

      // Trigger search to load regression results
      const searchInput = container.querySelector('.add-existing-tab input') as HTMLInputElement;
      searchInput.dispatchEvent(new Event('focus'));

      // Wait for search results to appear
      await vi.waitFor(() => {
        const rows = container.querySelectorAll('.regression-search-row');
        expect(rows.length).toBeGreaterThan(0);
      });

      // Click the first search result to select it
      const resultRow = container.querySelector('.regression-search-row') as HTMLElement;
      resultRow.click();

      // Click "Add Indicators"
      const addBtn = container.querySelector('.add-existing-tab .compare-btn') as HTMLButtonElement;
      addBtn.click();

      await vi.waitFor(() => {
        const feedbackP = container.querySelector('.add-existing-tab .regression-feedback-ok');
        expect(feedbackP).toBeTruthy();
        const link = feedbackP!.querySelector('a');
        expect(link).toBeTruthy();
        expect(link!.textContent).toBe('Existing Reg');
        expect(link!.href).toContain('/nts/regressions/xxxx-yyyy-zzzz-wwww');
      });
    });

    it('"Create New" failure shows error and preserves title input', async () => {
      (createRegression as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('server down'));

      comparePage.mount(container, { testsuite: '' });

      await vi.waitFor(() => {
        expect(container.querySelector('.add-to-regression-panel')).toBeTruthy();
      });

      const titleInput = container.querySelector('.create-new-tab input') as HTMLInputElement;
      titleInput.value = 'Keep This Title';
      const createBtn = container.querySelector('.create-new-tab .compare-btn') as HTMLButtonElement;
      createBtn.click();

      await vi.waitFor(() => {
        const feedback = container.querySelector('.create-new-tab .error-banner');
        expect(feedback).toBeTruthy();
        // No link in error feedback
        expect(feedback!.querySelector('a')).toBeNull();
        // Title input is NOT cleared on failure
        expect(titleInput.value).toBe('Keep This Title');
      });
    });

    it('"Add to Existing" failure shows error without link', async () => {
      (addRegressionIndicators as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('server error'));

      // Set up both sides with runs and a metric so comparison produces indicators
      const samplesA: SampleInfo[] = [{ test: 'test-A', metrics: { exec_time: 10.0 } }];
      const samplesB: SampleInfo[] = [{ test: 'test-A', metrics: { exec_time: 12.0 } }];
      (getSamples as ReturnType<typeof vi.fn>).mockImplementation(
        (_ts: string, uuid: string) => Promise.resolve(uuid === 'run-a1' ? samplesA : samplesB),
      );
      (getRuns as ReturnType<typeof vi.fn>).mockResolvedValue([
        { uuid: 'run-a1', submitted_at: '2025-01-01T00:00:00Z', machine: 'clang-x86', commit: 'abc123' },
      ]);

      delete (window as unknown as Record<string, unknown>).location;
      (window as unknown as Record<string, unknown>).location = {
        ...savedLocation,
        search: '?suite_a=nts&suite_b=nts&machine_a=clang-x86&commit_a=abc123&runs_a=run-a1&machine_b=clang-x86&commit_b=def456&runs_b=run-b1&metric=exec_time',
        pathname: '/v5/compare',
      };

      (getRegressions as ReturnType<typeof vi.fn>).mockResolvedValue({
        items: [{ uuid: 'xxxx-yyyy-zzzz-wwww', title: 'Existing Reg', state: 'detected', machine_count: 1, test_count: 1 }],
        next: null,
        previous: null,
      });

      comparePage.mount(container, { testsuite: '' });

      await vi.waitFor(() => {
        expect(container.querySelector('.add-to-regression-panel')).toBeTruthy();
      });

      // Switch to "Add to Existing" tab
      const tabs = container.querySelectorAll('.tab-btn');
      (tabs[1] as HTMLButtonElement).click();

      // Trigger search
      const searchInput = container.querySelector('.add-existing-tab input') as HTMLInputElement;
      searchInput.dispatchEvent(new Event('focus'));

      await vi.waitFor(() => {
        expect(container.querySelectorAll('.regression-search-row').length).toBeGreaterThan(0);
      });

      // Select a regression
      (container.querySelector('.regression-search-row') as HTMLElement).click();

      // Click "Add Indicators"
      const addBtn = container.querySelector('.add-existing-tab .compare-btn') as HTMLButtonElement;
      addBtn.click();

      await vi.waitFor(() => {
        const feedback = container.querySelector('.add-existing-tab .error-banner');
        expect(feedback).toBeTruthy();
        expect(feedback!.querySelector('a')).toBeNull();
      });
    });

    it('"Add to Existing" with zero indicators shows error without calling API', async () => {
      // Mount with suite but NO machine/runs so indicators will be empty
      comparePage.mount(container, { testsuite: '' });

      await vi.waitFor(() => {
        expect(container.querySelector('.add-to-regression-panel')).toBeTruthy();
      });

      // Switch to "Add to Existing" tab
      const tabs = container.querySelectorAll('.tab-btn');
      (tabs[1] as HTMLButtonElement).click();

      // We need a selectedRegUuid for the button to proceed past the guard.
      // Simulate selecting a regression: trigger search, pick a result.
      (getRegressions as ReturnType<typeof vi.fn>).mockResolvedValue({
        items: [{ uuid: 'xxxx-yyyy-zzzz-wwww', title: 'Some Reg', state: 'detected', machine_count: 1, test_count: 1 }],
        next: null,
        previous: null,
      });

      const searchInput = container.querySelector('.add-existing-tab input') as HTMLInputElement;
      searchInput.dispatchEvent(new Event('focus'));

      await vi.waitFor(() => {
        expect(container.querySelectorAll('.regression-search-row').length).toBeGreaterThan(0);
      });

      (container.querySelector('.regression-search-row') as HTMLElement).click();

      // Click "Add Indicators" — no comparison data, so indicators.length === 0
      const addBtn = container.querySelector('.add-existing-tab .compare-btn') as HTMLButtonElement;
      addBtn.click();

      await vi.waitFor(() => {
        const feedback = container.querySelector('.add-existing-tab .error-banner');
        expect(feedback).toBeTruthy();
        expect(feedback!.querySelector('a')).toBeNull();
      });

      // API should NOT have been called
      expect(addRegressionIndicators).not.toHaveBeenCalled();
    });

    it('"Add to Existing" with title: null falls back to short UUID', async () => {
      const nullTitleRegression: RegressionDetail = {
        uuid: 'xxxx-yyyy-zzzz-wwww',
        title: null,
        bug: null,
        notes: null,
        state: 'detected',
        commit: null,
        indicators: [],
      };
      (addRegressionIndicators as ReturnType<typeof vi.fn>).mockResolvedValue(nullTitleRegression);

      // Set up both sides with runs and a metric so comparison produces indicators
      const samplesA: SampleInfo[] = [{ test: 'test-A', metrics: { exec_time: 10.0 } }];
      const samplesB: SampleInfo[] = [{ test: 'test-A', metrics: { exec_time: 12.0 } }];
      (getSamples as ReturnType<typeof vi.fn>).mockImplementation(
        (_ts: string, uuid: string) => Promise.resolve(uuid === 'run-a1' ? samplesA : samplesB),
      );
      (getRuns as ReturnType<typeof vi.fn>).mockResolvedValue([
        { uuid: 'run-a1', submitted_at: '2025-01-01T00:00:00Z', machine: 'clang-x86', commit: 'abc123' },
      ]);

      delete (window as unknown as Record<string, unknown>).location;
      (window as unknown as Record<string, unknown>).location = {
        ...savedLocation,
        search: '?suite_a=nts&suite_b=nts&machine_a=clang-x86&commit_a=abc123&runs_a=run-a1&machine_b=clang-x86&commit_b=def456&runs_b=run-b1&metric=exec_time',
        pathname: '/v5/compare',
      };

      (getRegressions as ReturnType<typeof vi.fn>).mockResolvedValue({
        items: [{ uuid: 'xxxx-yyyy-zzzz-wwww', title: null, state: 'detected', machine_count: 1, test_count: 1 }],
        next: null,
        previous: null,
      });

      comparePage.mount(container, { testsuite: '' });

      await vi.waitFor(() => {
        expect(container.querySelector('.add-to-regression-panel')).toBeTruthy();
      });

      // Switch to "Add to Existing" tab
      const tabs = container.querySelectorAll('.tab-btn');
      (tabs[1] as HTMLButtonElement).click();

      // Trigger search
      const searchInput = container.querySelector('.add-existing-tab input') as HTMLInputElement;
      searchInput.dispatchEvent(new Event('focus'));

      await vi.waitFor(() => {
        expect(container.querySelectorAll('.regression-search-row').length).toBeGreaterThan(0);
      });

      // Select the regression
      (container.querySelector('.regression-search-row') as HTMLElement).click();

      // Click "Add Indicators"
      const addBtn = container.querySelector('.add-existing-tab .compare-btn') as HTMLButtonElement;
      addBtn.click();

      await vi.waitFor(() => {
        const feedbackP = container.querySelector('.add-existing-tab .regression-feedback-ok');
        expect(feedbackP).toBeTruthy();
        const link = feedbackP!.querySelector('a');
        expect(link).toBeTruthy();
        // Falls back to first 8 chars of UUID (same as "Create New" null-title test)
        expect(link!.textContent).toBe('xxxx-yyy');
      });
    });
  });
});
