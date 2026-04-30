// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the API module
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    getMachine: vi.fn(),
    getMachineRuns: vi.fn(),
    deleteMachine: vi.fn(),
    getRegressions: vi.fn(),
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

import { getMachine, getMachineRuns, deleteMachine, getRegressions } from '../../api';
import { machineDetailPage } from '../../pages/machine-detail';
import type { MachineInfo, MachineRunInfo, RegressionListItem } from '../../types';

const mockMachine: MachineInfo = {
  name: 'clang-x86',
  info: { hostname: 'build01', os: 'linux', arch: 'x86_64' },
};

const mockRuns: MachineRunInfo[] = [
  { uuid: 'aaaaaaaa-1111-2222-3333-444444444444', commit: '100', submitted_at: '2026-01-01T10:00:00Z' },
  { uuid: 'bbbbbbbb-1111-2222-3333-444444444444', commit: '101', submitted_at: '2026-01-02T10:00:00Z' },
];

function runsResponse(items: MachineRunInfo[], nextCursor: string | null = null) {
  return { items, cursor: { next: nextCursor, previous: null } };
}

const mockRegressionItems: RegressionListItem[] = [
  { uuid: 'reg-1111', title: 'compile_time regression', bug: null, state: 'active', commit: '100', machine_count: 1, test_count: 2 },
];

describe('machineDetailPage', () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');

    (getMachine as ReturnType<typeof vi.fn>).mockResolvedValue(mockMachine);
    (getMachineRuns as ReturnType<typeof vi.fn>).mockResolvedValue(runsResponse(mockRuns));
    (getRegressions as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: mockRegressionItems,
      nextCursor: null,
    });
  });

  afterEach(() => {
    machineDetailPage.unmount?.();
  });

  it('renders page header with machine name', () => {
    machineDetailPage.mount(container, { testsuite: 'nts', name: 'clang-x86' });

    expect(container.querySelector('.page-header')?.textContent).toBe('Machine: clang-x86');
  });

  it('calls getMachine with correct testsuite and name', () => {
    machineDetailPage.mount(container, { testsuite: 'nts', name: 'clang-x86' });

    expect(getMachine).toHaveBeenCalledWith('nts', 'clang-x86', expect.any(AbortSignal));
  });

  it('renders metadata dl with machine info key-value pairs', async () => {
    machineDetailPage.mount(container, { testsuite: 'nts', name: 'clang-x86' });

    await vi.waitFor(() => {
      const dl = container.querySelector('.metadata-dl');
      expect(dl).toBeTruthy();
      expect(dl!.textContent).toContain('hostname');
      expect(dl!.textContent).toContain('build01');
      expect(dl!.textContent).toContain('os');
      expect(dl!.textContent).toContain('linux');
    });
  });

  it('shows "No metadata available." when machine.info is empty', async () => {
    (getMachine as ReturnType<typeof vi.fn>).mockResolvedValue({ name: 'empty-machine', info: {} });

    machineDetailPage.mount(container, { testsuite: 'nts', name: 'empty-machine' });

    await vi.waitFor(() => {
      expect(container.querySelector('.no-results')?.textContent).toBe('No metadata available.');
    });
  });

  it('shows error banner when getMachine fails', async () => {
    (getMachine as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Not found'));

    machineDetailPage.mount(container, { testsuite: 'nts', name: 'bad-machine' });

    await vi.waitFor(() => {
      const banner = container.querySelector('.error-banner');
      expect(banner).toBeTruthy();
      expect(banner!.textContent).toContain('Failed to load machine');
    });
  });

  it('renders View Graph and Compare as agnostic links with suite params', () => {
    machineDetailPage.mount(container, { testsuite: 'nts', name: 'clang-x86' });

    const links = container.querySelectorAll('.action-links a');
    expect(links).toHaveLength(2);

    // View Graph — agnostic link to /v5/graph
    expect(links[0].textContent).toBe('View Graph');
    const graphHref = links[0].getAttribute('href')!;
    expect(graphHref).toMatch(/^\/v5\/graph\?/);
    expect(graphHref).not.toContain('/v5/nts/graph');
    expect(graphHref).toContain('suite=nts');
    expect(graphHref).toContain('machine=clang-x86');

    // Compare — agnostic link to /v5/compare
    expect(links[1].textContent).toBe('Compare');
    const compareHref = links[1].getAttribute('href')!;
    expect(compareHref).toMatch(/^\/v5\/compare\?/);
    expect(compareHref).not.toContain('/v5/nts/compare');
    expect(compareHref).toContain('suite_a=nts');
    expect(compareHref).toContain('machine_a=clang-x86');
  });

  it('calls getMachineRuns with correct params', () => {
    machineDetailPage.mount(container, { testsuite: 'nts', name: 'clang-x86' });

    expect(getMachineRuns).toHaveBeenCalledWith(
      'nts', 'clang-x86',
      { sort: '-submitted_at', limit: 25, cursor: undefined },
      expect.any(AbortSignal),
    );
  });

  it('renders run history table with UUID, Commit, Submitted columns', async () => {
    machineDetailPage.mount(container, { testsuite: 'nts', name: 'clang-x86' });

    await vi.waitFor(() => {
      const headers = Array.from(container.querySelectorAll('th')).map(h => h.textContent);
      expect(headers).toContain('Run UUID');
      expect(headers).toContain('Commit');
      expect(headers).toContain('Submitted');
    });
  });

  it('run UUIDs shown truncated to 8 chars as suite-scoped SPA links', async () => {
    machineDetailPage.mount(container, { testsuite: 'nts', name: 'clang-x86' });

    await vi.waitFor(() => {
      const runLink = container.querySelector('a[href*="/runs/"]') as HTMLAnchorElement;
      expect(runLink).toBeTruthy();
      expect(runLink.textContent).toBe('aaaaaaaa');
      expect(runLink.href).toContain('/v5/nts/runs/');
    });
  });

  it('pagination: Previous disabled on first page, Next present when cursor.next exists', async () => {
    (getMachineRuns as ReturnType<typeof vi.fn>).mockResolvedValue(
      runsResponse(mockRuns, 'next-cursor-1'),
    );

    machineDetailPage.mount(container, { testsuite: 'nts', name: 'clang-x86' });

    await vi.waitFor(() => {
      const buttons = container.querySelectorAll('.pagination-btn');
      const prevBtn = Array.from(buttons).find(b => b.textContent?.includes('Previous')) as HTMLButtonElement | undefined;
      const nextBtn = Array.from(buttons).find(b => b.textContent?.includes('Next')) as HTMLButtonElement | undefined;
      // First page: Previous exists but is disabled (cursorStack empty)
      expect(prevBtn?.disabled).toBe(true);
      expect(nextBtn).toBeTruthy();
      expect(nextBtn!.disabled).toBe(false);
    });
  });

  it('shows "No runs found." when no runs', async () => {
    (getMachineRuns as ReturnType<typeof vi.fn>).mockResolvedValue(runsResponse([]));

    machineDetailPage.mount(container, { testsuite: 'nts', name: 'clang-x86' });

    await vi.waitFor(() => {
      expect(container.textContent).toContain('No runs found.');
    });
  });

  it('shows error banner when getMachineRuns fails', async () => {
    (getMachineRuns as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Server error'));

    machineDetailPage.mount(container, { testsuite: 'nts', name: 'clang-x86' });

    await vi.waitFor(() => {
      const banners = container.querySelectorAll('.error-banner');
      const runBanner = Array.from(banners).find(b => b.textContent?.includes('Failed to load runs'));
      expect(runBanner).toBeTruthy();
    });
  });

  it('renders delete confirmation section', async () => {
    machineDetailPage.mount(container, { testsuite: 'nts', name: 'clang-x86' });

    const deleteBtn = container.querySelector('.action-links .admin-btn-danger');
    expect(deleteBtn).toBeTruthy();
    expect(deleteBtn!.textContent).toContain('Delete Machine');
  });

  it('post-deletion redirects to suite-agnostic test-suites page', async () => {
    (deleteMachine as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const originalLocation = window.location;
    const assignMock = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, assign: assignMock },
      writable: true,
      configurable: true,
    });

    try {
      machineDetailPage.mount(container, { testsuite: 'nts', name: 'clang-x86' });

      // Click the "Delete Machine" button to reveal confirmation
      const deleteBtn = container.querySelector('.admin-btn-danger') as HTMLButtonElement;
      deleteBtn.click();

      // Type the machine name to enable confirm
      const confirmInput = container.querySelector('.delete-machine-confirm input') as HTMLInputElement;
      confirmInput.value = 'clang-x86';
      confirmInput.dispatchEvent(new Event('input'));

      // Click "Confirm Delete"
      const confirmBtn = Array.from(container.querySelectorAll('.delete-machine-confirm .admin-btn-danger'))
        .find(b => b.textContent?.includes('Confirm')) as HTMLButtonElement;
      confirmBtn.click();

      await vi.waitFor(() => {
        expect(deleteMachine).toHaveBeenCalledWith('nts', 'clang-x86');
        // Should redirect to suite-agnostic test-suites page (not suite-scoped /machines)
        expect(assignMock).toHaveBeenCalledWith('/v5/test-suites?suite=nts');
      });
    } finally {
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      });
    }
  });

  it('unmount aborts without error', () => {
    (getMachine as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    (getMachineRuns as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

    machineDetailPage.mount(container, { testsuite: 'nts', name: 'clang-x86' });
    expect(() => machineDetailPage.unmount!()).not.toThrow();
  });

  describe('Show all regressions link', () => {
    it('"Show all regressions" link present after active regressions load', async () => {
      machineDetailPage.mount(container, { testsuite: 'nts', name: 'clang-x86' });

      await vi.waitFor(() => {
        const link = Array.from(container.querySelectorAll('a'))
          .find(a => a.textContent === 'Show all regressions');
        expect(link).toBeTruthy();
      });
    });

    it('link href points to test-suites regressions tab', async () => {
      machineDetailPage.mount(container, { testsuite: 'nts', name: 'clang-x86' });

      await vi.waitFor(() => {
        const link = Array.from(container.querySelectorAll('a'))
          .find(a => a.textContent === 'Show all regressions') as HTMLAnchorElement;
        expect(link).toBeTruthy();
        expect(link.getAttribute('href')).toContain('/test-suites?suite=nts&tab=regressions');
      });
    });
  });
});
