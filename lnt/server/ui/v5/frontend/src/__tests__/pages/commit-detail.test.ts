// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the API module
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    getCommit: vi.fn(),
    getRunsByCommit: vi.fn(),
    updateCommit: vi.fn(),
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

import { getCommit, getRunsByCommit, updateCommit, authErrorMessage } from '../../api';
import { navigate } from '../../router';
import { commitDetailPage } from '../../pages/commit-detail';
import type { CommitDetail, RunInfo } from '../../types';

const mockCommit: CommitDetail = {
  commit: '100',
  ordinal: 42,
  tag: 'release-18',
  fields: { rev: '100' },
  previous_commit: { commit: '99', ordinal: 41, tag: null, link: '/commits/99' },
  next_commit: { commit: '101', ordinal: 43, tag: null, link: '/commits/101' },
};

const mockRuns: RunInfo[] = [
  { uuid: 'aaaa-1111', machine: 'clang-x86', commit: '100', submitted_at: '2026-01-01T10:00:00Z' },
  { uuid: 'bbbb-2222', machine: 'clang-x86', commit: '100', submitted_at: '2026-01-01T11:00:00Z' },
  { uuid: 'cccc-3333', machine: 'gcc-arm', commit: '100', submitted_at: '2026-01-01T12:00:00Z' },
];

describe('commitDetailPage', () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    container = document.createElement('div');

    (getCommit as ReturnType<typeof vi.fn>).mockResolvedValue(mockCommit);
    (getRunsByCommit as ReturnType<typeof vi.fn>).mockResolvedValue(mockRuns);
    (updateCommit as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockCommit, ordinal: 99 });
  });

  afterEach(() => {
    commitDetailPage.unmount?.();
    vi.useRealTimers();
  });

  it('renders page header with commit value', () => {
    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    expect(container.querySelector('.page-header')?.textContent).toBe('Commit: 100');
  });

  it('calls getCommit and getRunsByCommit in parallel', () => {
    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    expect(getCommit).toHaveBeenCalledWith('nts', '100', expect.any(AbortSignal));
    expect(getRunsByCommit).toHaveBeenCalledWith('nts', '100', expect.any(AbortSignal));
  });

  it('renders commit fields as dl key-value pairs', async () => {
    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      const dl = container.querySelector('.metadata-dl');
      expect(dl).toBeTruthy();
      expect(dl!.textContent).toContain('rev');
      expect(dl!.textContent).toContain('100');
    });
  });

  it('shows ordinal value and Edit button', async () => {
    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      const ordinalDisplay = container.querySelector('[data-field="ordinal"]');
      expect(ordinalDisplay).toBeTruthy();
      expect(ordinalDisplay!.textContent).toContain('42');
      expect(ordinalDisplay!.querySelector('button')?.textContent).toBe('Edit');
    });
  });

  it('shows "(none)" when ordinal is null', async () => {
    (getCommit as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockCommit, ordinal: null });

    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      const ordinalDisplay = container.querySelector('[data-field="ordinal"]');
      expect(ordinalDisplay!.textContent).toContain('(none)');
    });
  });

  it('clicking Edit shows inline edit form with input, Save, Cancel', async () => {
    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      expect(container.querySelector('[data-field="ordinal"] button')).toBeTruthy();
    });

    // Click Edit
    const editBtn = container.querySelector('[data-field="ordinal"] button') as HTMLElement;
    editBtn.click();

    // Should now show input, Save, Cancel
    const ordinalContainer = container.querySelector('[data-field="ordinal"]')!;
    const input = ordinalContainer.querySelector('input') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe('42'); // pre-filled

    const buttons = ordinalContainer.querySelectorAll('button');
    const buttonTexts = Array.from(buttons).map(b => b.textContent);
    expect(buttonTexts).toContain('Save');
    expect(buttonTexts).toContain('Cancel');
  });

  it('Cancel returns to display mode without API call', async () => {
    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      expect(container.querySelector('[data-field="ordinal"] button')).toBeTruthy();
    });

    // Click Edit
    (container.querySelector('[data-field="ordinal"] button') as HTMLElement).click();

    // Click Cancel
    const cancelBtn = Array.from(container.querySelectorAll('[data-field="ordinal"] button'))
      .find(b => b.textContent === 'Cancel') as HTMLElement;
    cancelBtn.click();

    // Should be back to display mode
    expect(container.querySelector('[data-field="ordinal"]')!.textContent).toContain('42');
    expect(container.querySelector('[data-field="ordinal"]')!.textContent).toContain('Edit');
    expect(updateCommit).not.toHaveBeenCalled();
  });

  it('Save calls updateCommit and re-renders ordinal on success', async () => {
    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      expect(container.querySelector('[data-field="ordinal"] button')).toBeTruthy();
    });

    // Click Edit
    (container.querySelector('[data-field="ordinal"] button') as HTMLElement).click();

    // Change value and click Save
    const input = container.querySelector('[data-field="ordinal"] input') as HTMLInputElement;
    input.value = '99';

    const saveBtn = Array.from(container.querySelectorAll('[data-field="ordinal"] button'))
      .find(b => b.textContent === 'Save') as HTMLElement;
    saveBtn.click();

    await vi.waitFor(() => {
      expect(updateCommit).toHaveBeenCalledWith('nts', '100', { ordinal: 99 });
      // Should be back in display mode with new ordinal
      expect(container.querySelector('[data-field="ordinal"]')!.textContent).toContain('99');
    });
  });

  it('Save shows error on failure and re-enables button', async () => {
    (updateCommit as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('403 forbidden'));

    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      expect(container.querySelector('[data-field="ordinal"] button')).toBeTruthy();
    });

    (container.querySelector('[data-field="ordinal"] button') as HTMLElement).click();

    const saveBtn = Array.from(container.querySelectorAll('[data-field="ordinal"] button'))
      .find(b => b.textContent === 'Save') as HTMLButtonElement;
    saveBtn.click();

    await vi.waitFor(() => {
      expect(authErrorMessage).toHaveBeenCalled();
      const errorEl = container.querySelector('[data-field="ordinal"] .error-banner');
      expect(errorEl).toBeTruthy();
      // Save button should be re-enabled
      const currentSaveBtn = Array.from(container.querySelectorAll('[data-field="ordinal"] button'))
        .find(b => b.textContent === 'Save') as HTMLButtonElement;
      expect(currentSaveBtn.disabled).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Tag display + edit
  // ---------------------------------------------------------------------------

  it('shows tag value and Edit button', async () => {
    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      const tagDisplay = container.querySelector('[data-field="tag"]');
      expect(tagDisplay).toBeTruthy();
      expect(tagDisplay!.textContent).toContain('Tag:');
      expect(tagDisplay!.textContent).toContain('release-18');
      expect(tagDisplay!.querySelector('button')?.textContent).toBe('Edit');
    });
  });

  it('shows "(none)" when tag is null', async () => {
    (getCommit as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockCommit, tag: null });

    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      const tagDisplay = container.querySelector('[data-field="tag"]');
      expect(tagDisplay!.textContent).toContain('(none)');
    });
  });

  it('Save tag calls updateCommit', async () => {
    (updateCommit as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockCommit, tag: 'new-tag' });

    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      const tagDisplay = container.querySelector('[data-field="tag"]');
      expect(tagDisplay!.querySelector('button')).toBeTruthy();
    });

    // Click Edit on the tag container
    const tagContainer = container.querySelector('[data-field="tag"]')!;
    (tagContainer.querySelector('button') as HTMLElement).click();

    // Type new tag value and click Save
    const input = tagContainer.querySelector('input') as HTMLInputElement;
    input.value = 'new-tag';

    const saveBtn = Array.from(tagContainer.querySelectorAll('button'))
      .find(b => b.textContent === 'Save') as HTMLElement;
    saveBtn.click();

    await vi.waitFor(() => {
      expect(updateCommit).toHaveBeenCalledWith('nts', '100', { tag: 'new-tag' });
    });
  });

  it('renders Previous button when previous_commit exists', async () => {
    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      const navContainer = container.querySelector('.commit-nav');
      expect(navContainer).toBeTruthy();
      const prevBtn = Array.from(navContainer!.querySelectorAll('button'))
        .find(b => b.textContent?.includes('Previous'));
      expect(prevBtn).toBeTruthy();
    });
  });

  it('renders Next button when next_commit exists', async () => {
    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      const navContainer = container.querySelector('.commit-nav');
      const nextBtn = Array.from(navContainer!.querySelectorAll('button'))
        .find(b => b.textContent?.includes('Next'));
      expect(nextBtn).toBeTruthy();
    });
  });

  it('does not render Previous/Next when neighbors are null', async () => {
    (getCommit as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockCommit,
      previous_commit: null,
      next_commit: null,
    });

    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      const navContainer = container.querySelector('.commit-nav');
      expect(navContainer).toBeTruthy();
      expect(navContainer!.querySelectorAll('button')).toHaveLength(0);
    });
  });

  it('clicking Previous navigates to previous commit', async () => {
    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      const navContainer = container.querySelector('.commit-nav');
      expect(navContainer!.querySelectorAll('button').length).toBeGreaterThan(0);
    });

    const prevBtn = Array.from(container.querySelector('.commit-nav')!.querySelectorAll('button'))
      .find(b => b.textContent?.includes('Previous')) as HTMLElement;
    prevBtn.click();

    expect(navigate).toHaveBeenCalledWith(expect.stringContaining('/commits/99'));
  });

  it('renders runs summary', async () => {
    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      // 3 runs across 2 machines
      expect(container.textContent).toContain('3 runs across 2 machines');
    });
  });

  it('renders runs table with Machine, Run UUID, Submitted columns', async () => {
    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      const headers = Array.from(container.querySelectorAll('th')).map(h => h.textContent);
      expect(headers).toContain('Machine');
      expect(headers).toContain('Run UUID');
      expect(headers).toContain('Submitted');
    });
  });

  it('machine and run links use suite-scoped hrefs', async () => {
    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

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
    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

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
    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

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
    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

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

  it('regex filter via re: prefix filters machines', async () => {
    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      expect(container.querySelector('table')).toBeTruthy();
    });

    const filterInput = container.querySelector('.test-filter-input') as HTMLInputElement;
    filterInput.value = 're:clang.*x86';
    filterInput.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(200);

    await vi.waitFor(() => {
      const rows = container.querySelectorAll('tbody tr');
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.textContent).toMatch(/clang.*x86/i);
      }
    });
  });

  it('invalid regex shows filter-invalid class on input', async () => {
    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      expect(container.querySelector('table')).toBeTruthy();
    });

    const filterInput = container.querySelector('.test-filter-input') as HTMLInputElement;
    filterInput.value = 're:invalid[';
    filterInput.dispatchEvent(new Event('input'));

    expect(filterInput.classList.contains('filter-invalid')).toBe(true);

    filterInput.value = 're:valid.*';
    filterInput.dispatchEvent(new Event('input'));

    expect(filterInput.classList.contains('filter-invalid')).toBe(false);
  });

  it('shows regex badge when typing re: prefix', async () => {
    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      expect(container.querySelector('table')).toBeTruthy();
    });

    const filterInput = container.querySelector('.test-filter-input') as HTMLInputElement;
    filterInput.value = 're:clang';
    filterInput.dispatchEvent(new Event('input'));

    const badge = container.querySelector('.filter-regex-badge');
    expect(badge).toBeTruthy();
    expect(badge!.textContent).toBe('regex');
    expect(badge!.classList.contains('filter-regex-badge-invalid')).toBe(false);
  });

  it('regex badge shows invalid state on bad regex', async () => {
    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      expect(container.querySelector('table')).toBeTruthy();
    });

    const filterInput = container.querySelector('.test-filter-input') as HTMLInputElement;
    filterInput.value = 're:invalid[';
    filterInput.dispatchEvent(new Event('input'));

    const badge = container.querySelector('.filter-regex-badge');
    expect(badge).toBeTruthy();
    expect(badge!.classList.contains('filter-regex-badge-invalid')).toBe(true);
  });

  it('shows error banner on initial load failure', async () => {
    (getCommit as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Not found'));

    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });

    await vi.waitFor(() => {
      const banner = container.querySelector('.error-banner');
      expect(banner).toBeTruthy();
      expect(banner!.textContent).toContain('Failed to load commit');
    });
  });

  it('unmount aborts without error', () => {
    (getCommit as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    (getRunsByCommit as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

    commitDetailPage.mount(container, { testsuite: 'nts', value: '100' });
    expect(() => commitDetailPage.unmount!()).not.toThrow();
  });
});
