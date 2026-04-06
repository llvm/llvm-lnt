// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the API module
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    getRecentRuns: vi.fn(),
    getOrder: vi.fn(),
  };
});

// Mock Plotly (may be loaded by transitive imports)
(globalThis as unknown as Record<string, unknown>).Plotly = {
  newPlot: vi.fn(),
  react: vi.fn(),
  purge: vi.fn(),
  Fx: { hover: vi.fn(), unhover: vi.fn() },
};

import { getRecentRuns, getOrder } from '../../api';
import { dashboardPage } from '../../pages/dashboard';
import type { RunInfo, OrderDetail } from '../../types';

function makeRun(uuid: string, orderRev: string, startTime: string, machine = 'machine-1'): RunInfo {
  return {
    uuid,
    machine,
    order: { rev: orderRev },
    start_time: startTime,
    end_time: null,
  };
}

function makeOrderDetail(rev: string, tag: string | null): OrderDetail {
  return {
    fields: { rev },
    tag,
    previous_order: null,
    next_order: null,
  };
}

describe('dashboardPage', () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
  });

  afterEach(() => {
    dashboardPage.unmount?.();
  });

  it('renders page header and Recent Orders heading', () => {
    (getRecentRuns as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], cursor: { next: null, previous: null } });

    dashboardPage.mount(container, { testsuite: 'nts' });

    expect(container.querySelector('.page-header')?.textContent).toBe('Dashboard');
    expect(container.querySelector('h3')?.textContent).toBe('Recent Orders');
  });

  it('shows loading message while fetching', () => {
    (getRecentRuns as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {})); // never resolves

    dashboardPage.mount(container, { testsuite: 'nts' });

    expect(container.querySelector('.progress-label')?.textContent).toBe('Loading recent runs...');
  });

  it('calls getRecentRuns with correct arguments', () => {
    (getRecentRuns as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], cursor: { next: null, previous: null } });

    dashboardPage.mount(container, { testsuite: 'nts' });

    expect(getRecentRuns).toHaveBeenCalledWith('nts', { limit: 50, sort: '-start_time' }, expect.any(AbortSignal));
  });

  it('renders data table with Order and Latest Run columns after load', async () => {
    const runs = [makeRun('uuid-1', '100', '2026-01-01T10:00:00Z')];
    (getRecentRuns as ReturnType<typeof vi.fn>).mockResolvedValue({ items: runs, cursor: { next: null, previous: null } });
    (getOrder as ReturnType<typeof vi.fn>).mockResolvedValue(makeOrderDetail('100', null));

    dashboardPage.mount(container, { testsuite: 'nts' });

    await vi.waitFor(() => {
      const headers = container.querySelectorAll('th');
      const headerTexts = Array.from(headers).map(h => h.textContent);
      expect(headerTexts).toContain('Order');
      expect(headerTexts).toContain('Latest Run');
    });
  });

  it('groups runs by primary order value — multiple runs with same order produce one row', async () => {
    const runs = [
      makeRun('uuid-1', '100', '2026-01-01T10:00:00Z'),
      makeRun('uuid-2', '100', '2026-01-01T11:00:00Z'),
      makeRun('uuid-3', '101', '2026-01-01T12:00:00Z'),
    ];
    (getRecentRuns as ReturnType<typeof vi.fn>).mockResolvedValue({ items: runs, cursor: { next: null, previous: null } });
    (getOrder as ReturnType<typeof vi.fn>).mockResolvedValue(makeOrderDetail('100', null));

    dashboardPage.mount(container, { testsuite: 'nts' });

    await vi.waitFor(() => {
      const rows = container.querySelectorAll('tbody tr');
      expect(rows).toHaveLength(2); // one row for order 100, one for 101
    });
  });

  it('picks the run with the latest start_time as the Latest Run link', async () => {
    const runs = [
      makeRun('uuid-early', '100', '2026-01-01T10:00:00Z'),
      makeRun('uuid-late', '100', '2026-01-01T12:00:00Z'),
    ];
    (getRecentRuns as ReturnType<typeof vi.fn>).mockResolvedValue({ items: runs, cursor: { next: null, previous: null } });
    (getOrder as ReturnType<typeof vi.fn>).mockResolvedValue(makeOrderDetail('100', null));

    dashboardPage.mount(container, { testsuite: 'nts' });

    await vi.waitFor(() => {
      // The Latest Run link should point to uuid-late (the one with later start_time)
      const links = container.querySelectorAll('a');
      const runLink = Array.from(links).find(a => a.getAttribute('href')?.includes('/runs/'));
      expect(runLink?.getAttribute('href')).toContain('uuid-late');
    });
  });

  it('batch-fetches order details — getOrder called once per unique order', async () => {
    const runs = [
      makeRun('uuid-1', '100', '2026-01-01T10:00:00Z'),
      makeRun('uuid-2', '100', '2026-01-01T11:00:00Z'),
      makeRun('uuid-3', '101', '2026-01-01T12:00:00Z'),
    ];
    (getRecentRuns as ReturnType<typeof vi.fn>).mockResolvedValue({ items: runs, cursor: { next: null, previous: null } });
    (getOrder as ReturnType<typeof vi.fn>).mockResolvedValue(makeOrderDetail('100', null));

    dashboardPage.mount(container, { testsuite: 'nts' });

    await vi.waitFor(() => {
      // 2 unique orders: '100' and '101'
      expect(getOrder).toHaveBeenCalledTimes(2);
    });
  });

  it('fetches order details for all unique orders', async () => {
    const runs = Array.from({ length: 7 }, (_, i) =>
      makeRun(`uuid-${i}`, `${100 + i}`, `2026-01-01T${10 + i}:00:00Z`),
    );
    (getRecentRuns as ReturnType<typeof vi.fn>).mockResolvedValue({ items: runs, cursor: { next: null, previous: null } });
    (getOrder as ReturnType<typeof vi.fn>).mockImplementation(async (_ts: string, value: string) => {
      return makeOrderDetail(value, null);
    });

    dashboardPage.mount(container, { testsuite: 'nts' });

    await vi.waitFor(() => {
      expect(getOrder).toHaveBeenCalledTimes(7);
    });
  });

  it('displays tag next to order value when present', async () => {
    const runs = [makeRun('uuid-1', '100', '2026-01-01T10:00:00Z')];
    (getRecentRuns as ReturnType<typeof vi.fn>).mockResolvedValue({ items: runs, cursor: { next: null, previous: null } });
    (getOrder as ReturnType<typeof vi.fn>).mockResolvedValue(makeOrderDetail('100', 'v1.0'));

    dashboardPage.mount(container, { testsuite: 'nts' });

    await vi.waitFor(() => {
      const orderLink = container.querySelector('a[href*="/orders/"]');
      expect(orderLink?.textContent).toContain('v1.0');
    });
  });

  it('silently tolerates individual getOrder failures', async () => {
    const runs = [
      makeRun('uuid-1', '100', '2026-01-01T10:00:00Z'),
      makeRun('uuid-2', '101', '2026-01-01T11:00:00Z'),
    ];
    (getRecentRuns as ReturnType<typeof vi.fn>).mockResolvedValue({ items: runs, cursor: { next: null, previous: null } });
    (getOrder as ReturnType<typeof vi.fn>).mockImplementation(async (_ts: string, value: string) => {
      if (value === '100') throw new Error('Network error');
      return makeOrderDetail(value, 'tag-101');
    });

    dashboardPage.mount(container, { testsuite: 'nts' });

    await vi.waitFor(() => {
      // Table should still render both rows despite one getOrder failing
      const rows = container.querySelectorAll('tbody tr');
      expect(rows).toHaveLength(2);
      // The failed order should not have a tag
      expect(container.querySelector('.error-banner')).toBeNull();
    });
  });

  it('shows "No recent runs found." when result is empty', async () => {
    (getRecentRuns as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], cursor: { next: null, previous: null } });

    dashboardPage.mount(container, { testsuite: 'nts' });

    await vi.waitFor(() => {
      expect(container.querySelector('.no-results')?.textContent).toBe('No recent runs found.');
    });
  });

  it('shows error banner on getRecentRuns failure', async () => {
    (getRecentRuns as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Server error'));

    dashboardPage.mount(container, { testsuite: 'nts' });

    await vi.waitFor(() => {
      const banner = container.querySelector('.error-banner');
      expect(banner).toBeTruthy();
      expect(banner!.textContent).toContain('Failed to load recent orders');
    });
  });

  it('unmount is safe to call before load completes', () => {
    (getRecentRuns as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

    dashboardPage.mount(container, { testsuite: 'nts' });
    expect(() => dashboardPage.unmount!()).not.toThrow();
  });
});
