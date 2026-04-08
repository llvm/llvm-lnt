// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the API module
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    getOrder: vi.fn(),
    getRunsByOrder: vi.fn(),
    updateOrderTag: vi.fn(),
    authErrorMessage: vi.fn((err: unknown) => `Auth error: ${err}`),
  };
});

// Mock router navigate
vi.mock('../../router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../router')>();
  return {
    ...actual,
    navigate: vi.fn(),
    getBasePath: vi.fn(() => '/v5/nts'),
    getUrlBase: vi.fn(() => ''),
  };
});

// Mock Plotly (may be loaded by transitive imports)
(globalThis as unknown as Record<string, unknown>).Plotly = {
  newPlot: vi.fn(),
  react: vi.fn(),
  purge: vi.fn(),
  Fx: { hover: vi.fn(), unhover: vi.fn() },
};

import { getOrder, getRunsByOrder, updateOrderTag, authErrorMessage } from '../../api';
import { navigate } from '../../router';
import { orderDetailPage } from '../../pages/order-detail';
import type { OrderDetail, RunInfo } from '../../types';

const mockOrder: OrderDetail = {
  fields: { rev: '100' },
  tag: 'v1.0',
  previous_order: { fields: { rev: '99' }, link: '/orders/99' },
  next_order: { fields: { rev: '101' }, link: '/orders/101' },
};

const mockRuns: RunInfo[] = [
  { uuid: 'aaaa-1111', machine: 'clang-x86', order: { rev: '100' }, start_time: '2026-01-01T10:00:00Z', end_time: null },
  { uuid: 'bbbb-2222', machine: 'clang-x86', order: { rev: '100' }, start_time: '2026-01-01T11:00:00Z', end_time: null },
  { uuid: 'cccc-3333', machine: 'gcc-arm', order: { rev: '100' }, start_time: '2026-01-01T12:00:00Z', end_time: null },
];

describe('orderDetailPage', () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    container = document.createElement('div');

    (getOrder as ReturnType<typeof vi.fn>).mockResolvedValue(mockOrder);
    (getRunsByOrder as ReturnType<typeof vi.fn>).mockResolvedValue(mockRuns);
    (updateOrderTag as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockOrder, tag: 'new-tag' });
  });

  afterEach(() => {
    orderDetailPage.unmount?.();
    vi.useRealTimers();
  });

  it('renders page header with order value', () => {
    orderDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    expect(container.querySelector('.page-header')?.textContent).toBe('Order: 100');
  });

  it('calls getOrder and getRunsByOrder in parallel', () => {
    orderDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    expect(getOrder).toHaveBeenCalledWith('nts', '100', expect.any(AbortSignal));
    expect(getRunsByOrder).toHaveBeenCalledWith('nts', '100', expect.any(AbortSignal));
  });

  it('renders order fields as dl key-value pairs', async () => {
    orderDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      const dl = container.querySelector('.metadata-dl');
      expect(dl).toBeTruthy();
      expect(dl!.textContent).toContain('rev');
      expect(dl!.textContent).toContain('100');
    });
  });

  it('shows tag value and Edit button', async () => {
    orderDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      const tagDisplay = container.querySelector('.tag-display');
      expect(tagDisplay).toBeTruthy();
      expect(tagDisplay!.textContent).toContain('v1.0');
      expect(tagDisplay!.querySelector('button')?.textContent).toBe('Edit');
    });
  });

  it('shows "(none)" when tag is null', async () => {
    (getOrder as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockOrder, tag: null });

    orderDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      const tagDisplay = container.querySelector('.tag-display');
      expect(tagDisplay!.textContent).toContain('(none)');
    });
  });

  it('clicking Edit shows inline edit form with input, Save, Cancel', async () => {
    orderDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      expect(container.querySelector('.tag-display button')).toBeTruthy();
    });

    // Click Edit
    const editBtn = container.querySelector('.tag-display button') as HTMLElement;
    editBtn.click();

    // Should now show input, Save, Cancel
    const tagContainer = container.querySelector('.tag-display')!;
    const input = tagContainer.querySelector('input') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe('v1.0'); // pre-filled

    const buttons = tagContainer.querySelectorAll('button');
    const buttonTexts = Array.from(buttons).map(b => b.textContent);
    expect(buttonTexts).toContain('Save');
    expect(buttonTexts).toContain('Cancel');
  });

  it('Cancel returns to display mode without API call', async () => {
    orderDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      expect(container.querySelector('.tag-display button')).toBeTruthy();
    });

    // Click Edit
    (container.querySelector('.tag-display button') as HTMLElement).click();

    // Click Cancel
    const cancelBtn = Array.from(container.querySelectorAll('.tag-display button'))
      .find(b => b.textContent === 'Cancel') as HTMLElement;
    cancelBtn.click();

    // Should be back to display mode
    expect(container.querySelector('.tag-display')!.textContent).toContain('v1.0');
    expect(container.querySelector('.tag-display')!.textContent).toContain('Edit');
    expect(updateOrderTag).not.toHaveBeenCalled();
  });

  it('Save calls updateOrderTag and re-renders tag on success', async () => {
    orderDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      expect(container.querySelector('.tag-display button')).toBeTruthy();
    });

    // Click Edit
    (container.querySelector('.tag-display button') as HTMLElement).click();

    // Change value and click Save
    const input = container.querySelector('.tag-display input') as HTMLInputElement;
    input.value = 'new-tag';

    const saveBtn = Array.from(container.querySelectorAll('.tag-display button'))
      .find(b => b.textContent === 'Save') as HTMLElement;
    saveBtn.click();

    await vi.waitFor(() => {
      expect(updateOrderTag).toHaveBeenCalledWith('nts', '100', 'new-tag');
      // Should be back in display mode with new tag
      expect(container.querySelector('.tag-display')!.textContent).toContain('new-tag');
    });
  });

  it('Save shows error on failure and re-enables button', async () => {
    (updateOrderTag as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('403 forbidden'));

    orderDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      expect(container.querySelector('.tag-display button')).toBeTruthy();
    });

    (container.querySelector('.tag-display button') as HTMLElement).click();

    const saveBtn = Array.from(container.querySelectorAll('.tag-display button'))
      .find(b => b.textContent === 'Save') as HTMLButtonElement;
    saveBtn.click();

    await vi.waitFor(() => {
      expect(authErrorMessage).toHaveBeenCalled();
      const errorEl = container.querySelector('.tag-display .error-banner');
      expect(errorEl).toBeTruthy();
      // Save button should be re-enabled
      const currentSaveBtn = Array.from(container.querySelectorAll('.tag-display button'))
        .find(b => b.textContent === 'Save') as HTMLButtonElement;
      expect(currentSaveBtn.disabled).toBe(false);
    });
  });

  it('renders Previous button when previous_order exists', async () => {
    orderDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      const navContainer = container.querySelector('.order-nav');
      expect(navContainer).toBeTruthy();
      const prevBtn = Array.from(navContainer!.querySelectorAll('button'))
        .find(b => b.textContent?.includes('Previous'));
      expect(prevBtn).toBeTruthy();
    });
  });

  it('renders Next button when next_order exists', async () => {
    orderDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      const navContainer = container.querySelector('.order-nav');
      const nextBtn = Array.from(navContainer!.querySelectorAll('button'))
        .find(b => b.textContent?.includes('Next'));
      expect(nextBtn).toBeTruthy();
    });
  });

  it('does not render Previous/Next when neighbors are null', async () => {
    (getOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockOrder,
      previous_order: null,
      next_order: null,
    });

    orderDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      const navContainer = container.querySelector('.order-nav');
      expect(navContainer).toBeTruthy();
      expect(navContainer!.querySelectorAll('button')).toHaveLength(0);
    });
  });

  it('clicking Previous navigates to previous order', async () => {
    orderDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      const navContainer = container.querySelector('.order-nav');
      expect(navContainer!.querySelectorAll('button').length).toBeGreaterThan(0);
    });

    const prevBtn = Array.from(container.querySelector('.order-nav')!.querySelectorAll('button'))
      .find(b => b.textContent?.includes('Previous')) as HTMLElement;
    prevBtn.click();

    expect(navigate).toHaveBeenCalledWith(expect.stringContaining('/orders/99'));
  });

  it('renders runs summary', async () => {
    orderDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      // 3 runs across 2 machines
      expect(container.textContent).toContain('3 runs across 2 machines');
    });
  });

  it('renders runs table with Machine, Run UUID, Start Time columns', async () => {
    orderDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      const headers = Array.from(container.querySelectorAll('th')).map(h => h.textContent);
      expect(headers).toContain('Machine');
      expect(headers).toContain('Run UUID');
      expect(headers).toContain('Start Time');
    });
  });

  it('machine and run links use suite-scoped hrefs', async () => {
    orderDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      const machineLink = container.querySelector('a[href*="/machines/"]') as HTMLAnchorElement;
      expect(machineLink).toBeTruthy();
      expect(machineLink.href).toContain('/v5/nts/machines/');

      const runLink = container.querySelector('a[href*="/runs/"]') as HTMLAnchorElement;
      expect(runLink).toBeTruthy();
      expect(runLink.href).toContain('/v5/nts/runs/');
    });
  });

  it('machine filter filters runs by machine name after 200ms debounce', async () => {
    orderDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      expect(container.querySelector('table')).toBeTruthy();
    });

    const filterInput = container.querySelector('.test-filter-input') as HTMLInputElement;
    filterInput.value = 'gcc';
    filterInput.dispatchEvent(new Event('input'));

    // Advance past debounce
    vi.advanceTimersByTime(200);

    await vi.waitFor(() => {
      // Should only show gcc-arm runs (1 of 3)
      const rows = container.querySelectorAll('tbody tr');
      expect(rows).toHaveLength(1);
    });
  });

  it('filtered summary shows "X of Y runs across A of B machines"', async () => {
    orderDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      expect(container.querySelector('table')).toBeTruthy();
    });

    const filterInput = container.querySelector('.test-filter-input') as HTMLInputElement;
    filterInput.value = 'gcc';
    filterInput.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(200);

    await vi.waitFor(() => {
      expect(container.textContent).toContain('1 of 3 run');
      expect(container.textContent).toContain('1 of 2 machine');
    });
  });

  it('shows "No runs matching filter." when filter matches nothing', async () => {
    orderDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      expect(container.querySelector('table')).toBeTruthy();
    });

    const filterInput = container.querySelector('.test-filter-input') as HTMLInputElement;
    filterInput.value = 'nonexistent';
    filterInput.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(200);

    await vi.waitFor(() => {
      expect(container.textContent).toContain('No runs matching filter.');
    });
  });

  it('shows error banner on initial load failure', async () => {
    (getOrder as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Not found'));

    orderDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      const banner = container.querySelector('.error-banner');
      expect(banner).toBeTruthy();
      expect(banner!.textContent).toContain('Failed to load order');
    });
  });

  it('unmount aborts without error', () => {
    (getOrder as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    (getRunsByOrder as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

    orderDetailPage.mount(container, { testsuite: 'nts', value: '100' });
    expect(() => orderDetailPage.unmount!()).not.toThrow();
  });
});
