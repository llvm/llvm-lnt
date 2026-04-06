// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the API module
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    getMachines: vi.fn(),
  };
});

// Mock Plotly (may be loaded by transitive imports)
(globalThis as unknown as Record<string, unknown>).Plotly = {
  newPlot: vi.fn(),
  react: vi.fn(),
  purge: vi.fn(),
  Fx: { hover: vi.fn(), unhover: vi.fn() },
};

import { getMachines } from '../../api';
import { machineListPage } from '../../pages/machine-list';
import type { MachineInfo } from '../../types';

const mockMachines: MachineInfo[] = [
  { name: 'clang-x86', info: { hostname: 'build01', os: 'linux', arch: 'x86_64' } },
  { name: 'gcc-arm', info: { hostname: 'build02', os: 'linux' } },
  { name: 'msvc-win', info: {} },
];

function machinesResponse(items: MachineInfo[], total: number) {
  return { items, total, cursor: { next: null, previous: null } };
}

describe('machineListPage', () => {
  let container: HTMLElement;
  const savedLocation = window.location;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    container = document.createElement('div');

    // Reset URL state
    delete (window as Record<string, unknown>).location;
    (window as Record<string, unknown>).location = {
      ...savedLocation,
      search: '',
      pathname: '/v5/nts/machines',
    };
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});

    (getMachines as ReturnType<typeof vi.fn>).mockResolvedValue(
      machinesResponse(mockMachines, mockMachines.length),
    );
  });

  afterEach(() => {
    machineListPage.unmount?.();
    vi.useRealTimers();
    (window as Record<string, unknown>).location = savedLocation;
  });

  it('renders page header "Machines" and search input', () => {
    machineListPage.mount(container, { testsuite: 'nts' });

    expect(container.querySelector('.page-header')?.textContent).toBe('Machines');
    expect(container.querySelector('.test-filter-input')).toBeTruthy();
  });

  it('calls getMachines with default params on mount', () => {
    machineListPage.mount(container, { testsuite: 'nts' });

    expect(getMachines).toHaveBeenCalledWith(
      'nts',
      { nameContains: undefined, limit: 25, offset: 0 },
      expect.any(AbortSignal),
    );
  });

  it('shows loading message then data table after load', async () => {
    machineListPage.mount(container, { testsuite: 'nts' });

    // Loading state appears synchronously
    expect(container.querySelector('.progress-label')?.textContent).toBe('Loading machines...');

    // Table appears after async load
    await vi.waitFor(() => {
      expect(container.querySelector('table')).toBeTruthy();
      expect(container.querySelector('.progress-label')).toBeNull();
    });
  });

  it('table has Name and Info columns with correct data', async () => {
    machineListPage.mount(container, { testsuite: 'nts' });

    await vi.waitFor(() => {
      const headers = Array.from(container.querySelectorAll('th')).map(h => h.textContent);
      expect(headers).toContain('Name');
      expect(headers).toContain('Info');
    });
  });

  it('machine names render as SPA links to /machines/{name}', async () => {
    machineListPage.mount(container, { testsuite: 'nts' });

    await vi.waitFor(() => {
      const link = container.querySelector('a[href*="/machines/clang-x86"]');
      expect(link).toBeTruthy();
      expect(link!.textContent).toBe('clang-x86');
    });
  });

  it('info column shows first 3 key-value pairs', async () => {
    machineListPage.mount(container, { testsuite: 'nts' });

    await vi.waitFor(() => {
      const rows = container.querySelectorAll('tbody tr');
      // First machine has 3 info fields
      expect(rows[0].textContent).toContain('hostname: build01');
      expect(rows[0].textContent).toContain('os: linux');
      expect(rows[0].textContent).toContain('arch: x86_64');
    });
  });

  it('info column shows empty string when machine has no info', async () => {
    machineListPage.mount(container, { testsuite: 'nts' });

    await vi.waitFor(() => {
      const rows = container.querySelectorAll('tbody tr');
      // Third machine (msvc-win) has empty info
      const infoCells = rows[2].querySelectorAll('td');
      expect(infoCells[1].textContent).toBe('');
    });
  });

  it('shows "No machines found." for empty result', async () => {
    (getMachines as ReturnType<typeof vi.fn>).mockResolvedValue(
      machinesResponse([], 0),
    );

    machineListPage.mount(container, { testsuite: 'nts' });

    await vi.waitFor(() => {
      expect(container.textContent).toContain('No machines found.');
    });
  });

  it('shows error banner on API failure', async () => {
    (getMachines as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

    machineListPage.mount(container, { testsuite: 'nts' });

    await vi.waitFor(() => {
      const banner = container.querySelector('.error-banner');
      expect(banner).toBeTruthy();
      expect(banner!.textContent).toContain('Failed to load machines');
    });
  });

  it('reads initial search term from URL ?search= parameter', () => {
    (window.location as Record<string, unknown>).search = '?search=clang';

    machineListPage.mount(container, { testsuite: 'nts' });

    expect(getMachines).toHaveBeenCalledWith(
      'nts',
      expect.objectContaining({ nameContains: 'clang' }),
      expect.any(AbortSignal),
    );

    const input = container.querySelector('.test-filter-input') as HTMLInputElement;
    expect(input.value).toBe('clang');
  });

  it('search input typing triggers getMachines after 300ms debounce', async () => {
    machineListPage.mount(container, { testsuite: 'nts' });

    // Wait for initial load
    await vi.waitFor(() => {
      expect(container.querySelector('table')).toBeTruthy();
    });

    vi.clearAllMocks();

    const input = container.querySelector('.test-filter-input') as HTMLInputElement;
    input.value = 'gcc';
    input.dispatchEvent(new Event('input'));

    // Not called yet (debounce not elapsed)
    expect(getMachines).not.toHaveBeenCalled();

    // Advance past debounce
    vi.advanceTimersByTime(300);

    // Now should be called with search filter
    expect(getMachines).toHaveBeenCalledWith(
      'nts',
      expect.objectContaining({ nameContains: 'gcc', offset: 0 }),
      expect.any(AbortSignal),
    );
  });

  it('pagination renders when total > PAGE_SIZE', async () => {
    (getMachines as ReturnType<typeof vi.fn>).mockResolvedValue(
      machinesResponse(mockMachines, 50), // total > 25
    );

    machineListPage.mount(container, { testsuite: 'nts' });

    await vi.waitFor(() => {
      expect(container.querySelector('.pagination-btn')).toBeTruthy();
      expect(container.textContent).toContain('1\u20133 of 50');
    });
  });

  it('clicking Next increments offset by 25', async () => {
    (getMachines as ReturnType<typeof vi.fn>).mockResolvedValue(
      machinesResponse(mockMachines, 50),
    );

    machineListPage.mount(container, { testsuite: 'nts' });

    await vi.waitFor(() => {
      expect(container.querySelector('.pagination-btn')).toBeTruthy();
    });

    vi.clearAllMocks();
    (getMachines as ReturnType<typeof vi.fn>).mockResolvedValue(
      machinesResponse(mockMachines, 50),
    );

    // Find and click Next button
    const buttons = container.querySelectorAll('.pagination-btn');
    const nextBtn = Array.from(buttons).find(b => b.textContent?.includes('Next'));
    expect(nextBtn).toBeTruthy();
    (nextBtn as HTMLElement).click();

    expect(getMachines).toHaveBeenCalledWith(
      'nts',
      expect.objectContaining({ offset: 25 }),
      expect.any(AbortSignal),
    );
  });

  it('unmount aborts without error', () => {
    (getMachines as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

    machineListPage.mount(container, { testsuite: 'nts' });
    expect(() => machineListPage.unmount!()).not.toThrow();
  });
});
