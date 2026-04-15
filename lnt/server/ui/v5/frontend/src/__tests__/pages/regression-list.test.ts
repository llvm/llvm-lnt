// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the API module
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    getRegressions: vi.fn(),
    createRegression: vi.fn(),
    deleteRegression: vi.fn(),
    getFields: vi.fn(),
    getToken: vi.fn(),
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

import {
  getRegressions, createRegression, deleteRegression,
  getFields, getToken, authErrorMessage,
} from '../../api';
import type { CursorPageResult } from '../../api';
import { navigate } from '../../router';
import { regressionListPage } from '../../pages/regression-list';
import type { RegressionListItem, FieldInfo } from '../../types';

const mockRegressions: RegressionListItem[] = [
  {
    uuid: 'aaaa1111-2222-3333-4444-555555555555',
    title: 'compile_time regression on x86',
    bug: 'https://bugs.example.com/1',
    state: 'detected',
    commit: 'abc123',
    machine_count: 2,
    test_count: 5,
  },
  {
    uuid: 'bbbb1111-2222-3333-4444-555555555555',
    title: 'execution_time spike on ARM',
    bug: null,
    state: 'active',
    commit: null,
    machine_count: 1,
    test_count: 3,
  },
];

const mockFields: FieldInfo[] = [
  { name: 'compile_time', type: 'real', display_name: 'Compile Time', unit: null, unit_abbrev: null, bigger_is_better: null },
  { name: 'execution_time', type: 'real', display_name: 'Execution Time', unit: null, unit_abbrev: null, bigger_is_better: null },
];

function regressionsResponse(
  items: RegressionListItem[],
  nextCursor: string | null = null,
): CursorPageResult<RegressionListItem> {
  return { items, nextCursor };
}

describe('regressionListPage', () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');

    (getToken as ReturnType<typeof vi.fn>).mockReturnValue('test-token');
    (getRegressions as ReturnType<typeof vi.fn>).mockResolvedValue(
      regressionsResponse(mockRegressions),
    );
    (getFields as ReturnType<typeof vi.fn>).mockResolvedValue(mockFields);
  });

  afterEach(() => {
    regressionListPage.unmount?.();
  });

  /** Mount the page and wait for the table to render. */
  async function mountAndWait(): Promise<void> {
    regressionListPage.mount(container, { testsuite: 'nts' });
    await vi.waitFor(() => {
      expect(container.querySelector('tbody')).toBeTruthy();
    });
  }

  // ---------------------------------------------------------------
  // 1. Mount & rendering
  // ---------------------------------------------------------------

  describe('mount & rendering', () => {
    it('renders page header', () => {
      regressionListPage.mount(container, { testsuite: 'nts' });
      expect(container.querySelector('.page-header')?.textContent).toBe('Regressions');
    });

    it('calls getRegressions on mount', () => {
      regressionListPage.mount(container, { testsuite: 'nts' });
      expect(getRegressions).toHaveBeenCalledWith(
        'nts',
        expect.objectContaining({ limit: 25 }),
        expect.any(AbortSignal),
      );
    });

    it('renders table rows for each regression', async () => {
      regressionListPage.mount(container, { testsuite: 'nts' });

      await vi.waitFor(() => {
        const rows = container.querySelectorAll('tbody tr');
        expect(rows.length).toBe(2);
        expect(container.textContent).toContain('compile_time regression on x86');
        expect(container.textContent).toContain('execution_time spike on ARM');
      });
    });

    it('shows empty state when no regressions', async () => {
      (getRegressions as ReturnType<typeof vi.fn>).mockResolvedValue(
        regressionsResponse([]),
      );

      regressionListPage.mount(container, { testsuite: 'nts' });

      await vi.waitFor(() => {
        expect(container.textContent).toContain('No regressions found.');
      });
    });
  });

  // ---------------------------------------------------------------
  // 2. State filter chips
  // ---------------------------------------------------------------

  describe('state filter chips', () => {
    it('renders all 5 state chips', () => {
      regressionListPage.mount(container, { testsuite: 'nts' });

      const chips = container.querySelectorAll('.state-chip');
      expect(chips.length).toBe(5);
    });

    it('clicking a chip toggles the active class and reloads', async () => {
      regressionListPage.mount(container, { testsuite: 'nts' });

      // Wait for initial load
      await vi.waitFor(() => {
        expect(container.querySelector('tbody')).toBeTruthy();
      });

      vi.clearAllMocks();
      (getRegressions as ReturnType<typeof vi.fn>).mockResolvedValue(
        regressionsResponse(mockRegressions),
      );

      (container.querySelectorAll('.state-chip')[0] as HTMLElement).click();

      // Re-query because renderStateChips replaces children
      const chipsAfterClick = container.querySelectorAll('.state-chip');
      expect(chipsAfterClick[0].classList.contains('state-chip-active')).toBe(true);
      expect(getRegressions).toHaveBeenCalledWith(
        'nts',
        expect.objectContaining({ state: ['detected'] }),
        expect.any(AbortSignal),
      );
    });

    it('clicking an active chip deselects it', async () => {
      await mountAndWait();

      // Click to activate
      (container.querySelectorAll('.state-chip')[0] as HTMLElement).click();
      // Re-query: renderStateChips replaces children
      expect(container.querySelectorAll('.state-chip')[0].classList.contains('state-chip-active')).toBe(true);

      vi.clearAllMocks();
      (getRegressions as ReturnType<typeof vi.fn>).mockResolvedValue(
        regressionsResponse(mockRegressions),
      );

      // Click again to deactivate
      (container.querySelectorAll('.state-chip')[0] as HTMLElement).click();

      expect(container.querySelectorAll('.state-chip')[0].classList.contains('state-chip-active')).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // 3. Title search (debounced client-side filter)
  // ---------------------------------------------------------------

  describe('title search', () => {
    it('filters rows client-side after 300ms debounce', async () => {
      vi.useFakeTimers();
      try {
        regressionListPage.mount(container, { testsuite: 'nts' });

        // Flush the getRegressions promise
        await vi.waitFor(() => {
          expect(container.querySelector('tbody')).toBeTruthy();
        });

        const titleInput = container.querySelector('.title-search-input') as HTMLInputElement;
        titleInput.value = 'compile';
        titleInput.dispatchEvent(new Event('input'));

        // Before debounce fires, still shows all rows
        expect(container.querySelectorAll('tbody tr').length).toBe(2);

        // Advance past debounce
        vi.advanceTimersByTime(300);

        await vi.waitFor(() => {
          const rows = container.querySelectorAll('tbody tr');
          expect(rows.length).toBe(1);
          expect(container.textContent).toContain('compile_time regression on x86');
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ---------------------------------------------------------------
  // 4. Pagination
  // ---------------------------------------------------------------

  describe('pagination', () => {
    it('Previous disabled and Next enabled when nextCursor exists', async () => {
      (getRegressions as ReturnType<typeof vi.fn>).mockResolvedValue(
        regressionsResponse(mockRegressions, 'cursor-page-2'),
      );

      regressionListPage.mount(container, { testsuite: 'nts' });

      await vi.waitFor(() => {
        const buttons = container.querySelectorAll('.pagination-btn');
        const prevBtn = Array.from(buttons).find(b => b.textContent?.includes('Previous')) as HTMLButtonElement | undefined;
        const nextBtn = Array.from(buttons).find(b => b.textContent?.includes('Next')) as HTMLButtonElement | undefined;
        expect(prevBtn?.disabled).toBe(true);
        expect(nextBtn).toBeTruthy();
        expect(nextBtn!.disabled).toBe(false);
      });
    });

    it('clicking Next passes cursor to getRegressions', async () => {
      (getRegressions as ReturnType<typeof vi.fn>).mockResolvedValue(
        regressionsResponse(mockRegressions, 'cursor-page-2'),
      );

      regressionListPage.mount(container, { testsuite: 'nts' });

      await vi.waitFor(() => {
        const nextBtn = Array.from(container.querySelectorAll('.pagination-btn'))
          .find(b => b.textContent?.includes('Next')) as HTMLButtonElement;
        expect(nextBtn).toBeTruthy();
      });

      vi.clearAllMocks();
      (getRegressions as ReturnType<typeof vi.fn>).mockResolvedValue(
        regressionsResponse([], null),
      );

      const nextBtn = Array.from(container.querySelectorAll('.pagination-btn'))
        .find(b => b.textContent?.includes('Next')) as HTMLButtonElement;
      nextBtn.click();

      expect(getRegressions).toHaveBeenCalledWith(
        'nts',
        expect.objectContaining({ cursor: 'cursor-page-2' }),
        expect.any(AbortSignal),
      );
    });

    it('Previous enabled on second page, Next disabled when no more', async () => {
      (getRegressions as ReturnType<typeof vi.fn>).mockResolvedValue(
        regressionsResponse(mockRegressions, 'cursor-page-2'),
      );

      regressionListPage.mount(container, { testsuite: 'nts' });

      await vi.waitFor(() => {
        expect(Array.from(container.querySelectorAll('.pagination-btn'))
          .find(b => b.textContent?.includes('Next'))).toBeTruthy();
      });

      // Navigate to page 2 (no more pages)
      (getRegressions as ReturnType<typeof vi.fn>).mockResolvedValue(
        regressionsResponse(mockRegressions, null),
      );

      const nextBtn = Array.from(container.querySelectorAll('.pagination-btn'))
        .find(b => b.textContent?.includes('Next')) as HTMLButtonElement;
      nextBtn.click();

      await vi.waitFor(() => {
        const buttons = container.querySelectorAll('.pagination-btn');
        const prevBtn2 = Array.from(buttons).find(b => b.textContent?.includes('Previous')) as HTMLButtonElement;
        const nextBtn2 = Array.from(buttons).find(b => b.textContent?.includes('Next')) as HTMLButtonElement;
        expect(prevBtn2?.disabled).toBe(false);
        expect(nextBtn2?.disabled).toBe(true);
      });
    });
  });

  // ---------------------------------------------------------------
  // 5. Auth gating
  // ---------------------------------------------------------------

  describe('auth gating', () => {
    it('hides create button and delete column when getToken returns null', async () => {
      (getToken as ReturnType<typeof vi.fn>).mockReturnValue(null);

      await mountAndWait();

      // No "New Regression" button
      const newBtn = Array.from(container.querySelectorAll('button'))
        .find(b => b.textContent === 'New Regression');
      expect(newBtn).toBeUndefined();

      // No delete buttons in rows
      expect(container.querySelectorAll('.row-delete-btn').length).toBe(0);
    });

    it('shows create button and delete column when getToken returns string', async () => {
      (getToken as ReturnType<typeof vi.fn>).mockReturnValue('test-token');

      await mountAndWait();

      // "New Regression" button present
      const newBtn = Array.from(container.querySelectorAll('button'))
        .find(b => b.textContent === 'New Regression');
      expect(newBtn).toBeTruthy();

      // Delete buttons in rows
      expect(container.querySelectorAll('.row-delete-btn').length).toBe(2);
    });
  });

  // ---------------------------------------------------------------
  // 6. Create form
  // ---------------------------------------------------------------

  describe('create form', () => {
    it('toggles form visibility on New Regression click', async () => {
      await mountAndWait();

      const formContainer = container.querySelector('.create-form-container') as HTMLElement;
      expect(formContainer.style.display).toBe('none');

      const newBtn = Array.from(container.querySelectorAll('button'))
        .find(b => b.textContent === 'New Regression') as HTMLElement;
      newBtn.click();
      expect(formContainer.style.display).toBe('');

      // Click cancel to hide again
      const cancelBtn = Array.from(formContainer.querySelectorAll('button'))
        .find(b => b.textContent === 'Cancel') as HTMLElement;
      cancelBtn.click();
      expect(formContainer.style.display).toBe('none');
    });

    it('submit calls createRegression and navigates on success', async () => {
      const createdRegression = {
        uuid: 'cccc1111-2222-3333-4444-555555555555',
        title: 'New reg',
        bug: null,
        notes: null,
        state: 'detected' as const,
        commit: null,
        indicators: [],
      };
      (createRegression as ReturnType<typeof vi.fn>).mockResolvedValue(createdRegression);

      await mountAndWait();

      // Open form
      const newBtn = Array.from(container.querySelectorAll('button'))
        .find(b => b.textContent === 'New Regression') as HTMLElement;
      newBtn.click();

      const formContainer = container.querySelector('.create-form-container')!;
      const titleInput = formContainer.querySelector('input[type="text"]') as HTMLInputElement;
      titleInput.value = 'New reg';

      const createBtn = Array.from(formContainer.querySelectorAll('button'))
        .find(b => b.textContent === 'Create') as HTMLElement;
      createBtn.click();

      await vi.waitFor(() => {
        expect(createRegression).toHaveBeenCalledWith(
          'nts',
          expect.objectContaining({ title: 'New reg', state: 'detected' }),
          expect.any(AbortSignal),
        );
        expect(navigate).toHaveBeenCalledWith(
          `/regressions/${encodeURIComponent(createdRegression.uuid)}`,
        );
      });
    });

    it('shows error on createRegression failure', async () => {
      (createRegression as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('403'));

      await mountAndWait();

      // Open form
      const newBtn = Array.from(container.querySelectorAll('button'))
        .find(b => b.textContent === 'New Regression') as HTMLElement;
      newBtn.click();

      const formContainer = container.querySelector('.create-form-container')!;
      const createBtn = Array.from(formContainer.querySelectorAll('button'))
        .find(b => b.textContent === 'Create') as HTMLElement;
      createBtn.click();

      await vi.waitFor(() => {
        expect(authErrorMessage).toHaveBeenCalled();
        const error = formContainer.querySelector('.error-banner');
        expect(error).toBeTruthy();
      });
    });
  });

  // ---------------------------------------------------------------
  // 7. Delete
  // ---------------------------------------------------------------

  describe('delete', () => {
    it('calls deleteRegression when window.confirm returns true', async () => {
      (deleteRegression as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      regressionListPage.mount(container, { testsuite: 'nts' });

      await vi.waitFor(() => {
        expect(container.querySelectorAll('.row-delete-btn').length).toBe(2);
      });

      (container.querySelector('.row-delete-btn') as HTMLElement).click();

      await vi.waitFor(() => {
        expect(window.confirm).toHaveBeenCalled();
        expect(deleteRegression).toHaveBeenCalledWith(
          'nts',
          mockRegressions[0].uuid,
          expect.any(AbortSignal),
        );
      });
    });

    it('does not call deleteRegression when window.confirm returns false', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);

      regressionListPage.mount(container, { testsuite: 'nts' });

      await vi.waitFor(() => {
        expect(container.querySelectorAll('.row-delete-btn').length).toBe(2);
      });

      (container.querySelector('.row-delete-btn') as HTMLElement).click();

      expect(window.confirm).toHaveBeenCalled();
      expect(deleteRegression).not.toHaveBeenCalled();
    });

    it('shows error when deleteRegression fails', async () => {
      (deleteRegression as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Server error'));
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      regressionListPage.mount(container, { testsuite: 'nts' });

      await vi.waitFor(() => {
        expect(container.querySelectorAll('.row-delete-btn').length).toBe(2);
      });

      (container.querySelector('.row-delete-btn') as HTMLElement).click();

      await vi.waitFor(() => {
        expect(authErrorMessage).toHaveBeenCalled();
        expect(container.querySelector('.error-banner')).toBeTruthy();
      });
    });
  });

  // ---------------------------------------------------------------
  // 8. Error handling
  // ---------------------------------------------------------------

  describe('error handling', () => {
    it('shows error banner when getRegressions rejects', async () => {
      (getRegressions as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Server error'));

      regressionListPage.mount(container, { testsuite: 'nts' });

      await vi.waitFor(() => {
        const banner = container.querySelector('.error-banner');
        expect(banner).toBeTruthy();
        expect(banner!.textContent).toContain('Failed to load regressions');
      });
    });

    it('shows error when getFields rejects', async () => {
      (getFields as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Fail'));

      regressionListPage.mount(container, { testsuite: 'nts' });

      await vi.waitFor(() => {
        expect(container.textContent).toContain('Failed to load metrics');
      });
    });

    it('suppresses AbortError from getRegressions', async () => {
      const abortError = new DOMException('Aborted', 'AbortError');
      (getRegressions as ReturnType<typeof vi.fn>).mockRejectedValue(abortError);

      regressionListPage.mount(container, { testsuite: 'nts' });

      // Wait for the rejected promise to settle
      await vi.waitFor(() => {
        // Verify no error banner appeared (AbortError is suppressed)
        expect(container.querySelector('.error-banner')).toBeFalsy();
      });
    });
  });

  // ---------------------------------------------------------------
  // 9. Unmount
  // ---------------------------------------------------------------

  describe('unmount', () => {
    it('does not throw', () => {
      (getRegressions as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
      (getFields as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

      regressionListPage.mount(container, { testsuite: 'nts' });
      expect(() => regressionListPage.unmount!()).not.toThrow();
    });
  });
});
