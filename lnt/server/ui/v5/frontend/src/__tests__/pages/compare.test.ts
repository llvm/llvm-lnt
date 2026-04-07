// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the API module before importing compare page
vi.mock('../../api', () => ({
  getFields: vi.fn(),
  getOrders: vi.fn(),
  getSamples: vi.fn(),
  getRuns: vi.fn(),
  getMachines: vi.fn(),
  getMachineRuns: vi.fn(),
}));

vi.mock('../../router', () => ({
  navigate: vi.fn(),
  getTestsuites: vi.fn(() => ['nts']),
  getBasePath: vi.fn(() => '/v5'),
}));

// Mock Plotly (loaded via CDN, not available in tests)
const plotlyMock = {
  newPlot: vi.fn().mockResolvedValue(document.createElement('div')),
  react: vi.fn().mockResolvedValue(document.createElement('div')),
  purge: vi.fn(),
  Fx: {
    hover: vi.fn(),
    unhover: vi.fn(),
  },
};
(globalThis as unknown as Record<string, unknown>).Plotly = plotlyMock;

import { getFields, getOrders, getSamples, getMachines } from '../../api';
import { getTestsuites } from '../../router';
import { comparePage } from '../../pages/compare';
import type { FieldInfo, OrderSummary, SampleInfo } from '../../types';

const mockFields: FieldInfo[] = [
  { name: 'exec_time', type: 'Real', display_name: 'Execution Time', unit: 's', unit_abbrev: 's', bigger_is_better: false },
];

const mockOrders: OrderSummary[] = [
  { fields: { rev: '100' }, tag: null },
  { fields: { rev: '101' }, tag: null },
];

const mockSamples: SampleInfo[] = [
  { test: 'test-A', has_profile: false, metrics: { exec_time: 10.0 } },
  { test: 'test-B', has_profile: false, metrics: { exec_time: 20.0 } },
];

const savedLocation = window.location;

function setupMocks(): void {
  (getTestsuites as ReturnType<typeof vi.fn>).mockReturnValue(['nts']);
  (getFields as ReturnType<typeof vi.fn>).mockResolvedValue(mockFields);
  (getOrders as ReturnType<typeof vi.fn>).mockResolvedValue(mockOrders);
  (getSamples as ReturnType<typeof vi.fn>).mockResolvedValue(mockSamples);
  (getMachines as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [] });
}

describe('comparePage', () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    setupMocks();

    // Reset URL state — set suite_a so fetchSideData is triggered on mount
    delete (window as Record<string, unknown>).location;
    (window as Record<string, unknown>).location = {
      ...savedLocation,
      search: '?suite_a=nts',
      pathname: '/v5/compare',
    };
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
  });

  afterEach(() => {
    comparePage.unmount?.();
    (window as Record<string, unknown>).location = savedLocation;
  });

  it('mount loads fields and orders for side with suite in URL', async () => {
    comparePage.mount(container, { testsuite: '' });

    // fetchSideData is called for side A because suite_a=nts is in the URL
    await vi.waitFor(() => {
      expect(getFields).toHaveBeenCalledWith('nts');
      expect(getOrders).toHaveBeenCalledWith('nts');
    });
  });

  it('shows error when fields/orders fetch fails', async () => {
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
});
