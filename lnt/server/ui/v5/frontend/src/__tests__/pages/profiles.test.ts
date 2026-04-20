// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock API
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    getRun: vi.fn(),
    getRuns: vi.fn(),
    getCommits: vi.fn(),
    getMachines: vi.fn(),
    getProfilesForRun: vi.fn(),
    getProfileMetadata: vi.fn(),
    getProfileFunctions: vi.fn(),
    getProfileFunctionDetail: vi.fn(),
  };
});

// Mock router
vi.mock('../../router', () => ({
  navigate: vi.fn(),
  getTestsuites: vi.fn(() => ['nts', 'test-suite']),
  getBasePath: vi.fn(() => '/v5'),
  getUrlBase: vi.fn(() => ''),
}));

// Mock machine combobox
vi.mock('../../components/machine-combobox', () => ({
  renderMachineCombobox: vi.fn((_container: HTMLElement, _opts: unknown) => ({
    destroy: vi.fn(),
    getValue: vi.fn(() => ''),
    clear: vi.fn(),
  })),
}));

// Mock combobox (commit picker)
vi.mock('../../combobox', () => ({
  createCommitPicker: vi.fn((_opts: unknown) => {
    const input = document.createElement('input');
    return {
      element: document.createElement('div'),
      input,
      destroy: vi.fn(),
    };
  }),
  fetchMachineCommitSet: vi.fn(async () => new Set<string>()),
}));

import { profilesPage } from '../../pages/profiles';
import {
  getRun, getRuns, getCommits,
  getProfilesForRun, getProfileMetadata, getProfileFunctions,
} from '../../api';
import type { RunInfo, RunDetail, ProfileListItem, ProfileMetadata } from '../../types';

let container: HTMLElement;
const savedLocation = window.location;

function setUrl(search: string): void {
  delete (window as unknown as Record<string, unknown>).location;
  (window as unknown as Record<string, unknown>).location = {
    ...savedLocation,
    search,
    pathname: '/v5/profiles',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  setUrl('');
  vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});

  // Default mocks
  (getCommits as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (getRuns as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (getProfilesForRun as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

afterEach(() => {
  profilesPage.unmount?.();
  (window as unknown as Record<string, unknown>).location = savedLocation;
});

describe('profilesPage — mount', () => {
  it('renders page header', () => {
    profilesPage.mount(container, { testsuite: '' });

    expect(container.querySelector('.page-header')?.textContent).toBe('Profiles');
  });

  it('renders per-side suite selectors populated from getTestsuites()', () => {
    profilesPage.mount(container, { testsuite: '' });

    const selects = container.querySelectorAll('.profile-side select') as NodeListOf<HTMLSelectElement>;
    expect(selects).toHaveLength(2);  // one per side
    for (const select of selects) {
      const options = Array.from(select.options).map(o => o.value);
      expect(options).toContain('nts');
      expect(options).toContain('test-suite');
    }
  });

  it('renders A/B picker with Side A and Side B headings', () => {
    profilesPage.mount(container, { testsuite: '' });

    const headings = container.querySelectorAll('.profile-side h3');
    expect(headings).toHaveLength(2);
    expect(headings[0].textContent).toBe('Side A');
    expect(headings[1].textContent).toBe('Side B');
  });

  it('shows "Select a suite first" when no suite is selected', () => {
    profilesPage.mount(container, { testsuite: '' });

    const messages = container.querySelectorAll('.no-results');
    const texts = Array.from(messages).map(m => m.textContent);
    expect(texts).toContain('Select a suite first.');
  });
});

describe('profilesPage — URL params', () => {
  it('pre-selects suite from URL param', async () => {
    setUrl('?suite_a=nts');

    profilesPage.mount(container, { testsuite: '' });

    await vi.waitFor(() => {
      const select = container.querySelector('select') as HTMLSelectElement;
      expect(select.value).toBe('nts');
    });
  });

  it('restores side A from run_a and test_a URL params', async () => {
    setUrl('?suite_a=nts&run_a=run-uuid-1&test_a=bench/foo');

    const runDetail: RunDetail = {
      uuid: 'run-uuid-1',
      machine: 'machine-1',
      commit: 'abc123',
      submitted_at: '2025-01-01T00:00:00Z',
      run_parameters: {},
    };
    const runs: RunInfo[] = [
      { uuid: 'run-uuid-1', machine: 'machine-1', commit: 'abc123', submitted_at: '2025-01-01T00:00:00Z' },
    ];
    const profiles: ProfileListItem[] = [
      { test: 'bench/foo', uuid: 'prof-uuid-1' },
    ];
    const metadata: ProfileMetadata = {
      uuid: 'prof-uuid-1',
      test: 'bench/foo',
      run_uuid: 'run-uuid-1',
      counters: { cycles: 1000 },
      disassembly_format: 'raw',
    };

    (getRun as ReturnType<typeof vi.fn>).mockResolvedValue(runDetail);
    (getRuns as ReturnType<typeof vi.fn>).mockResolvedValue(runs);
    (getProfilesForRun as ReturnType<typeof vi.fn>).mockResolvedValue(profiles);
    (getProfileMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(metadata);
    (getProfileFunctions as ReturnType<typeof vi.fn>).mockResolvedValue({ functions: [] });
    (getCommits as ReturnType<typeof vi.fn>).mockResolvedValue([
      { commit: 'abc123', ordinal: null, fields: {} },
    ]);

    profilesPage.mount(container, { testsuite: '' });

    await vi.waitFor(() => {
      expect(getRun).toHaveBeenCalledWith('nts', 'run-uuid-1', expect.anything());
      expect(getProfilesForRun).toHaveBeenCalledWith('nts', 'run-uuid-1', expect.anything());
      expect(getProfileMetadata).toHaveBeenCalledWith('nts', 'prof-uuid-1', expect.anything());
    });
  });
});

describe('profilesPage — URL sync', () => {
  it('updates URL via replaceState on suite change', async () => {
    profilesPage.mount(container, { testsuite: '' });

    // Suite selectors are per-side, inside .profile-side containers
    const suiteSelects = container.querySelectorAll('.profile-side select') as NodeListOf<HTMLSelectElement>;
    expect(suiteSelects.length).toBeGreaterThanOrEqual(2);
    suiteSelects[0].value = 'nts';
    suiteSelects[0].dispatchEvent(new Event('change'));

    await vi.waitFor(() => {
      expect(window.history.replaceState).toHaveBeenCalled();
      const calls = (window.history.replaceState as ReturnType<typeof vi.fn>).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall?.[2]).toContain('suite_a=nts');
    });
  });

  it('handles C++ mangled test name in URL params', async () => {
    const mangledTest = 'SingleSource/Benchmarks/Dhrystone/dry';
    setUrl(`?suite_a=nts&run_a=run-uuid-1&test_a=${encodeURIComponent(mangledTest)}`);

    const runDetail = {
      uuid: 'run-uuid-1', machine: 'machine-1', commit: 'abc123',
      submitted_at: '2025-01-01T00:00:00Z', run_parameters: {},
    };
    (getRun as ReturnType<typeof vi.fn>).mockResolvedValue(runDetail);
    (getRuns as ReturnType<typeof vi.fn>).mockResolvedValue([
      { uuid: 'run-uuid-1', machine: 'machine-1', commit: 'abc123', submitted_at: '2025-01-01T00:00:00Z' },
    ]);
    (getProfilesForRun as ReturnType<typeof vi.fn>).mockResolvedValue([
      { test: mangledTest, uuid: 'prof-mangled' },
    ]);
    (getProfileMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
      uuid: 'prof-mangled', test: mangledTest, run_uuid: 'run-uuid-1',
      counters: { cycles: 4523891, 'branch-misses': 18742, 'cache-misses': 3201, instructions: 12847623 },
      disassembly_format: 'llvm-objdump',
    });
    (getProfileFunctions as ReturnType<typeof vi.fn>).mockResolvedValue({
      functions: [
        { name: '_ZN5llvm12SelectionDAG15computeKnownBitsENS_7SDValueERKNS_3APEE', counters: { cycles: 34.2 }, length: 187 },
        { name: '_ZNSt6vectorIiSaIiEE9push_backEOi', counters: { cycles: 6.1 }, length: 42 },
      ],
    });
    (getCommits as ReturnType<typeof vi.fn>).mockResolvedValue([
      { commit: 'abc123', ordinal: null, fields: {} },
    ]);

    profilesPage.mount(container, { testsuite: '' });

    await vi.waitFor(() => {
      expect(getProfilesForRun).toHaveBeenCalledWith('nts', 'run-uuid-1', expect.anything());
      expect(getProfileMetadata).toHaveBeenCalledWith('nts', 'prof-mangled', expect.anything());
    });
  });
});

describe('profilesPage — unmount', () => {
  it('unmount cleans up without errors', () => {
    profilesPage.mount(container, { testsuite: '' });
    expect(() => profilesPage.unmount?.()).not.toThrow();
  });
});
