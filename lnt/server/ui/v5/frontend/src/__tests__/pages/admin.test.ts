// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the API module
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    getApiKeys: vi.fn(),
    createApiKey: vi.fn(),
    revokeApiKey: vi.fn(),
    getTestSuiteInfo: vi.fn(),
    createTestSuite: vi.fn(),
    deleteTestSuite: vi.fn(),
  };
});

// Mock Plotly (may be loaded by transitive imports)
(globalThis as unknown as Record<string, unknown>).Plotly = {
  newPlot: vi.fn(),
  react: vi.fn(),
  purge: vi.fn(),
  Fx: { hover: vi.fn(), unhover: vi.fn() },
};

import { getApiKeys, createApiKey, revokeApiKey, getTestSuiteInfo, createTestSuite, deleteTestSuite, ApiError } from '../../api';
import { adminPage } from '../../pages/admin';
import type { APIKeyItem, TestSuiteInfo } from '../../types';

const mockKeys: APIKeyItem[] = [
  {
    prefix: 'abc123',
    name: 'Test Key',
    scope: 'admin',
    created_at: '2026-01-01T00:00:00Z',
    last_used_at: null,
    is_active: true,
  },
  {
    prefix: 'def456',
    name: 'Revoked Key',
    scope: 'read',
    created_at: '2025-06-01T00:00:00Z',
    last_used_at: '2025-12-01T00:00:00Z',
    is_active: false,
  },
];

const mockSuiteInfo: TestSuiteInfo = {
  name: 'nts',
  schema: {
    metrics: [
      { name: 'exec_time', type: 'Real', display_name: 'Execution Time', unit: 's', unit_abbrev: 's', bigger_is_better: false },
    ],
    order_fields: [{ name: 'rev', type: 'String' }],
    machine_fields: [{ name: 'hostname', type: 'String' }],
    run_fields: [],
  },
};

describe('adminPage', () => {
  let container: HTMLElement;
  let appRoot: HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');

    // Set up the #v5-app element with data-testsuites for the admin page to read
    appRoot = document.createElement('div');
    appRoot.id = 'v5-app';
    appRoot.setAttribute('data-testsuites', JSON.stringify(['nts', 'test-suite-2']));
    document.body.append(appRoot);

    (getApiKeys as ReturnType<typeof vi.fn>).mockResolvedValue(mockKeys);
    (getTestSuiteInfo as ReturnType<typeof vi.fn>).mockResolvedValue(mockSuiteInfo);
    (createApiKey as ReturnType<typeof vi.fn>).mockResolvedValue({
      key: 'raw-token-value',
      prefix: 'new123',
      scope: 'read',
    });
    (revokeApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (createTestSuite as ReturnType<typeof vi.fn>).mockResolvedValue(mockSuiteInfo);
    (deleteTestSuite as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  afterEach(() => {
    appRoot.remove();
  });

  it('renders tab bar with API Keys, Test Suites, and Create Suite tabs', () => {
    adminPage.mount(container, { testsuite: '' });

    const tabs = container.querySelectorAll('.admin-tab');
    expect(tabs).toHaveLength(3);
    expect(tabs[0].textContent).toBe('API Keys');
    expect(tabs[1].textContent).toBe('Test Suites');
    expect(tabs[2].textContent).toBe('Create Suite');
  });

  it('loads and displays API keys table', async () => {
    adminPage.mount(container, { testsuite: '' });

    await vi.waitFor(() => {
      expect(getApiKeys).toHaveBeenCalled();
      const rows = container.querySelectorAll('tbody tr');
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('shows auth error for 401/403', async () => {
    (getApiKeys as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(403, 'API 403: forbidden'));

    adminPage.mount(container, { testsuite: '' });

    await vi.waitFor(() => {
      const error = container.querySelector('.error-banner');
      expect(error).toBeTruthy();
      expect(error!.textContent).toContain('Permission denied');
    });
  });

  it('shows create key form', async () => {
    adminPage.mount(container, { testsuite: '' });

    await vi.waitFor(() => {
      expect(container.querySelector('.admin-create-form')).toBeTruthy();
      expect(container.querySelector('.admin-input')).toBeTruthy();
    });
  });

  it('Test Suites tab shows suite selector and loads first suite', async () => {
    adminPage.mount(container, { testsuite: '' });

    await vi.waitFor(() => {
      expect(container.querySelector('.admin-create-form')).toBeTruthy();
    });

    // Click Test Suites tab
    const tabs = container.querySelectorAll('.admin-tab');
    (tabs[1] as HTMLElement).click();

    await vi.waitFor(() => {
      // Should have a suite selector with both suites
      const select = container.querySelector('.admin-select') as HTMLSelectElement;
      expect(select).toBeTruthy();
      expect(select.options).toHaveLength(2);
      expect(select.options[0].value).toBe('nts');
      expect(select.options[1].value).toBe('test-suite-2');
      // Should have loaded the first suite
      expect(getTestSuiteInfo).toHaveBeenCalledWith('nts', expect.any(AbortSignal));
      expect(container.textContent).toContain('Test Suite: nts');
    });
  });

  it('Test Suites tab shows metrics and field tables', async () => {
    adminPage.mount(container, { testsuite: '' });

    // Wait for API Keys tab to load first
    await vi.waitFor(() => {
      expect(container.querySelector('.admin-create-form')).toBeTruthy();
    });

    // Switch to Test Suites tab
    const tabs = container.querySelectorAll('.admin-tab');
    (tabs[1] as HTMLElement).click();

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Metrics');
      expect(container.textContent).toContain('Execution Time');
      expect(container.textContent).toContain('Order Fields');
      expect(container.textContent).toContain('rev');
      expect(container.textContent).toContain('Machine Fields');
      expect(container.textContent).toContain('hostname');
    });
  });

  it('revoke button only shown for active keys', async () => {
    adminPage.mount(container, { testsuite: '' });

    await vi.waitFor(() => {
      const buttons = container.querySelectorAll('.admin-btn-danger');
      expect(buttons).toHaveLength(1);
    });
  });

  it('Create Suite tab shows name input and JSON textarea', async () => {
    adminPage.mount(container, { testsuite: '' });

    await vi.waitFor(() => {
      expect(container.querySelectorAll('.admin-tab')).toHaveLength(3);
    });

    const tabs = container.querySelectorAll('.admin-tab');
    (tabs[2] as HTMLElement).click();

    const inputs = container.querySelectorAll('.admin-input');
    expect(inputs.length).toBeGreaterThanOrEqual(1);
    expect(container.querySelector('.admin-textarea')).toBeTruthy();
  });

  it('Test Suites tab shows delete button with confirmation', async () => {
    adminPage.mount(container, { testsuite: '' });

    await vi.waitFor(() => {
      expect(container.querySelector('.admin-create-form')).toBeTruthy();
    });

    const tabs = container.querySelectorAll('.admin-tab');
    (tabs[1] as HTMLElement).click();

    await vi.waitFor(() => {
      expect(container.querySelector('.admin-delete-section')).toBeTruthy();
    });

    // Click delete toggle to show confirmation
    const deleteToggle = container.querySelector('.admin-delete-section > .admin-btn-danger') as HTMLButtonElement;
    deleteToggle.click();

    // Confirmation panel should be visible with warning and disabled button
    const confirmPanel = container.querySelector('.admin-delete-confirm') as HTMLElement;
    expect(confirmPanel.style.display).not.toBe('none');
    expect(confirmPanel.textContent).toContain('permanently destroy');

    const confirmBtn = confirmPanel.querySelector('.admin-btn-danger') as HTMLButtonElement;
    expect(confirmBtn).toBeTruthy();
    expect(confirmBtn.disabled).toBe(true);
  });

  it('delete confirm button enables only when name matches', async () => {
    adminPage.mount(container, { testsuite: '' });

    await vi.waitFor(() => {
      expect(container.querySelector('.admin-create-form')).toBeTruthy();
    });

    const tabs = container.querySelectorAll('.admin-tab');
    (tabs[1] as HTMLElement).click();

    await vi.waitFor(() => {
      expect(container.querySelector('.admin-delete-section')).toBeTruthy();
    });

    // Show confirmation
    const deleteToggle = container.querySelector('.admin-delete-section > .admin-btn-danger') as HTMLButtonElement;
    deleteToggle.click();

    const confirmPanel = container.querySelector('.admin-delete-confirm') as HTMLElement;
    const confirmInput = confirmPanel.querySelector('.admin-input') as HTMLInputElement;
    const confirmBtn = confirmPanel.querySelector('.admin-btn-danger') as HTMLButtonElement;

    // Type wrong name
    confirmInput.value = 'wrong';
    confirmInput.dispatchEvent(new Event('input'));
    expect(confirmBtn.disabled).toBe(true);

    // Type correct name (first suite = 'nts')
    confirmInput.value = 'nts';
    confirmInput.dispatchEvent(new Event('input'));
    expect(confirmBtn.disabled).toBe(false);
  });
});
