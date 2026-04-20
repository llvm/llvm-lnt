import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setApiBase, getFields, getCommits, getMachines, getRuns, getSamples,
  getMachine, getMachineRuns, deleteMachine, getRun, deleteRun, getCommit, getRunsByCommit,
  getFieldChanges, searchCommits, updateCommit, fetchTrends,
  fetchOneCursorPage, apiUrl, ApiError, authErrorMessage,
  resolveCommits, getTestSuiteInfoCached,
} from '../api';
import type {
  CursorPaginated, FieldInfo, MachineInfo, MachineRunInfo, OffsetPaginated,
  CommitSummary, CommitDetail, RunInfo, RunDetail, SampleInfo, FieldChangeInfo,
  QueryDataPoint,
} from '../types';

// ---------------------------------------------------------------------------
// Helpers to build mock paginated responses
// ---------------------------------------------------------------------------

function cursorPage<T>(items: T[], next: string | null = null): CursorPaginated<T> {
  return { items, cursor: { next, previous: null } };
}

function offsetPage<T>(items: T[], total: number): OffsetPaginated<T> {
  return { items, total, cursor: { next: null, previous: null } };
}

// ---------------------------------------------------------------------------
// Global mocks – fetch, localStorage, window.location
// ---------------------------------------------------------------------------

let mockFetch: ReturnType<typeof vi.fn>;
let storedToken: string | null;

function mockResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    headers: new Headers(),
    redirected: false,
    type: 'basic' as ResponseType,
    url: '',
    clone: () => mockResponse(body, status, statusText),
    body: null,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
    bytes: () => Promise.resolve(new Uint8Array()),
  } as Response;
}

beforeEach(() => {
  storedToken = null;

  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);

  vi.stubGlobal('localStorage', {
    getItem: (key: string) => key === 'lnt_v5_token' ? storedToken : null,
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: () => null,
  });

  // api.ts references `window.location.origin` — we need the `window` global
  // to exist in Node. stubGlobal('window', ...) creates globalThis.window.
  vi.stubGlobal('window', {
    location: { origin: 'http://localhost:3000' },
  });

  // Reset apiBase before each test
  setApiBase('');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ===========================================================================
// setApiBase
// ===========================================================================

describe('setApiBase', () => {
  it('sets base URL used in subsequent requests', async () => {
    setApiBase('/lnt');
    mockFetch.mockResolvedValueOnce(mockResponse({ schema: { metrics: [] } }));

    await getFields('nts');

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/lnt/api/v5/test-suites/nts');
  });

  it('strips trailing slash from base', async () => {
    setApiBase('/lnt/');
    mockFetch.mockResolvedValueOnce(mockResponse({ schema: { metrics: [] } }));

    await getFields('nts');

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/lnt/api/v5/test-suites/nts');
  });

  it('handles empty string base', async () => {
    setApiBase('');
    mockFetch.mockResolvedValueOnce(mockResponse({ schema: { metrics: [] } }));

    await getFields('nts');

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v5/test-suites/nts');
  });
});

// ===========================================================================
// Auth header injection
// ===========================================================================

describe('auth header injection', () => {
  it('includes Bearer token when localStorage has a token', async () => {
    storedToken = 'my-secret-token';
    mockFetch.mockResolvedValueOnce(mockResponse({ schema: { metrics: [] } }));

    await getFields('nts');

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['Authorization']).toBe('Bearer my-secret-token');
    expect(headers['Accept']).toBe('application/json');
  });

  it('omits Authorization header when no token is stored', async () => {
    storedToken = null;
    mockFetch.mockResolvedValueOnce(mockResponse({ schema: { metrics: [] } }));

    await getFields('nts');

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Accept']).toBe('application/json');
  });
});

// ===========================================================================
// Error formatting
// ===========================================================================

describe('error formatting', () => {
  it('throws an Error with status and body text on non-OK response', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse('{"error":"not found"}', 404, 'Not Found')
    );

    await expect(getFields('nts')).rejects.toThrow('API 404: {"error":"not found"}');
  });

  it('falls back to statusText when body text is empty', async () => {
    const resp = {
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.resolve(''),
      json: () => Promise.reject(new Error('no json')),
      headers: new Headers(),
      redirected: false,
      type: 'basic' as ResponseType,
      url: '',
      clone: () => resp,
      body: null,
      bodyUsed: false,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      blob: () => Promise.resolve(new Blob()),
      formData: () => Promise.resolve(new FormData()),
      bytes: () => Promise.resolve(new Uint8Array()),
    } as Response;

    mockFetch.mockResolvedValueOnce(resp);

    await expect(getFields('nts')).rejects.toThrow('API 500: Internal Server Error');
  });

  it('falls back to statusText when resp.text() rejects', async () => {
    const resp = {
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      text: () => Promise.reject(new Error('stream error')),
      json: () => Promise.reject(new Error('no json')),
      headers: new Headers(),
      redirected: false,
      type: 'basic' as ResponseType,
      url: '',
      clone: () => resp,
      body: null,
      bodyUsed: false,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      blob: () => Promise.resolve(new Blob()),
      formData: () => Promise.resolve(new FormData()),
      bytes: () => Promise.resolve(new Uint8Array()),
    } as Response;

    mockFetch.mockResolvedValueOnce(resp);

    await expect(getFields('nts')).rejects.toThrow('API 502: Bad Gateway');
  });
});

// ===========================================================================
// AbortSignal
// ===========================================================================

describe('AbortSignal support', () => {
  it('passes signal to fetch for non-paginated requests', async () => {
    const controller = new AbortController();
    mockFetch.mockResolvedValueOnce(mockResponse({ schema: { metrics: [] } }));

    await getFields('nts', controller.signal);

    expect(mockFetch.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it('passes signal to every fetch call in paginated requests', async () => {
    const controller = new AbortController();
    mockFetch
      .mockResolvedValueOnce(mockResponse(cursorPage([{ commit: '100', ordinal: 1, fields: {} }], 'cursor1')))
      .mockResolvedValueOnce(mockResponse(cursorPage([{ commit: '200', ordinal: 2, fields: {} }])));

    await getCommits('nts', { signal: controller.signal });

    expect(mockFetch.mock.calls).toHaveLength(2);
    expect(mockFetch.mock.calls[0][1].signal).toBe(controller.signal);
    expect(mockFetch.mock.calls[1][1].signal).toBe(controller.signal);
  });
});

// ===========================================================================
// Cursor-based pagination loop
// ===========================================================================

describe('cursor-based pagination', () => {
  it('fetches a single page when cursor.next is null', async () => {
    const commit: CommitSummary = { commit: '100', ordinal: 1, fields: {} };
    mockFetch.mockResolvedValueOnce(mockResponse(cursorPage([commit])));

    const result = await getCommits('nts');

    expect(result).toEqual([commit]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fetches multiple pages and concatenates results', async () => {
    const c1: CommitSummary = { commit: '100', ordinal: 1, fields: {} };
    const c2: CommitSummary = { commit: '200', ordinal: 2, fields: {} };
    const c3: CommitSummary = { commit: '300', ordinal: 3, fields: {} };

    mockFetch
      .mockResolvedValueOnce(mockResponse(cursorPage([c1], 'cursor-abc')))
      .mockResolvedValueOnce(mockResponse(cursorPage([c2], 'cursor-def')))
      .mockResolvedValueOnce(mockResponse(cursorPage([c3])));

    const result = await getCommits('nts');

    expect(result).toEqual([c1, c2, c3]);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('passes cursor parameter on subsequent pages', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(cursorPage([{ commit: '1', ordinal: 1, fields: {} }], 'next-page-cursor')))
      .mockResolvedValueOnce(mockResponse(cursorPage([{ commit: '2', ordinal: 2, fields: {} }])));

    await getCommits('nts');

    // First call should have no cursor
    const firstUrl = new URL(mockFetch.mock.calls[0][0]);
    expect(firstUrl.searchParams.has('cursor')).toBe(false);
    expect(firstUrl.searchParams.get('limit')).toBe('500');

    // Second call should include the cursor
    const secondUrl = new URL(mockFetch.mock.calls[1][0]);
    expect(secondUrl.searchParams.get('cursor')).toBe('next-page-cursor');
    expect(secondUrl.searchParams.get('limit')).toBe('500');
  });

  it('calls onProgress callback with running total after each page', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(cursorPage([{ commit: '1', ordinal: 1, fields: {} }, { commit: '2', ordinal: 2, fields: {} }], 'c1')))
      .mockResolvedValueOnce(mockResponse(cursorPage([{ commit: '3', ordinal: 3, fields: {} }])));

    const onProgress = vi.fn();
    await getCommits('nts', { onProgress });

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, 2);
    expect(onProgress).toHaveBeenNthCalledWith(2, 3);
  });

  it('stops paginating when error occurs mid-pagination', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(cursorPage([{ commit: '1', ordinal: 1, fields: {} }], 'c1')))
      .mockResolvedValueOnce(mockResponse('server error', 500, 'Internal Server Error'));

    await expect(getCommits('nts')).rejects.toThrow('API 500');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// getFields
// ===========================================================================

describe('getFields', () => {
  it('returns the metrics array from the test-suite schema', async () => {
    const fields: FieldInfo[] = [
      { name: 'compile_time', type: 'real', display_name: 'Compile Time', unit: 'seconds', unit_abbrev: 's', bigger_is_better: false },
      { name: 'exec_time', type: 'real', display_name: 'Execution Time', unit: 'seconds', unit_abbrev: 's', bigger_is_better: false },
    ];
    mockFetch.mockResolvedValueOnce(mockResponse({ schema: { metrics: fields } }));

    const result = await getFields('nts');

    expect(result).toEqual(fields);
  });

  it('constructs the correct URL', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ schema: { metrics: [] } }));

    await getFields('nts');

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v5/test-suites/nts');
  });

  it('encodes test suite name in URL', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ schema: { metrics: [] } }));

    await getFields('my test suite');

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v5/test-suites/my%20test%20suite');
  });
});

// ===========================================================================
// getCommits
// ===========================================================================

describe('getCommits', () => {
  it('returns all commits across multiple pages', async () => {
    const c1: CommitSummary = { commit: '100', ordinal: 1, fields: {} };
    const c2: CommitSummary = { commit: '200', ordinal: 2, fields: {} };

    mockFetch
      .mockResolvedValueOnce(mockResponse(cursorPage([c1], 'c1')))
      .mockResolvedValueOnce(mockResponse(cursorPage([c2])));

    const result = await getCommits('nts');
    expect(result).toEqual([c1, c2]);
  });

  it('constructs the correct URL with limit=500', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(cursorPage([])));

    await getCommits('nts');

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v5/nts/commits');
    expect(url.searchParams.get('limit')).toBe('500');
  });

  it('passes machine query parameter when provided', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(cursorPage([])));

    await getCommits('nts', { machine: 'clang-x86' });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get('machine')).toBe('clang-x86');
  });

  it('does not include machine param when not provided', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(cursorPage([])));

    await getCommits('nts');

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.has('machine')).toBe(false);
  });
});

// ===========================================================================
// getMachines
// ===========================================================================

describe('getMachines', () => {
  it('returns items and total from offset-paginated response', async () => {
    const machines: MachineInfo[] = [
      { name: 'machine-1', info: { os: 'linux' } },
      { name: 'machine-2', info: { os: 'darwin' } },
    ];
    mockFetch.mockResolvedValueOnce(mockResponse(offsetPage(machines, 42)));

    const result = await getMachines('nts', {});

    expect(result.items).toEqual(machines);
    expect(result.total).toBe(42);
  });

  it('passes namePrefix as name_prefix query param', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(offsetPage([], 0)));

    await getMachines('nts', { namePrefix: 'clang-' });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get('name_prefix')).toBe('clang-');
  });

  it('passes limit query param', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(offsetPage([], 0)));

    await getMachines('nts', { limit: 10 });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it('omits namePrefix and limit when not provided', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(offsetPage([], 0)));

    await getMachines('nts', {});

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.has('name_prefix')).toBe(false);
    expect(url.searchParams.has('limit')).toBe(false);
  });

  it('constructs the correct URL path', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(offsetPage([], 0)));

    await getMachines('nts', {});

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v5/nts/machines');
  });

  it('passes nameContains as name_contains query param', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(offsetPage([], 0)));

    await getMachines('nts', { nameContains: 'clang' });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get('name_contains')).toBe('clang');
  });

  it('passes offset query param', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(offsetPage([], 0)));

    await getMachines('nts', { offset: 25 });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get('offset')).toBe('25');
  });
});

// ===========================================================================
// getRuns
// ===========================================================================

describe('getRuns', () => {
  it('returns all runs across paginated responses', async () => {
    const r1: RunInfo = {
      uuid: 'aaa-111',
      machine: 'machine-1',
      commit: '100',
      submitted_at: '2025-01-01T00:00:00Z',
      run_parameters: {},
    };
    const r2: RunInfo = {
      uuid: 'bbb-222',
      machine: 'machine-1',
      commit: '200',
      submitted_at: null,
      run_parameters: {},
    };

    mockFetch
      .mockResolvedValueOnce(mockResponse(cursorPage([r1], 'next-c')))
      .mockResolvedValueOnce(mockResponse(cursorPage([r2])));

    const result = await getRuns('nts', { machine: 'machine-1' });
    expect(result).toEqual([r1, r2]);
  });

  it('passes machine and commit as query params', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(cursorPage([])));

    await getRuns('nts', { machine: 'machine-1', commit: 'rev100' });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get('machine')).toBe('machine-1');
    expect(url.searchParams.get('commit')).toBe('rev100');
    expect(url.searchParams.get('limit')).toBe('500');
  });

  it('omits commit when not provided', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(cursorPage([])));

    await getRuns('nts', { machine: 'machine-1' });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.has('commit')).toBe(false);
  });

  it('constructs the correct URL path', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(cursorPage([])));

    await getRuns('nts', { machine: 'machine-1' });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v5/nts/runs');
  });
});

// ===========================================================================
// getSamples
// ===========================================================================

describe('getSamples', () => {
  it('returns all samples across paginated responses', async () => {
    const s1: SampleInfo = { test: 'test/a', has_profile: false, metrics: { compile_time: 1.23 } };
    const s2: SampleInfo = { test: 'test/b', has_profile: true, metrics: { compile_time: null } };

    mockFetch
      .mockResolvedValueOnce(mockResponse(cursorPage([s1], 'c1')))
      .mockResolvedValueOnce(mockResponse(cursorPage([s2])));

    const result = await getSamples('nts', 'run-uuid-123');
    expect(result).toEqual([s1, s2]);
  });

  it('constructs URL with encoded run UUID', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(cursorPage([])));

    await getSamples('nts', 'abc-def/special');

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v5/nts/runs/abc-def%2Fspecial/samples');
  });

  it('calls onProgress with running total', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(cursorPage(
        [{ test: 'a', has_profile: false, metrics: {} }, { test: 'b', has_profile: false, metrics: {} }],
        'c1',
      )))
      .mockResolvedValueOnce(mockResponse(cursorPage(
        [{ test: 'c', has_profile: false, metrics: {} }],
      )));

    const onProgress = vi.fn();
    await getSamples('nts', 'run-uuid', undefined, onProgress);

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, 2);
    expect(onProgress).toHaveBeenNthCalledWith(2, 3);
  });

  it('passes signal through paginated requests', async () => {
    const controller = new AbortController();
    mockFetch.mockResolvedValueOnce(mockResponse(cursorPage([])));

    await getSamples('nts', 'run-uuid', controller.signal);

    expect(mockFetch.mock.calls[0][1].signal).toBe(controller.signal);
  });
});

// ===========================================================================
// URL construction – apiUrl encodes test suite names
// ===========================================================================

describe('URL construction', () => {
  it('encodes special characters in test suite name', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ schema: { metrics: [] } }));

    await getFields('nts/special chars');

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v5/test-suites/nts%2Fspecial%20chars');
  });

  it('uses apiBase prefix for all API functions', async () => {
    setApiBase('/myapp');

    // Test each function constructs URLs with the base
    mockFetch.mockResolvedValueOnce(mockResponse({ schema: { metrics: [] } }));
    await getFields('nts');
    expect(new URL(mockFetch.mock.calls[0][0]).pathname).toBe('/myapp/api/v5/test-suites/nts');

    mockFetch.mockResolvedValueOnce(mockResponse(cursorPage([])));
    await getCommits('nts');
    expect(new URL(mockFetch.mock.calls[1][0]).pathname).toBe('/myapp/api/v5/nts/commits');

    mockFetch.mockResolvedValueOnce(mockResponse(offsetPage([], 0)));
    await getMachines('nts', {});
    expect(new URL(mockFetch.mock.calls[2][0]).pathname).toBe('/myapp/api/v5/nts/machines');

    mockFetch.mockResolvedValueOnce(mockResponse(cursorPage([])));
    await getRuns('nts', { machine: 'm' });
    expect(new URL(mockFetch.mock.calls[3][0]).pathname).toBe('/myapp/api/v5/nts/runs');

    mockFetch.mockResolvedValueOnce(mockResponse(cursorPage([])));
    await getSamples('nts', 'uuid-1');
    expect(new URL(mockFetch.mock.calls[4][0]).pathname).toBe('/myapp/api/v5/nts/runs/uuid-1/samples');
  });
});

// ===========================================================================
// fetchJson – query parameter handling
// ===========================================================================

describe('query parameter handling', () => {
  it('omits empty string params', async () => {
    // getRuns with empty commit should not include it
    mockFetch.mockResolvedValueOnce(mockResponse(cursorPage([])));

    await getRuns('nts', { machine: 'machine-1', commit: '' });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get('machine')).toBe('machine-1');
    // commit is '' and should be excluded by the fetchJson params filtering
    // (but actually getRuns conditionally adds commit, so let's test via getMachines)
    expect(url.searchParams.has('commit')).toBe(false);
  });
});

// ===========================================================================
// Phase 2: New API functions
// ===========================================================================

describe('getMachine', () => {
  it('fetches a single machine by name', async () => {
    const machine: MachineInfo = { name: 'clang-x86', info: { os: 'linux' } };
    mockFetch.mockResolvedValueOnce(mockResponse(machine));

    const result = await getMachine('nts', 'clang-x86');

    expect(result).toEqual(machine);
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v5/nts/machines/clang-x86');
  });

  it('encodes machine name in URL', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ name: 'a/b', info: {} }));
    await getMachine('nts', 'a/b');
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v5/nts/machines/a%2Fb');
  });
});

describe('getMachineRuns', () => {
  it('fetches runs for a machine with sort and limit', async () => {
    const page = cursorPage<MachineRunInfo>(
      [{ uuid: 'r1', commit: '100', submitted_at: null }],
      'cursor-2',
    );
    mockFetch.mockResolvedValueOnce(mockResponse(page));

    const result = await getMachineRuns('nts', 'clang-x86', { sort: '-submitted_at', limit: 10 });

    expect(result.items).toHaveLength(1);
    expect(result.cursor.next).toBe('cursor-2');
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v5/nts/machines/clang-x86/runs');
    expect(url.searchParams.get('sort')).toBe('-submitted_at');
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it('passes cursor query param for pagination', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(cursorPage<MachineRunInfo>([], null)));

    await getMachineRuns('nts', 'clang-x86', { cursor: 'abc123' });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get('cursor')).toBe('abc123');
  });
});

describe('deleteMachine', () => {
  it('sends DELETE request to correct URL', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('', 204));

    await deleteMachine('nts', 'clang-x86');

    expect(mockFetch).toHaveBeenCalledOnce();
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v5/nts/machines/clang-x86');
    expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
  });

  it('encodes machine name in URL', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('', 204));

    await deleteMachine('nts', 'machine with spaces');

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v5/nts/machines/machine%20with%20spaces');
  });

  it('sends auth token when set', async () => {
    storedToken = 'my-token';
    mockFetch.mockResolvedValueOnce(mockResponse('', 204));

    await deleteMachine('nts', 'clang-x86');

    expect(mockFetch.mock.calls[0][1].headers['Authorization']).toBe('Bearer my-token');
  });

  it('throws ApiError on 403', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('Forbidden', 403, 'Forbidden'));

    try {
      await deleteMachine('nts', 'clang-x86');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(403);
    }
  });
});

describe('ApiError and authErrorMessage', () => {
  it('authErrorMessage returns permission message for 401', () => {
    expect(authErrorMessage(new ApiError(401, 'Unauthorized'))).toContain('Permission denied');
  });

  it('authErrorMessage returns permission message for 403', () => {
    expect(authErrorMessage(new ApiError(403, 'Forbidden'))).toContain('Permission denied');
  });

  it('authErrorMessage returns generic message for other errors', () => {
    expect(authErrorMessage(new Error('network failure'))).toContain('network failure');
  });

  it('authErrorMessage returns generic message for non-auth ApiError', () => {
    expect(authErrorMessage(new ApiError(500, 'Server error'))).toContain('Server error');
  });
});

describe('getRun', () => {
  it('fetches a single run by UUID', async () => {
    const run: RunDetail = {
      uuid: 'abc-123', machine: 'm1', commit: '100',
      submitted_at: '2025-01-01T00:00:00Z', run_parameters: {},
    };
    mockFetch.mockResolvedValueOnce(mockResponse(run));

    const result = await getRun('nts', 'abc-123');

    expect(result.uuid).toBe('abc-123');
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v5/nts/runs/abc-123');
  });
});

describe('deleteRun', () => {
  it('sends DELETE request to correct URL', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('', 204));

    await deleteRun('nts', 'abc-123');

    expect(mockFetch).toHaveBeenCalledOnce();
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v5/nts/runs/abc-123');
    expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
  });

  it('throws ApiError on 403', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('Forbidden', 403, 'Forbidden'));

    try {
      await deleteRun('nts', 'abc-123');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(403);
    }
  });
});

describe('getCommit', () => {
  it('fetches commit detail with prev/next', async () => {
    const commit: CommitDetail = {
      commit: '100', ordinal: 1, fields: {},
      previous_commit: { commit: '99', ordinal: 0, link: '/api/v5/nts/commits/99' },
      next_commit: null,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(commit));

    const result = await getCommit('nts', '100');

    expect(result.previous_commit).not.toBeNull();
    expect(result.next_commit).toBeNull();
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v5/nts/commits/100');
  });
});

describe('getRunsByCommit', () => {
  it('auto-paginates runs filtered by commit value', async () => {
    const run: RunInfo = {
      uuid: 'r1', machine: 'm1', commit: '100',
      submitted_at: null, run_parameters: {},
    };
    mockFetch.mockResolvedValueOnce(mockResponse(cursorPage([run])));

    const result = await getRunsByCommit('nts', '100');

    expect(result).toHaveLength(1);
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get('commit')).toBe('100');
  });
});

describe('getFieldChanges', () => {
  it('fetches field changes with limit', async () => {
    const fc: FieldChangeInfo = {
      uuid: 'fc1', test: 't1', machine: 'm1', metric: 'compile_time',
      old_value: 1.0, new_value: 2.0, start_commit: '99', end_commit: '100',
    };
    mockFetch.mockResolvedValueOnce(mockResponse(cursorPage([fc])));

    const result = await getFieldChanges('nts', { limit: 1 });

    expect(result.items).toHaveLength(1);
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v5/nts/field-changes');
    expect(url.searchParams.get('limit')).toBe('1');
  });
});

describe('searchCommits', () => {
  it('passes search and limit params', async () => {
    const commit: CommitSummary = { commit: '100', ordinal: 1, fields: {} };
    mockFetch.mockResolvedValueOnce(mockResponse(cursorPage([commit])));

    const result = await searchCommits('nts', 'release', { limit: 10 });

    expect(result.items).toHaveLength(1);
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v5/nts/commits');
    expect(url.searchParams.get('search')).toBe('release');
    expect(url.searchParams.get('limit')).toBe('10');
  });
});

describe('updateCommit', () => {
  it('sends PATCH with updates in JSON body', async () => {
    const commit: CommitDetail = {
      commit: '100', ordinal: 1, fields: {},
      previous_commit: null, next_commit: null,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(commit));

    const result = await updateCommit('nts', '100', { tag: 'new-tag' });

    expect(result.commit).toBe('100');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(new URL(url).pathname).toBe('/api/v5/nts/commits/100');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual({ tag: 'new-tag' });
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('includes auth token when set', async () => {
    storedToken = 'my-admin-token';
    mockFetch.mockResolvedValueOnce(mockResponse({
      commit: '100', ordinal: 1, fields: {}, previous_commit: null, next_commit: null,
    }));

    await updateCommit('nts', '100', { tag: null });

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers['Authorization']).toBe('Bearer my-admin-token');
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse('Forbidden', 403, 'Forbidden'));

    await expect(updateCommit('nts', '100', { tag: 'x' })).rejects.toThrow('API 403');
  });
});


// ===========================================================================
// apiUrl
// ===========================================================================

describe('apiUrl', () => {
  it('constructs URL with encoded test suite name', () => {
    setApiBase('');
    expect(apiUrl('nts', 'query')).toBe('/api/v5/nts/query');
  });

  it('includes apiBase prefix', () => {
    setApiBase('/lnt');
    expect(apiUrl('nts', 'machines')).toBe('/lnt/api/v5/nts/machines');
  });

  it('encodes special characters in test suite name', () => {
    setApiBase('');
    expect(apiUrl('my suite', 'commits')).toBe('/api/v5/my%20suite/commits');
  });
});

// ===========================================================================
// fetchOneCursorPage
// ===========================================================================

describe('fetchOneCursorPage', () => {
  it('returns items and nextCursor from a single page', async () => {
    const pt: QueryDataPoint = {
      test: 't1', machine: 'm1', metric: 'exec_time', value: 1.0,
      commit: '100', ordinal: 1, run_uuid: 'r1', submitted_at: null,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(cursorPage([pt], 'next-abc')));

    const result = await fetchOneCursorPage<QueryDataPoint>(
      '/api/v5/nts/query', { machine: 'm1', limit: '10000' },
    );

    expect(result.items).toEqual([pt]);
    expect(result.nextCursor).toBe('next-abc');
  });

  it('returns null nextCursor on last page', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(cursorPage([{ test: 't1' }], null)));

    const result = await fetchOneCursorPage('/api/v5/nts/query', {});

    expect(result.nextCursor).toBeNull();
  });

  it('passes signal to fetch', async () => {
    const controller = new AbortController();
    mockFetch.mockResolvedValueOnce(mockResponse(cursorPage([])));

    await fetchOneCursorPage('/api/v5/nts/query', {}, controller.signal);

    expect(mockFetch.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it('passes limit and cursor as query params', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(cursorPage([])));

    await fetchOneCursorPage('/api/v5/nts/query', {
      machine: 'm1', metric: 'exec_time', sort: '-commit', limit: '10000', cursor: 'abc',
    });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get('machine')).toBe('m1');
    expect(url.searchParams.get('metric')).toBe('exec_time');
    expect(url.searchParams.get('sort')).toBe('-commit');
    expect(url.searchParams.get('limit')).toBe('10000');
    expect(url.searchParams.get('cursor')).toBe('abc');
  });
});

// ===========================================================================
// fetchTrends
// ===========================================================================

describe('fetchTrends', () => {
  it('sends POST with JSON body containing metric, machine list, and last_n', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({
      metric: 'exec_time',
      items: [{ machine: 'm1', commit: '100', ordinal: 1, submitted_at: '2025-01-01T00:00:00Z', value: 42.0 }],
    }));

    const result = await fetchTrends('nts', { metric: 'exec_time', machine: ['m1', 'm2'], lastN: 100 });

    expect(result).toHaveLength(1);
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v5/nts/trends');
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.metric).toBe('exec_time');
    expect(body.machine).toEqual(['m1', 'm2']);
    expect(body.last_n).toBe(100);
  });

  it('omits machine and last_n when not provided', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ metric: 'exec_time', items: [] }));

    await fetchTrends('nts', { metric: 'exec_time' });

    const init = mockFetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.metric).toBe('exec_time');
    expect(body.machine).toBeUndefined();
    expect(body.last_n).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveCommits
// ---------------------------------------------------------------------------

describe('resolveCommits', () => {
  it('sends POST with JSON body to /commits/resolve', async () => {
    const response = { results: {}, not_found: ['abc'] };
    mockFetch.mockResolvedValueOnce(mockResponse(response));

    await resolveCommits('nts', ['abc', 'def']);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/v5/nts/commits/resolve');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.commits).toEqual(['abc', 'def']);
  });

  it('includes auth token when present', async () => {
    storedToken = 'test-token';
    mockFetch.mockResolvedValueOnce(mockResponse({ results: {}, not_found: [] }));

    await resolveCommits('nts', ['abc']);

    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-token');
  });

  it('passes AbortSignal through', async () => {
    const ctrl = new AbortController();
    mockFetch.mockResolvedValueOnce(mockResponse({ results: {}, not_found: [] }));

    await resolveCommits('nts', ['abc'], ctrl.signal);

    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBe(ctrl.signal);
  });

  it('throws ApiError on non-OK response', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: 'bad' }, 422, 'Unprocessable Entity'));

    await expect(resolveCommits('nts', ['abc'])).rejects.toThrow(ApiError);
  });
});

// ---------------------------------------------------------------------------
// getTestSuiteInfoCached
// ---------------------------------------------------------------------------

describe('getTestSuiteInfoCached', () => {
  const suiteInfo = { name: 'cached-suite', schema: { metrics: [], commit_fields: [], machine_fields: [] } };

  it('fetches on first call and returns data', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(suiteInfo));

    const result = await getTestSuiteInfoCached('cached-suite-1');
    expect(result.name).toBe('cached-suite');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns cached result on second call without new fetch', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(suiteInfo));

    const r1 = await getTestSuiteInfoCached('cached-suite-2');
    const r2 = await getTestSuiteInfoCached('cached-suite-2');

    expect(r1).toBe(r2);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('evicts rejected promise so retry works', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse('error', 500, 'Internal Server Error'))
      .mockResolvedValueOnce(mockResponse(suiteInfo));

    await expect(getTestSuiteInfoCached('cached-suite-3')).rejects.toThrow();
    // Allow microtask for eviction .catch() to run
    await new Promise(r => setTimeout(r, 0));

    const result = await getTestSuiteInfoCached('cached-suite-3');
    expect(result.name).toBe('cached-suite');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent calls on one fetch', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(suiteInfo));

    const [r1, r2] = await Promise.all([
      getTestSuiteInfoCached('cached-suite-4'),
      getTestSuiteInfoCached('cached-suite-4'),
    ]);

    expect(r1).toBe(r2);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
