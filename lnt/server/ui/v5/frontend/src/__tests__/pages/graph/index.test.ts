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
    if (metricSelect && metricSelect.options.length > 1) {
      metricSelect.value = metricSelect.options[1].value;
      metricSelect.dispatchEvent(new Event('change'));

      // The first plot cycle's signals should be aborted
      for (const sig of firstSignals) {
        expect(sig.aborted).toBe(true);
      }
    }
  });
});
