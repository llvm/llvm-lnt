// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the API module
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    getRegression: vi.fn(),
    updateRegression: vi.fn(),
    deleteRegression: vi.fn(),
    addRegressionIndicators: vi.fn(),
    removeRegressionIndicators: vi.fn(),
    getFields: vi.fn(),
    getTests: vi.fn(),
    getToken: vi.fn(),
    authErrorMessage: vi.fn((err: unknown) => `Auth error: ${err}`),
  };
});

// Mock router (needed for transitive imports)
vi.mock('../../router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../router')>();
  return {
    ...actual,
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

import {
  getRegression, updateRegression, deleteRegression,
  removeRegressionIndicators,
  getFields, getTests, getToken, authErrorMessage,
} from '../../api';
import { regressionDetailPage } from '../../pages/regression-detail';
import type { RegressionDetail, FieldInfo } from '../../types';

const TEST_UUID = 'aaaa1111-2222-3333-4444-555555555555';

const mockRegression: RegressionDetail = {
  uuid: TEST_UUID,
  title: 'compile_time regression',
  bug: 'https://bugs.example.com/1',
  notes: 'Some notes about this regression',
  state: 'detected',
  commit: 'abc123',
  indicators: [
    { uuid: 'ind-1111', machine: 'clang-x86', test: 'test_a', metric: 'compile_time' },
    { uuid: 'ind-2222', machine: 'gcc-arm', test: 'test_b', metric: 'execution_time' },
  ],
};

const mockFields: FieldInfo[] = [
  { name: 'compile_time', type: 'real', display_name: 'Compile Time', unit: null, unit_abbrev: null, bigger_is_better: null },
  { name: 'execution_time', type: 'real', display_name: 'Execution Time', unit: null, unit_abbrev: null, bigger_is_better: null },
];

describe('regressionDetailPage', () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');

    (getToken as ReturnType<typeof vi.fn>).mockReturnValue('test-token');
    (getRegression as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockRegression });
    (getFields as ReturnType<typeof vi.fn>).mockResolvedValue(mockFields);
    (updateRegression as ReturnType<typeof vi.fn>).mockImplementation(
      (_ts: string, _uuid: string, updates: Record<string, unknown>) =>
        Promise.resolve({ ...mockRegression, ...updates }),
    );
    (getTests as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [{ name: 'test_x' }, { name: 'test_y' }],
      nextCursor: null,
    });
  });

  afterEach(() => {
    regressionDetailPage.unmount?.();
  });

  /** Mount the page and wait for the header to render. */
  async function mountAndWait(): Promise<void> {
    regressionDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });
    await vi.waitFor(() => {
      expect(container.querySelector('.regression-header')).toBeTruthy();
    });
  }

  // ---------------------------------------------------------------
  // 1. Mount & rendering
  // ---------------------------------------------------------------

  describe('mount & rendering', () => {
    it('renders page header with truncated UUID', () => {
      regressionDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });
      expect(container.querySelector('.page-header')?.textContent).toBe(
        `Regression: ${TEST_UUID.slice(0, 8)}\u2026`,
      );
    });

    it('calls getRegression with correct params', () => {
      regressionDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });
      expect(getRegression).toHaveBeenCalledWith('nts', TEST_UUID, expect.any(AbortSignal));
    });

    it('renders header fields after load', async () => {
      regressionDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

      await vi.waitFor(() => {
        const header = container.querySelector('.regression-header');
        expect(header).toBeTruthy();
        expect(header!.textContent).toContain('Title');
        expect(header!.textContent).toContain('compile_time regression');
        expect(header!.textContent).toContain('State');
        expect(header!.textContent).toContain('Bug');
        expect(header!.textContent).toContain('Commit');
        expect(header!.textContent).toContain('Notes');
      });
    });

    it('calls getFields when token is present', () => {
      (getToken as ReturnType<typeof vi.fn>).mockReturnValue('test-token');
      regressionDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });
      expect(getFields).toHaveBeenCalledWith('nts', expect.any(AbortSignal));
    });

    it('does not call getFields when token is null', () => {
      (getToken as ReturnType<typeof vi.fn>).mockReturnValue(null);
      regressionDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });
      expect(getFields).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // 2. Read-only mode
  // ---------------------------------------------------------------

  describe('read-only mode (no token)', () => {
    beforeEach(() => {
      (getToken as ReturnType<typeof vi.fn>).mockReturnValue(null);
    });

    it('shows state as badge not dropdown', async () => {
      await mountAndWait();

      expect(container.querySelector('.state-badge')).toBeTruthy();
      expect(container.querySelector('.regression-header select')).toBeFalsy();
    });

    it('shows no edit buttons', async () => {
      await mountAndWait();

      expect(container.querySelectorAll('.edit-btn').length).toBe(0);
    });

    it('shows no add indicators panel', async () => {
      await mountAndWait();

      expect(container.querySelector('.add-indicators-panel')?.children.length || 0).toBe(0);
    });

    it('shows no delete section', async () => {
      await mountAndWait();

      // delete section should not have been appended to the container
      expect(container.querySelector('.delete-machine-section')?.children.length || 0).toBe(0);
    });

    it('shows no checkboxes in indicator table', async () => {
      await mountAndWait();

      expect(container.querySelectorAll('.indicator-table-container input[type="checkbox"]').length).toBe(0);
    });
  });

  // ---------------------------------------------------------------
  // 3. Title editing
  // ---------------------------------------------------------------

  describe('title editing', () => {
    it('shows Edit button, clicking opens input with Save and Cancel', async () => {
      await mountAndWait();

      const titleRow = container.querySelector('.field-row') as HTMLElement;
      const editBtn = titleRow.querySelector('.edit-btn') as HTMLElement;
      expect(editBtn.textContent).toBe('Edit');
      editBtn.click();

      const input = titleRow.querySelector('input') as HTMLInputElement;
      expect(input).toBeTruthy();
      expect(input.value).toBe('compile_time regression');

      const buttons = Array.from(titleRow.querySelectorAll('button'));
      expect(buttons.map(b => b.textContent)).toContain('Save');
      expect(buttons.map(b => b.textContent)).toContain('Cancel');
    });

    it('Cancel returns to display mode without API call', async () => {
      await mountAndWait();

      const titleRow = container.querySelector('.field-row') as HTMLElement;
      (titleRow.querySelector('.edit-btn') as HTMLElement).click();

      const cancelBtn = Array.from(titleRow.querySelectorAll('button'))
        .find(b => b.textContent === 'Cancel') as HTMLElement;
      cancelBtn.click();

      // Should be back to display mode
      await vi.waitFor(() => {
        expect(container.querySelector('.regression-header')!.textContent).toContain('compile_time regression');
        expect(container.querySelector('.regression-header')!.textContent).toContain('Edit');
      });
      expect(updateRegression).not.toHaveBeenCalled();
    });

    it('Save calls updateRegression and re-renders on success', async () => {
      (updateRegression as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockRegression,
        title: 'Updated title',
      });

      await mountAndWait();

      const titleRow = container.querySelector('.field-row') as HTMLElement;
      (titleRow.querySelector('.edit-btn') as HTMLElement).click();

      const input = titleRow.querySelector('input') as HTMLInputElement;
      input.value = 'Updated title';

      const saveBtn = Array.from(titleRow.querySelectorAll('button'))
        .find(b => b.textContent === 'Save') as HTMLElement;
      saveBtn.click();

      await vi.waitFor(() => {
        expect(updateRegression).toHaveBeenCalledWith(
          'nts', TEST_UUID,
          { title: 'Updated title' },
          expect.any(AbortSignal),
        );
        expect(container.querySelector('.regression-header')!.textContent).toContain('Updated title');
      });
    });

    it('Save shows error on failure', async () => {
      (updateRegression as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('403'));

      await mountAndWait();

      const titleRow = container.querySelector('.field-row') as HTMLElement;
      (titleRow.querySelector('.edit-btn') as HTMLElement).click();

      const saveBtn = Array.from(titleRow.querySelectorAll('button'))
        .find(b => b.textContent === 'Save') as HTMLElement;
      saveBtn.click();

      await vi.waitFor(() => {
        expect(authErrorMessage).toHaveBeenCalled();
        expect(container.querySelector('.error-banner')).toBeTruthy();
      });
    });
  });

  // ---------------------------------------------------------------
  // 4. State editing
  // ---------------------------------------------------------------

  describe('state editing', () => {
    it('dropdown change calls updateRegression', async () => {
      regressionDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

      await vi.waitFor(() => {
        expect(container.querySelector('.regression-header select')).toBeTruthy();
      });

      const stateSelect = container.querySelector('.regression-header select') as HTMLSelectElement;
      stateSelect.value = 'active';
      stateSelect.dispatchEvent(new Event('change'));

      await vi.waitFor(() => {
        expect(updateRegression).toHaveBeenCalledWith(
          'nts', TEST_UUID,
          { state: 'active' },
          expect.any(AbortSignal),
        );
      });
    });

    it('reverts dropdown on error', async () => {
      (updateRegression as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Fail'));

      regressionDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

      await vi.waitFor(() => {
        expect(container.querySelector('.regression-header select')).toBeTruthy();
      });

      const stateSelect = container.querySelector('.regression-header select') as HTMLSelectElement;
      stateSelect.value = 'fixed';
      stateSelect.dispatchEvent(new Event('change'));

      await vi.waitFor(() => {
        expect(stateSelect.value).toBe('detected');
        expect(container.querySelector('.error-banner')).toBeTruthy();
      });
    });
  });

  // ---------------------------------------------------------------
  // 5. Bug editing
  // ---------------------------------------------------------------

  describe('bug editing', () => {
    it('shows Edit button, clicking opens input with Save and Cancel', async () => {
      await mountAndWait();

      const fieldRows = container.querySelectorAll('.field-row');
      const bugRow = Array.from(fieldRows).find(r =>
        r.querySelector('label')?.textContent === 'Bug') as HTMLElement;

      const editBtn = bugRow.querySelector('.edit-btn') as HTMLElement;
      expect(editBtn.textContent).toBe('Edit');
      editBtn.click();

      const input = bugRow.querySelector('input') as HTMLInputElement;
      expect(input).toBeTruthy();
      expect(input.value).toBe('https://bugs.example.com/1');

      const buttons = Array.from(bugRow.querySelectorAll('button'));
      expect(buttons.map(b => b.textContent)).toContain('Save');
      expect(buttons.map(b => b.textContent)).toContain('Cancel');
    });

    it('Cancel returns to display mode', async () => {
      await mountAndWait();

      const fieldRows = container.querySelectorAll('.field-row');
      const bugRow = Array.from(fieldRows).find(r =>
        r.querySelector('label')?.textContent === 'Bug') as HTMLElement;

      (bugRow.querySelector('.edit-btn') as HTMLElement).click();

      const cancelBtn = Array.from(bugRow.querySelectorAll('button'))
        .find(b => b.textContent === 'Cancel') as HTMLElement;
      cancelBtn.click();

      expect(bugRow.textContent).toContain('bugs.example.com');
      expect(updateRegression).not.toHaveBeenCalled();
    });

    it('Save with empty string sends null', async () => {
      (updateRegression as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockRegression,
        bug: null,
      });

      await mountAndWait();

      const fieldRows = container.querySelectorAll('.field-row');
      const bugRow = Array.from(fieldRows).find(r =>
        r.querySelector('label')?.textContent === 'Bug') as HTMLElement;

      (bugRow.querySelector('.edit-btn') as HTMLElement).click();

      const input = bugRow.querySelector('input') as HTMLInputElement;
      input.value = '';

      const saveBtn = Array.from(bugRow.querySelectorAll('button'))
        .find(b => b.textContent === 'Save') as HTMLElement;
      saveBtn.click();

      await vi.waitFor(() => {
        expect(updateRegression).toHaveBeenCalledWith(
          'nts', TEST_UUID,
          { bug: null },
          expect.any(AbortSignal),
        );
      });
    });

    it('bug link has target=_blank', async () => {
      await mountAndWait();

      const bugLink = container.querySelector(
        '.regression-header a[href="https://bugs.example.com/1"]',
      ) as HTMLAnchorElement;
      expect(bugLink).toBeTruthy();
      expect(bugLink.getAttribute('target')).toBe('_blank');
    });
  });

  // ---------------------------------------------------------------
  // 6. Commit editing
  // ---------------------------------------------------------------

  describe('commit editing', () => {
    it('Clear calls updateRegression with commit: null', async () => {
      (updateRegression as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockRegression,
        commit: null,
      });

      await mountAndWait();

      const fieldRows = container.querySelectorAll('.field-row');
      const commitRow = Array.from(fieldRows).find(r =>
        r.querySelector('label')?.textContent === 'Commit') as HTMLElement;

      const clearBtn = Array.from(commitRow.querySelectorAll('.edit-btn'))
        .find(b => b.textContent === 'Clear') as HTMLElement;
      expect(clearBtn).toBeTruthy();
      clearBtn.click();

      await vi.waitFor(() => {
        expect(updateRegression).toHaveBeenCalledWith(
          'nts', TEST_UUID,
          { commit: null },
          expect.any(AbortSignal),
        );
      });
    });

    it('Clear shows error on failure', async () => {
      (updateRegression as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('500'));

      await mountAndWait();

      const fieldRows = container.querySelectorAll('.field-row');
      const commitRow = Array.from(fieldRows).find(r =>
        r.querySelector('label')?.textContent === 'Commit') as HTMLElement;

      const clearBtn = Array.from(commitRow.querySelectorAll('.edit-btn'))
        .find(b => b.textContent === 'Clear') as HTMLElement;
      clearBtn.click();

      await vi.waitFor(() => {
        expect(authErrorMessage).toHaveBeenCalled();
        expect(container.querySelector('.error-banner')).toBeTruthy();
      });
    });
  });

  // ---------------------------------------------------------------
  // 7. Notes
  // ---------------------------------------------------------------

  describe('notes', () => {
    it('blur-to-save calls updateRegression when value changed', async () => {
      regressionDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

      await vi.waitFor(() => {
        expect(container.querySelector('.regression-notes-input')).toBeTruthy();
      });

      const textarea = container.querySelector('.regression-notes-input') as HTMLTextAreaElement;
      textarea.value = 'Updated notes';
      textarea.dispatchEvent(new Event('blur'));

      await vi.waitFor(() => {
        expect(updateRegression).toHaveBeenCalledWith(
          'nts', TEST_UUID,
          { notes: 'Updated notes' },
          expect.any(AbortSignal),
        );
      });
    });

    it('blur with unchanged value is a no-op', async () => {
      regressionDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

      await vi.waitFor(() => {
        expect(container.querySelector('.regression-notes-input')).toBeTruthy();
      });

      const textarea = container.querySelector('.regression-notes-input') as HTMLTextAreaElement;
      // Value should already be pre-filled with notes
      textarea.dispatchEvent(new Event('blur'));

      expect(updateRegression).not.toHaveBeenCalled();
    });

    it('blur with empty string sends null', async () => {
      regressionDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

      await vi.waitFor(() => {
        expect(container.querySelector('.regression-notes-input')).toBeTruthy();
      });

      const textarea = container.querySelector('.regression-notes-input') as HTMLTextAreaElement;
      textarea.value = '';
      textarea.dispatchEvent(new Event('blur'));

      await vi.waitFor(() => {
        expect(updateRegression).toHaveBeenCalledWith(
          'nts', TEST_UUID,
          { notes: null },
          expect.any(AbortSignal),
        );
      });
    });
  });

  // ---------------------------------------------------------------
  // 8. Indicators
  // ---------------------------------------------------------------

  describe('indicators', () => {
    it('renders indicator rows', async () => {
      regressionDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

      await vi.waitFor(() => {
        const table = container.querySelector('.indicator-table-container table');
        expect(table).toBeTruthy();
        const rows = table!.querySelectorAll('tbody tr');
        expect(rows.length).toBe(2);
        expect(table!.textContent).toContain('clang-x86');
        expect(table!.textContent).toContain('test_a');
        expect(table!.textContent).toContain('compile_time');
      });
    });

    it('renders view-on-graph links', async () => {
      regressionDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

      await vi.waitFor(() => {
        const graphLinks = container.querySelectorAll(
          '.indicator-table-container a[href*="/graph?"]',
        );
        expect(graphLinks.length).toBe(2);
        const href = graphLinks[0].getAttribute('href')!;
        expect(href).toContain('suite=nts');
        expect(href).toContain('machine=clang-x86');
        expect(href).toContain('metric=compile_time');
        expect(href).toContain('test_filter=test_a');
        expect(href).toContain('commit=abc123');
      });
    });

    it('single remove calls removeRegressionIndicators', async () => {
      (removeRegressionIndicators as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockRegression,
        indicators: [mockRegression.indicators[1]],
      });

      regressionDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

      await vi.waitFor(() => {
        expect(container.querySelectorAll('.indicator-table-container .row-delete-btn').length).toBe(2);
      });

      (container.querySelector('.indicator-table-container .row-delete-btn') as HTMLElement).click();

      await vi.waitFor(() => {
        expect(removeRegressionIndicators).toHaveBeenCalledWith(
          'nts', TEST_UUID,
          ['ind-1111'],
          expect.any(AbortSignal),
        );
      });
    });

    it('batch remove sends selected UUIDs', async () => {
      (removeRegressionIndicators as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockRegression,
        indicators: [],
      });

      regressionDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

      await vi.waitFor(() => {
        expect(container.querySelectorAll('.indicator-table-container input[type="checkbox"]').length).toBe(2);
      });

      // Check both checkboxes
      const checkboxes = container.querySelectorAll<HTMLInputElement>(
        '.indicator-table-container input[type="checkbox"]',
      );
      checkboxes.forEach(cb => {
        cb.checked = true;
        cb.dispatchEvent(new Event('change'));
      });

      // Click batch remove
      const removeBtn = Array.from(container.querySelectorAll('.indicator-actions button'))
        .find(b => b.textContent?.includes('Remove selected')) as HTMLButtonElement;
      expect(removeBtn).toBeTruthy();
      expect(removeBtn.disabled).toBe(false);
      removeBtn.click();

      await vi.waitFor(() => {
        expect(removeRegressionIndicators).toHaveBeenCalledWith(
          'nts', TEST_UUID,
          expect.arrayContaining(['ind-1111', 'ind-2222']),
          expect.any(AbortSignal),
        );
      });
    });

    it('shows error on remove failure', async () => {
      (removeRegressionIndicators as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Server error'),
      );

      regressionDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

      await vi.waitFor(() => {
        expect(container.querySelectorAll('.indicator-table-container .row-delete-btn').length).toBe(2);
      });

      (container.querySelector('.indicator-table-container .row-delete-btn') as HTMLElement).click();

      await vi.waitFor(() => {
        expect(authErrorMessage).toHaveBeenCalled();
        expect(container.querySelector('.error-banner')).toBeTruthy();
      });
    });

    it('shows empty state when no indicators', async () => {
      (getRegression as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockRegression,
        indicators: [],
      });

      regressionDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

      await vi.waitFor(() => {
        expect(container.querySelector('.indicator-table-container .no-results')?.textContent).toBe(
          'No indicators.',
        );
      });
    });
  });

  // ---------------------------------------------------------------
  // 9. Delete
  // ---------------------------------------------------------------

  describe('delete', () => {
    it('renders delete confirm section and navigates on success', async () => {
      (deleteRegression as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      const originalLocation = window.location;
      const assignMock = vi.fn();
      Object.defineProperty(window, 'location', {
        value: { ...window.location, assign: assignMock },
        writable: true,
        configurable: true,
      });

      try {
        regressionDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

        await vi.waitFor(() => {
          expect(container.querySelector('.delete-machine-section .admin-btn-danger')).toBeTruthy();
        });

        // Click the "Delete Regression" button to reveal confirmation
        const deleteBtn = container.querySelector('.delete-machine-section .admin-btn-danger') as HTMLButtonElement;
        deleteBtn.click();

        // Type the UUID prefix to enable confirm
        const confirmInput = container.querySelector(
          '.delete-machine-confirm input',
        ) as HTMLInputElement;
        confirmInput.value = TEST_UUID.slice(0, 8);
        confirmInput.dispatchEvent(new Event('input'));

        // Click "Confirm Delete"
        const confirmBtn = Array.from(
          container.querySelectorAll('.delete-machine-confirm .admin-btn-danger'),
        ).find(b => b.textContent?.includes('Confirm')) as HTMLButtonElement;
        expect(confirmBtn.disabled).toBe(false);
        confirmBtn.click();

        await vi.waitFor(() => {
          expect(deleteRegression).toHaveBeenCalledWith('nts', TEST_UUID, expect.any(AbortSignal));
          expect(assignMock).toHaveBeenCalledWith(
            expect.stringContaining('/test-suites?suite=nts&tab=regressions'));
        });
      } finally {
        Object.defineProperty(window, 'location', {
          value: originalLocation,
          writable: true,
          configurable: true,
        });
      }
    });
  });

  // ---------------------------------------------------------------
  // 10. Load error
  // ---------------------------------------------------------------

  describe('load error', () => {
    it('shows error banner when getRegression rejects', async () => {
      (getRegression as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Not found'));

      regressionDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });

      await vi.waitFor(() => {
        const banner = container.querySelector('.error-banner');
        expect(banner).toBeTruthy();
        expect(banner!.textContent).toContain('Failed to load regression');
      });
    });
  });

  // ---------------------------------------------------------------
  // 11. Unmount
  // ---------------------------------------------------------------

  describe('unmount', () => {
    it('does not throw', () => {
      (getRegression as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
      (getFields as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

      regressionDetailPage.mount(container, { testsuite: 'nts', uuid: TEST_UUID });
      expect(() => regressionDetailPage.unmount!()).not.toThrow();
    });
  });
});
