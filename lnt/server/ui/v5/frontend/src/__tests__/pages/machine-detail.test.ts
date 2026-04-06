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

import { getMachine, getMachineRuns } from '../../api';
import { machineDetailPage } from '../../pages/machine-detail';
import type { MachineInfo, MachineRunInfo } from '../../types';

const mockMachine: MachineInfo = {
  name: 'clang-x86',
  info: { hostname: 'build01', os: 'linux', arch: 'x86_64' },
};

const mockRuns: MachineRunInfo[] = [
  { uuid: 'aaaaaaaa-1111-2222-3333-444444444444', order: { rev: '100' }, start_time: '2026-01-01T10:00:00Z', end_time: null },
  { uuid: 'bbbbbbbb-1111-2222-3333-444444444444', order: { rev: '101' }, start_time: '2026-01-02T10:00:00Z', end_time: null },
];

function runsResponse(items: MachineRunInfo[], nextCursor: string | null = null) {
  return { items, cursor: { next: nextCursor, previous: null } };
}

describe('machineDetailPage', () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');

    (getMachine as ReturnType<typeof vi.fn>).mockResolvedValue(mockMachine);
    (getMachineRuns as ReturnType<typeof vi.fn>).mockResolvedValue(runsResponse(mockRuns));
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

  it('renders View Graph and Compare action links with correct URLs', () => {
    machineDetailPage.mount(container, { testsuite: 'nts', name: 'clang-x86' });

    const links = container.querySelectorAll('.action-links a');
    expect(links).toHaveLength(2);
    expect(links[0].textContent).toBe('View Graph');
    expect(links[0].getAttribute('href')).toContain('/graph?machine=clang-x86');
    expect(links[1].textContent).toBe('Compare');
    expect(links[1].getAttribute('href')).toContain('/compare?machine_a=clang-x86');
  });

  it('calls getMachineRuns with correct params', () => {
    machineDetailPage.mount(container, { testsuite: 'nts', name: 'clang-x86' });

    expect(getMachineRuns).toHaveBeenCalledWith(
      'nts', 'clang-x86',
      { sort: '-start_time', limit: 25, cursor: undefined },
      expect.any(AbortSignal),
    );
  });

  it('renders run history table with UUID, Order, Start Time columns', async () => {
    machineDetailPage.mount(container, { testsuite: 'nts', name: 'clang-x86' });

    await vi.waitFor(() => {
      const headers = Array.from(container.querySelectorAll('th')).map(h => h.textContent);
      expect(headers).toContain('Run UUID');
      expect(headers).toContain('Order');
      expect(headers).toContain('Start Time');
    });
  });

  it('run UUIDs shown truncated to 8 chars as SPA links', async () => {
    machineDetailPage.mount(container, { testsuite: 'nts', name: 'clang-x86' });

    await vi.waitFor(() => {
      const runLink = container.querySelector('a[href*="/runs/"]');
      expect(runLink).toBeTruthy();
      expect(runLink!.textContent).toBe('aaaaaaaa');
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

    const deleteSection = container.querySelector('.delete-machine-section');
    expect(deleteSection).toBeTruthy();
    expect(deleteSection!.textContent).toContain('Delete Machine');
  });

  it('unmount aborts without error', () => {
    (getMachine as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    (getMachineRuns as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

    machineDetailPage.mount(container, { testsuite: 'nts', name: 'clang-x86' });
    expect(() => machineDetailPage.unmount!()).not.toThrow();
  });
});
