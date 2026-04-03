// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the API module before importing compare page
vi.mock('../../api', () => ({
  getFields: vi.fn(),
  getOrders: vi.fn(),
  getSamples: vi.fn(),
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

import { getFields, getOrders, getSamples } from '../../api';
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

function setupMocks(): void {
  (getFields as ReturnType<typeof vi.fn>).mockResolvedValue(mockFields);
  (getOrders as ReturnType<typeof vi.fn>).mockResolvedValue(mockOrders);
  (getSamples as ReturnType<typeof vi.fn>).mockResolvedValue(mockSamples);
}

describe('comparePage', () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    setupMocks();
  });

  it('mount loads fields and orders', async () => {
    comparePage.mount(container, { testsuite: 'nts' });

    // Wait for the promise chain to resolve
    await vi.waitFor(() => {
      expect(getFields).toHaveBeenCalledWith('nts');
      expect(getOrders).toHaveBeenCalledWith('nts');
    });
  });

  it('shows error when fields/orders fetch fails', async () => {
    (getFields as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

    comparePage.mount(container, { testsuite: 'nts' });

    await vi.waitFor(() => {
      expect(container.querySelector('.error-banner')).toBeTruthy();
    });
  });

  it('renders selection panel after data loads', async () => {
    comparePage.mount(container, { testsuite: 'nts' });

    await vi.waitFor(() => {
      // Selection panel should be rendered
      expect(container.querySelector('.controls-panel')).toBeTruthy();
    });
  });

  it('unmount cleans up without errors', async () => {
    comparePage.mount(container, { testsuite: 'nts' });

    await vi.waitFor(() => {
      expect(container.querySelector('.controls-panel')).toBeTruthy();
    });

    // Should not throw
    expect(() => comparePage.unmount!()).not.toThrow();
  });

  it('unmount is safe to call even before mount completes', () => {
    comparePage.mount(container, { testsuite: 'nts' });
    // Unmount immediately before async operations complete
    expect(() => comparePage.unmount!()).not.toThrow();
  });
});
