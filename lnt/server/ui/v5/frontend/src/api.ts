import type {
  APIKeyCreateResponse, APIKeyItem,
  CursorPaginated, FieldChangeInfo, FieldInfo, MachineInfo, MachineRunInfo,
  OffsetPaginated, OrderDetail, OrderSummary, QueryDataPoint, RunDetail,
  RunInfo, SampleInfo, TestSuiteInfo,
} from './types';

let apiBase = '';

export function setApiBase(base: string): void {
  // base should be the lnt_url_base value, e.g. "" or "/lnt"
  apiBase = base.replace(/\/$/, '');
}

function getToken(): string | null {
  return localStorage.getItem('lnt_v5_token');
}

/** Structured API error with HTTP status code. */
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/** Format an auth/permission error for display. */
export function authErrorMessage(err: unknown): string {
  if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
    return "Permission denied. Set an API token with the required scope in Settings.";
  }
  return `Error: ${err}`;
}

interface FetchOptions {
  params?: Record<string, string | string[]>;
  signal?: AbortSignal;
  method?: string;
  body?: unknown;
}

async function fetchJson<T>(url: string, opts?: FetchOptions): Promise<T> {
  const params = opts?.params;
  const signal = opts?.signal;
  const method = opts?.method;
  const body = opts?.body;

  const u = new URL(url, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) {
        for (const item of v) u.searchParams.append(k, item);
      } else if (v !== undefined && v !== '') {
        u.searchParams.set(k, v);
      }
    }
  }
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const init: RequestInit = { headers, signal };
  if (method) init.method = method;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const resp = await fetch(u.toString(), init);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new ApiError(resp.status, `API ${resp.status}: ${text || resp.statusText}`);
  }
  return resp.json();
}

/** Like fetchJson but for endpoints that return no body (e.g. DELETE → 204). */
async function fetchVoid(url: string, opts?: FetchOptions): Promise<void> {
  const u = new URL(url, window.location.origin);
  if (opts?.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      if (Array.isArray(v)) {
        for (const item of v) u.searchParams.append(k, item);
      } else if (v !== undefined && v !== '') {
        u.searchParams.set(k, v);
      }
    }
  }
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const init: RequestInit = { headers, signal: opts?.signal };
  if (opts?.method) init.method = opts.method;

  const resp = await fetch(u.toString(), init);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new ApiError(resp.status, `API ${resp.status}: ${text || resp.statusText}`);
  }
}

async function fetchAllCursorPages<T>(
  url: string,
  params?: Record<string, string | string[]>,
  signal?: AbortSignal,
  onProgress?: (loaded: number) => void,
  postBody?: Record<string, unknown>,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;

  while (true) {
    let page: CursorPaginated<T>;
    if (postBody !== undefined) {
      // POST mode: parameters go in JSON body, cursor merged in.
      const body = { ...postBody, limit: 500, ...(cursor ? { cursor } : {}) };
      page = await fetchJson<CursorPaginated<T>>(url, { method: 'POST', body, signal });
    } else {
      // GET mode: parameters go in URL query string.
      const p: Record<string, string | string[]> = { ...params, limit: '500' };
      if (cursor) p.cursor = cursor;
      page = await fetchJson<CursorPaginated<T>>(url, { params: p, signal });
    }
    all.push(...page.items);
    if (onProgress) onProgress(all.length);
    if (!page.cursor.next) break;
    cursor = page.cursor.next;
  }
  return all;
}

export function apiUrl(ts: string, path: string): string {
  return `${apiBase}/api/v5/${encodeURIComponent(ts)}/${path}`;
}

export interface CursorPageResult<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Fetch exactly one page of cursor-paginated results.
 * Unlike fetchAllCursorPages, the caller controls limit and cursor via params.
 */
export async function fetchOneCursorPage<T>(
  url: string,
  params?: Record<string, string | string[]>,
  signal?: AbortSignal,
): Promise<CursorPageResult<T>> {
  const page = await fetchJson<CursorPaginated<T>>(url, { params, signal });
  return { items: page.items, nextCursor: page.cursor.next };
}

/**
 * POST one page of cursor-paginated results with a JSON body.
 * Used by the query endpoint where parameters are in the request body.
 */
export async function postOneCursorPage<T>(
  url: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CursorPageResult<T>> {
  const page = await fetchJson<CursorPaginated<T>>(url, { method: 'POST', body, signal });
  return { items: page.items, nextCursor: page.cursor.next };
}

export async function getFields(ts: string, signal?: AbortSignal): Promise<FieldInfo[]> {
  const data = await fetchJson<{ schema: { metrics: FieldInfo[] } }>(
    `${apiBase}/api/v5/test-suites/${encodeURIComponent(ts)}`,
    { signal },
  );
  return data.schema.metrics;
}

export async function getOrders(
  ts: string,
  signal?: AbortSignal,
  onProgress?: (loaded: number) => void,
): Promise<OrderSummary[]> {
  return fetchAllCursorPages<OrderSummary>(apiUrl(ts, 'orders'), undefined, signal, onProgress);
}

export async function getMachines(
  ts: string,
  opts: { namePrefix?: string; nameContains?: string; limit?: number; offset?: number },
  signal?: AbortSignal,
): Promise<{ items: MachineInfo[]; total: number }> {
  const params: Record<string, string> = {};
  if (opts.namePrefix) params.name_prefix = opts.namePrefix;
  if (opts.nameContains) params.name_contains = opts.nameContains;
  if (opts.limit !== undefined) params.limit = String(opts.limit);
  if (opts.offset !== undefined) params.offset = String(opts.offset);
  const data = await fetchJson<OffsetPaginated<MachineInfo>>(apiUrl(ts, 'machines'), { params, signal });
  return { items: data.items, total: data.total };
}

export async function getRuns(
  ts: string,
  opts: { machine: string; order?: string },
  signal?: AbortSignal,
): Promise<RunInfo[]> {
  const params: Record<string, string> = { machine: opts.machine };
  if (opts.order) params.order = opts.order;
  return fetchAllCursorPages<RunInfo>(
    apiUrl(ts, 'runs'),
    params,
    signal,
  );
}

export async function getSamples(
  ts: string,
  runUuid: string,
  signal?: AbortSignal,
  onProgress?: (loaded: number) => void,
): Promise<SampleInfo[]> {
  return fetchAllCursorPages<SampleInfo>(
    apiUrl(ts, `runs/${encodeURIComponent(runUuid)}/samples`),
    undefined,
    signal,
    onProgress,
  );
}

export async function getMachine(
  ts: string,
  name: string,
  signal?: AbortSignal,
): Promise<MachineInfo> {
  return fetchJson<MachineInfo>(
    apiUrl(ts, `machines/${encodeURIComponent(name)}`),
    { signal },
  );
}

export async function getMachineRuns(
  ts: string,
  machineName: string,
  opts?: { sort?: string; limit?: number; cursor?: string },
  signal?: AbortSignal,
): Promise<CursorPaginated<MachineRunInfo>> {
  const params: Record<string, string> = {};
  if (opts?.sort) params.sort = opts.sort;
  if (opts?.limit !== undefined) params.limit = String(opts.limit);
  if (opts?.cursor) params.cursor = opts.cursor;
  return fetchJson<CursorPaginated<MachineRunInfo>>(
    apiUrl(ts, `machines/${encodeURIComponent(machineName)}/runs`),
    { params, signal },
  );
}

export async function deleteMachine(ts: string, name: string): Promise<void> {
  return fetchVoid(apiUrl(ts, `machines/${encodeURIComponent(name)}`), { method: 'DELETE' });
}

export async function getRun(
  ts: string,
  uuid: string,
  signal?: AbortSignal,
): Promise<RunDetail> {
  return fetchJson<RunDetail>(
    apiUrl(ts, `runs/${encodeURIComponent(uuid)}`),
    { signal },
  );
}

export async function deleteRun(ts: string, uuid: string): Promise<void> {
  return fetchVoid(apiUrl(ts, `runs/${encodeURIComponent(uuid)}`), { method: 'DELETE' });
}

export async function getOrder(
  ts: string,
  value: string,
  signal?: AbortSignal,
): Promise<OrderDetail> {
  return fetchJson<OrderDetail>(
    apiUrl(ts, `orders/${encodeURIComponent(value)}`),
    { signal },
  );
}

export async function getRunsByOrder(
  ts: string,
  orderValue: string,
  signal?: AbortSignal,
): Promise<RunInfo[]> {
  return fetchAllCursorPages<RunInfo>(
    apiUrl(ts, 'runs'),
    { order: orderValue },
    signal,
  );
}

export async function getRecentRuns(
  ts: string,
  opts?: { limit?: number; sort?: string },
  signal?: AbortSignal,
): Promise<CursorPaginated<RunInfo>> {
  const params: Record<string, string> = {};
  if (opts?.limit !== undefined) params.limit = String(opts.limit);
  if (opts?.sort) params.sort = opts.sort;
  return fetchJson<CursorPaginated<RunInfo>>(
    apiUrl(ts, 'runs'),
    { params, signal },
  );
}

export async function getFieldChanges(
  ts: string,
  opts?: { limit?: number; cursor?: string },
  signal?: AbortSignal,
): Promise<CursorPaginated<FieldChangeInfo>> {
  const params: Record<string, string> = {};
  if (opts?.limit !== undefined) params.limit = String(opts.limit);
  if (opts?.cursor) params.cursor = opts.cursor;
  return fetchJson<CursorPaginated<FieldChangeInfo>>(
    apiUrl(ts, 'field-changes'),
    { params, signal },
  );
}

export async function searchOrdersByTag(
  ts: string,
  tagPrefix: string,
  opts?: { limit?: number },
  signal?: AbortSignal,
): Promise<CursorPaginated<OrderSummary>> {
  const params: Record<string, string> = { tag_prefix: tagPrefix };
  if (opts?.limit !== undefined) params.limit = String(opts.limit);
  return fetchJson<CursorPaginated<OrderSummary>>(
    apiUrl(ts, 'orders'),
    { params, signal },
  );
}

export async function updateOrderTag(
  ts: string,
  orderValue: string,
  tag: string | null,
  signal?: AbortSignal,
): Promise<OrderDetail> {
  return fetchJson<OrderDetail>(
    apiUrl(ts, `orders/${encodeURIComponent(orderValue)}`),
    { method: 'PATCH', body: { tag }, signal },
  );
}

export async function queryDataPoints(
  ts: string,
  opts: {
    machine?: string;
    metric?: string;
    test?: string | string[];
    order?: string;
    afterOrder?: string;
    beforeOrder?: string;
    sort?: string;
  },
  signal?: AbortSignal,
  onProgress?: (loaded: number) => void,
): Promise<QueryDataPoint[]> {
  const body: Record<string, unknown> = {};
  if (opts.machine) body.machine = opts.machine;
  if (opts.metric) body.metric = opts.metric;
  if (opts.test) body.test = Array.isArray(opts.test) ? opts.test : [opts.test];
  if (opts.order) body.order = opts.order;
  if (opts.afterOrder) body.after_order = opts.afterOrder;
  if (opts.beforeOrder) body.before_order = opts.beforeOrder;
  if (opts.sort) body.sort = opts.sort;
  return fetchAllCursorPages<QueryDataPoint>(
    apiUrl(ts, 'query'),
    undefined,
    signal,
    onProgress,
    body,
  );
}

export async function getTests(
  ts: string,
  opts?: { machine?: string; metric?: string; nameContains?: string; limit?: number },
  signal?: AbortSignal,
): Promise<CursorPageResult<{ name: string }>> {
  const params: Record<string, string> = {};
  if (opts?.machine) params.machine = opts.machine;
  if (opts?.metric) params.metric = opts.metric;
  if (opts?.nameContains) params.name_contains = opts.nameContains;
  if (opts?.limit !== undefined) params.limit = String(opts.limit);
  return fetchOneCursorPage<{ name: string }>(apiUrl(ts, 'tests'), params, signal);
}

// ---------------------------------------------------------------------------
// Test suite info
// ---------------------------------------------------------------------------

export async function getTestSuiteInfo(
  ts: string,
  signal?: AbortSignal,
): Promise<TestSuiteInfo> {
  return fetchJson<TestSuiteInfo>(
    `${apiBase}/api/v5/test-suites/${encodeURIComponent(ts)}`,
    { signal },
  );
}

export async function createTestSuite(
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<TestSuiteInfo> {
  return fetchJson<TestSuiteInfo>(
    `${apiBase}/api/v5/test-suites/`,
    { method: 'POST', body: payload, signal },
  );
}

export async function deleteTestSuite(
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  return fetchVoid(
    `${apiBase}/api/v5/test-suites/${encodeURIComponent(name)}?confirm=true`,
    { method: 'DELETE', signal },
  );
}

// ---------------------------------------------------------------------------
// Admin — API keys (requires admin-scoped token)
// ---------------------------------------------------------------------------

export async function getApiKeys(signal?: AbortSignal): Promise<APIKeyItem[]> {
  const data = await fetchJson<{ items: APIKeyItem[] }>(
    `${apiBase}/api/v5/admin/api-keys`,
    { signal },
  );
  return data.items;
}

export async function createApiKey(
  name: string,
  scope: string,
  signal?: AbortSignal,
): Promise<APIKeyCreateResponse> {
  return fetchJson<APIKeyCreateResponse>(
    `${apiBase}/api/v5/admin/api-keys`,
    { method: 'POST', body: { name, scope }, signal },
  );
}

export async function revokeApiKey(
  prefix: string,
  signal?: AbortSignal,
): Promise<void> {
  return fetchVoid(
    `${apiBase}/api/v5/admin/api-keys/${encodeURIComponent(prefix)}`,
    { method: 'DELETE', signal },
  );
}
