// pages/graph-data-cache.ts — Centralized data cache for the graph page.

import type { QueryDataPoint } from '../types';
import type { CursorPageResult } from '../api';
import type { MachineRunInfo } from '../types';

export interface GraphDataApi {
  apiUrl: (suite: string, path: string) => string;
  fetchOneCursorPage: <T>(url: string, params?: Record<string, string | string[]>, signal?: AbortSignal) => Promise<CursorPageResult<T>>;
  postOneCursorPage: <T>(url: string, body: Record<string, unknown>, signal?: AbortSignal) => Promise<CursorPageResult<T>>;
}

const PAGE_LIMIT = 10000;

function dataKey(suite: string, machine: string, metric: string, test: string): string {
  return `${suite}::${machine}::${metric}::${test}`;
}

function baselineKey(suite: string, machine: string, commit: string, metric: string): string {
  return `${suite}::${machine}::${commit}::${metric}`;
}

function testNamesKey(suite: string, machine: string, metric: string): string {
  return `${suite}::${machine}::${metric}`;
}

function scaffoldKey(suite: string, machine: string): string {
  return `${suite}::${machine}`;
}

export class GraphDataCache {
  private data = new Map<string, { points: QueryDataPoint[]; complete: boolean }>();
  private baselineData = new Map<string, { points: QueryDataPoint[]; fetchedTests: Set<string> }>();
  private testNames = new Map<string, string[]>();
  private scaffolds = new Map<string, string[]>();
  private api: GraphDataApi;

  constructor(api: GraphDataApi) {
    this.api = api;
  }

  async getScaffold(suite: string, machine: string, signal?: AbortSignal): Promise<string[]> {
    const key = scaffoldKey(suite, machine);
    const cached = this.scaffolds.get(key);
    if (cached) return cached;

    const seen = new Set<string>();
    const commits: string[] = [];
    let cursor: string | undefined;
    const runsUrl = this.api.apiUrl(suite, `machines/${encodeURIComponent(machine)}/runs`);
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const params: Record<string, string> = { sort: 'submitted_at', limit: '10000' };
      if (cursor) params.cursor = cursor;
      const page = await this.api.fetchOneCursorPage<MachineRunInfo>(runsUrl, params, signal);
      for (const run of page.items) {
        const ov = run.commit;
        if (!seen.has(ov)) { seen.add(ov); commits.push(ov); }
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    this.scaffolds.set(key, commits);
    return commits;
  }

  async getTestNames(suite: string, machine: string, metric: string, signal?: AbortSignal): Promise<string[]> {
    const key = testNamesKey(suite, machine, metric);
    const cached = this.testNames.get(key);
    if (cached) return cached;

    const allNames: string[] = [];
    let cursor: string | undefined;
    const url = this.api.apiUrl(suite, 'tests');
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const params: Record<string, string | string[]> = {
        machine,
        metric,
        limit: '10000',
      };
      if (cursor) params.cursor = cursor;
      const page = await this.api.fetchOneCursorPage<{ name: string }>(url, params, signal);
      for (const t of page.items) allNames.push(t.name);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    allNames.sort((a, b) => a.localeCompare(b));
    this.testNames.set(key, allNames);
    return allNames;
  }

  async getTestData(suite: string, machine: string, metric: string, test: string, signal?: AbortSignal): Promise<QueryDataPoint[]> {
    const key = dataKey(suite, machine, metric, test);
    const entry = this.data.get(key);
    if (entry?.complete) {
      return entry.points;
    }

    const queryUrl = this.api.apiUrl(suite, 'query');
    const allPoints: QueryDataPoint[] = [];
    let cursor: string | undefined;
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const body: Record<string, unknown> = {
        machine,
        metric,
        test: [test],
        sort: 'test,commit',
        limit: PAGE_LIMIT,
      };
      if (cursor) body.cursor = cursor;
      const page = await this.api.postOneCursorPage<QueryDataPoint>(queryUrl, body, signal);
      for (const pt of page.items) allPoints.push(pt);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    this.data.set(key, { points: allPoints, complete: true });
    return allPoints;
  }

  async ensureTestData(
    suite: string, machine: string, metric: string, tests: string[],
    opts?: { signal?: AbortSignal; onProgress?: () => void },
  ): Promise<void> {
    const uncached = tests.filter(t => {
      const key = dataKey(suite, machine, metric, t);
      const entry = this.data.get(key);
      return !entry || !entry.complete;
    });
    if (uncached.length === 0) return;

    for (const t of uncached) {
      const key = dataKey(suite, machine, metric, t);
      this.data.set(key, { points: [], complete: false });
    }

    const queryUrl = this.api.apiUrl(suite, 'query');
    let cursor: string | undefined;
    while (true) {
      if (opts?.signal?.aborted) return;
      const body: Record<string, unknown> = {
        machine,
        metric,
        test: uncached,
        sort: 'test,commit',
        limit: PAGE_LIMIT,
      };
      if (cursor) body.cursor = cursor;

      const page = await this.api.postOneCursorPage<QueryDataPoint>(queryUrl, body, opts?.signal);

      for (const pt of page.items) {
        const key = dataKey(suite, machine, metric, pt.test);
        const entry = this.data.get(key);
        if (entry) entry.points.push(pt);
      }

      if (!page.nextCursor) break;
      cursor = page.nextCursor;

      if (opts?.onProgress) opts.onProgress();
    }

    for (const t of uncached) {
      const key = dataKey(suite, machine, metric, t);
      const entry = this.data.get(key);
      if (entry) entry.complete = true;
    }

    if (opts?.onProgress) opts.onProgress();
  }

  async getBaselineData(
    suite: string, machine: string, commit: string, metric: string,
    tests: string[], signal?: AbortSignal,
  ): Promise<QueryDataPoint[]> {
    const key = baselineKey(suite, machine, commit, metric);
    const cached = this.baselineData.get(key);

    if (cached) {
      const allCovered = tests.every(t => cached.fetchedTests.has(t));
      if (allCovered) return cached.points;
    }

    const queryUrl = this.api.apiUrl(suite, 'query');
    const allPoints: QueryDataPoint[] = [];
    let cursor: string | undefined;
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const body: Record<string, unknown> = {
        machine,
        metric,
        commit,
        test: tests,
        limit: PAGE_LIMIT,
      };
      if (cursor) body.cursor = cursor;
      const page = await this.api.postOneCursorPage<QueryDataPoint>(queryUrl, body, signal);
      for (const pt of page.items) allPoints.push(pt);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    this.baselineData.set(key, { points: allPoints, fetchedTests: new Set(tests) });
    return allPoints;
  }

  readCachedTestData(suite: string, machine: string, metric: string, test: string): QueryDataPoint[] {
    const key = dataKey(suite, machine, metric, test);
    const entry = this.data.get(key);
    return entry ? entry.points : [];
  }

  isComplete(suite: string, machine: string, metric: string, test: string): boolean {
    const key = dataKey(suite, machine, metric, test);
    const entry = this.data.get(key);
    return entry?.complete ?? false;
  }

  readCachedBaselineData(suite: string, machine: string, commit: string, metric: string): QueryDataPoint[] {
    const key = baselineKey(suite, machine, commit, metric);
    const entry = this.baselineData.get(key);
    return entry ? entry.points : [];
  }

  scaffoldUnion(suite: string, machineList: string[]): string[] | null {
    const seen = new Set<string>();
    const union: string[] = [];
    for (const m of machineList) {
      const key = scaffoldKey(suite, m);
      const scaffold = this.scaffolds.get(key);
      if (scaffold) {
        for (const ov of scaffold) {
          if (!seen.has(ov)) { seen.add(ov); union.push(ov); }
        }
      }
    }
    return union.length > 0 ? union : null;
  }

  clear(): void {
    this.data.clear();
    this.baselineData.clear();
    this.testNames.clear();
    this.scaffolds.clear();
  }
}
