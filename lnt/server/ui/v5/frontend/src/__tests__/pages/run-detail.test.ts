// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the API module
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    getRun: vi.fn(),
    getFields: vi.fn(),
    deleteRun: vi.fn(),
    fetchOneCursorPage: vi.fn(),
    apiUrl: vi.fn(),
  };
});

// Mock router navigate
vi.mock('../../router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../router')>();
  return { ...actual, navigate: vi.fn() };
});

// Mock Plotly (may be loaded by transitive imports)
(globalThis as unknown as Record<string, unknown>).Plotly = {
  newPlot: vi.fn(),
  react: vi.fn(),
  purge: vi.fn(),
  Fx: { hover: vi.fn(), unhover: vi.fn() },
};

import { getRun, getFields, fetchOneCursorPage, apiUrl } from '../../api';
import { runDetailPage } from '../../pages/run-detail';
import type { RunDetail, FieldInfo, SampleInfo } from '../../types';

const TEST_UUID = 'abcdef01-2345-6789-abcd-ef0123456789';

const mockRun: RunDetail = {
  uuid: TEST_UUID,
  machine: 'clang-x86',
  order: { rev: '100' },
  start_time: '2026-01-01T10:00:00Z',
  end_time: '2026-01-01T11:00:00Z',
  parameters: { compiler: 'clang-18', opt_level: '-O2' },
};

const mockFields: FieldInfo[] = [
  { name: 'exec_time', type: 'Real', display_name: 'Execution Time', unit: 's', unit_abbrev: 's', bigger_is_better: false },
  { name: 'compile_time', type: 'Real', display_name: 'Compile Time', unit: 's', unit_abbrev: 's', bigger_is_better: false },
  { name: 'hash', type: 'Hash', display_name: 'Hash', unit: null, unit_abbrev: null, bigger_is_better: null },
];

const mockSamples: SampleInfo[] = [
  { test: 'test-A', has_profile: false, metrics: { exec_time: 1.5, compile_time: 0.3 } },
  { test: 'test-B', has_profile: false, metrics: { exec_time: 2.0, compile_time: 0.5 } },
  { test: 'test-C', has_profile: true, metrics: { exec_time: 3.0, compile_time: 0.7 } },
];

describe('runDetailPage', () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');

    (getRun as ReturnType<typeof vi.fn>).mockResolvedValue(mockRun);
    (getFields as ReturnType<typeof vi.fn>).mockResolvedValue(mockFields);
    (apiUrl as ReturnType<typeof vi.fn>).mockReturnValue(`/api/v5/nts/runs/${TEST_UUID}/samples`);
    (fetchOneCursorPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: mockSamples,
      nextCursor: null,
    });
  });

  afterEach(() => {
    runDetailPage.unmount?.();
  });

  it('renders page header with truncated UUID', () => {
    runDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

    const header = container.querySelector('.page-header');
    expect(header?.textContent).toBe('Run: abcdef01\u2026');
  });

  it('calls getRun and getFields', () => {
    runDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

    expect(getRun).toHaveBeenCalledWith('nts', TEST_UUID);
    expect(getFields).toHaveBeenCalledWith('nts');
  });

  it('renders metadata with UUID, Machine, Order, Start Time, End Time, parameters', async () => {
    runDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

    await vi.waitFor(() => {
      const dl = container.querySelector('.metadata-dl');
      expect(dl).toBeTruthy();
      expect(dl!.textContent).toContain('UUID');
      expect(dl!.textContent).toContain(TEST_UUID);
      expect(dl!.textContent).toContain('Machine');
      expect(dl!.textContent).toContain('Order');
      expect(dl!.textContent).toContain('Start Time');
      expect(dl!.textContent).toContain('End Time');
      expect(dl!.textContent).toContain('compiler');
      expect(dl!.textContent).toContain('clang-18');
      expect(dl!.textContent).toContain('opt_level');
      expect(dl!.textContent).toContain('-O2');
    });
  });

  it('Machine and Order render as SPA links', async () => {
    runDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

    await vi.waitFor(() => {
      const machineLink = container.querySelector('a[href*="/machines/clang-x86"]');
      expect(machineLink).toBeTruthy();
      expect(machineLink!.textContent).toBe('clang-x86');

      const orderLink = container.querySelector('a[href*="/orders/100"]');
      expect(orderLink).toBeTruthy();
    });
  });

  it('renders "Compare with…" action link with correct URL params', async () => {
    runDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

    await vi.waitFor(() => {
      const link = container.querySelector('.action-links a');
      expect(link).toBeTruthy();
      expect(link!.textContent).toContain('Compare with');
      const href = link!.getAttribute('href')!;
      expect(href).toContain('machine_a=clang-x86');
      expect(href).toContain('order_a=100');
      expect(href).toContain(`runs_a=${encodeURIComponent(TEST_UUID)}`);
    });
  });

  it('renders metric selector with Real-type fields only', async () => {
    runDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

    await vi.waitFor(() => {
      const select = container.querySelector('.metric-select') as HTMLSelectElement;
      expect(select).toBeTruthy();
      const options = Array.from(select.options).map(o => o.value);
      // Should include Real fields but not Hash
      expect(options).toContain('exec_time');
      expect(options).toContain('compile_time');
      expect(options).not.toContain('hash');
    });
  });

  it('renders test filter input', async () => {
    runDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

    await vi.waitFor(() => {
      const filterInput = container.querySelector('.test-filter-input');
      expect(filterInput).toBeTruthy();
    });
  });

  it('progressive loading: calls fetchOneCursorPage with limit=2000', async () => {
    runDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

    await vi.waitFor(() => {
      expect(fetchOneCursorPage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ limit: '2000' }),
        expect.any(AbortSignal),
      );
    });
  });

  it('progressive loading fetches next page when cursor present', async () => {
    (fetchOneCursorPage as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ items: mockSamples.slice(0, 2), nextCursor: 'page2' })
      .mockResolvedValueOnce({ items: mockSamples.slice(2), nextCursor: null });

    runDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

    await vi.waitFor(() => {
      expect(fetchOneCursorPage).toHaveBeenCalledTimes(2);
      // Second call includes cursor
      expect(fetchOneCursorPage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ limit: '2000', cursor: 'page2' }),
        expect.any(AbortSignal),
      );
    });
  });

  it('renders samples table with Test and Value columns', async () => {
    runDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

    await vi.waitFor(() => {
      const headers = Array.from(container.querySelectorAll('th')).map(h => h.textContent);
      // Headers may include sort indicators (e.g. "Test ▲")
      expect(headers.some(h => h?.startsWith('Test'))).toBe(true);
      expect(headers.some(h => h?.startsWith('Value'))).toBe(true);
      const rows = container.querySelectorAll('tbody tr');
      expect(rows).toHaveLength(3);
    });
  });

  it('delete confirmation uses 8-char UUID prefix as confirmValue', async () => {
    runDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

    await vi.waitFor(() => {
      // The delete section should mention the 8-char prefix
      const deleteSection = container.querySelector('.delete-machine-section');
      expect(deleteSection).toBeTruthy();
      expect(deleteSection!.textContent).toContain('abcdef01');
    });
  });

  it('shows error banner when getRun/getFields fails', async () => {
    (getRun as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Not found'));

    runDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

    await vi.waitFor(() => {
      const banner = container.querySelector('.error-banner');
      expect(banner).toBeTruthy();
      expect(banner!.textContent).toContain('Failed to load run');
    });
  });

  it('shows error banner when sample loading fails (non-abort)', async () => {
    (fetchOneCursorPage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Server error'));

    runDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

    await vi.waitFor(() => {
      const banners = container.querySelectorAll('.error-banner');
      const sampleBanner = Array.from(banners).find(b => b.textContent?.includes('Failed to load samples'));
      expect(sampleBanner).toBeTruthy();
    });
  });

  it('unmount aborts in-flight fetches without error', () => {
    (getRun as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    (getFields as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

    runDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });
    expect(() => runDetailPage.unmount!()).not.toThrow();
  });
});
