// pages/graph/data-cache.ts — Centralized data cache for the graph page.
// Module-level instance survives mount/unmount for instant back-nav.

import type { QueryDataPoint, CommitSummary, RegressionListItem } from '../../types';
import type { CursorPageResult } from '../../api';
import { commitDisplayValue } from '../../utils';

export interface GraphDataApi {
  apiUrl: (suite: string, path: string) => string;
  fetchOneCursorPage: <T>(url: string, params?: Record<string, string | string[]>, signal?: AbortSignal) => Promise<CursorPageResult<T>>;
  postOneCursorPage: <T>(url: string, body: Record<string, unknown>, signal?: AbortSignal) => Promise<CursorPageResult<T>>;
}

const PAGE_LIMIT = 10000;

function dataKey(suite: string, machine: string, metric: string, test: string): string {
  return `${suite}\0${machine}\0${metric}\0${test}`;
}

function baselineKey(suite: string, machine: string, commit: string, metric: string): string {
  return `${suite}\0${machine}\0${commit}\0${metric}`;
}

function testNamesKey(suite: string, machine: string, metric: string): string {
  return `${suite}\0${machine}\0${metric}`;
}

function scaffoldKey(suite: string, machine: string): string {
  return `${suite}\0${machine}`;
}

function regressionKey(suite: string, mode: string): string {
  return `${suite}\0${mode}`;
}

interface ScaffoldEntry { commit: string; ordinal: number; tag: string | null; fields: Record<string, string>; }

interface ScaffoldCache { entries: ScaffoldEntry[]; commits: string[]; }

export class GraphDataCache {
  private data = new Map<string, { points: QueryDataPoint[]; complete: boolean }>();
  private baselineData = new Map<string, { points: QueryDataPoint[]; fetchedTests: Set<string> }>();
  private baselineCommits = new Map<string, CommitSummary[]>();
  private testNames = new Map<string, string[]>();
  private scaffolds = new Map<string, ScaffoldCache>();
  private regressions = new Map<string, RegressionListItem[]>();
  private api: GraphDataApi;

  constructor(api: GraphDataApi) {
    this.api = api;
  }

  // ---- Scaffold ----

  async getScaffold(
    suite: string,
    machine: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const key = scaffoldKey(suite, machine);
    const cached = this.scaffolds.get(key);
    if (cached) return cached.commits;

    const entries: ScaffoldEntry[] = [];
    let cursor: string | undefined;
    const commitsUrl = this.api.apiUrl(suite, 'commits');
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const params: Record<string, string> = { machine, sort: 'ordinal', limit: '10000' };
      if (cursor) params.cursor = cursor;
      const page = await this.api.fetchOneCursorPage<CommitSummary>(commitsUrl, params, signal);
      for (const item of page.items) {
        if (item.ordinal != null) {
          entries.push({ commit: item.commit, ordinal: item.ordinal, tag: item.tag, fields: item.fields });
        }
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const commits = entries.map(e => e.commit);
    this.scaffolds.set(key, { entries, commits });
    return commits;
  }

  // ---- Test Discovery ----

  async discoverTests(suite: string, machine: string, metric: string, signal?: AbortSignal): Promise<string[]> {
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

  readCachedTests(suite: string, machine: string, metric: string): string[] | null {
    return this.testNames.get(testNamesKey(suite, machine, metric)) ?? null;
  }

  // ---- Query Data ----

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
      if (opts?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
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

  // ---- Baseline Data (cross-suite, delta-fetch) ----

  async getBaselineData(
    suite: string, machine: string, commit: string, metric: string,
    tests: string[], signal?: AbortSignal,
  ): Promise<QueryDataPoint[]> {
    const key = baselineKey(suite, machine, commit, metric);
    const cached = this.baselineData.get(key);

    // Delta-fetch: only request tests not already cached
    const newTests = cached
      ? tests.filter(t => !cached.fetchedTests.has(t))
      : tests;

    if (newTests.length === 0 && cached) return cached.points;

    const queryUrl = this.api.apiUrl(suite, 'query');
    const fetched: QueryDataPoint[] = [];
    let cursor: string | undefined;
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const body: Record<string, unknown> = {
        machine,
        metric,
        commit,
        test: newTests,
        limit: PAGE_LIMIT,
      };
      if (cursor) body.cursor = cursor;
      const page = await this.api.postOneCursorPage<QueryDataPoint>(queryUrl, body, signal);
      for (const pt of page.items) fetched.push(pt);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    // Merge into existing cache
    if (cached) {
      for (const pt of fetched) cached.points.push(pt);
      for (const t of newTests) cached.fetchedTests.add(t);
      return cached.points;
    } else {
      const entry = { points: fetched, fetchedTests: new Set(tests) };
      this.baselineData.set(key, entry);
      return fetched;
    }
  }

  readCachedBaselineData(suite: string, machine: string, commit: string, metric: string): QueryDataPoint[] {
    const key = baselineKey(suite, machine, commit, metric);
    const entry = this.baselineData.get(key);
    return entry ? entry.points : [];
  }

  scaffoldUnion(
    suite: string,
    machineList: string[],
    commitFields?: Array<{ name: string; display?: boolean }>,
  ): { commits: string[]; displayMap: Map<string, string> } | null {
    const byCommit = new Map<string, number>();
    const displayMap = new Map<string, string>();
    for (const m of machineList) {
      const key = scaffoldKey(suite, m);
      const cached = this.scaffolds.get(key);
      if (cached) {
        for (const entry of cached.entries) {
          if (!byCommit.has(entry.commit)) {
            byCommit.set(entry.commit, entry.ordinal);
            if (commitFields) {
              const display = commitDisplayValue(entry, commitFields);
              if (display !== entry.commit) {
                displayMap.set(entry.commit, display);
              }
            }
          }
        }
      }
    }
    if (byCommit.size === 0) return null;
    const sorted = [...byCommit.entries()].sort((a, b) => a[1] - b[1]);
    return { commits: sorted.map(([commit]) => commit), displayMap };
  }

  // ---- Baseline Commits (cross-suite, not cleared on suite change) ----

  async getBaselineCommits(
    suite: string, machine: string, signal?: AbortSignal,
  ): Promise<CommitSummary[]> {
    const key = scaffoldKey(suite, machine);
    const cached = this.baselineCommits.get(key);
    if (cached) return cached;

    const allCommits: CommitSummary[] = [];
    let cursor: string | undefined;
    const url = this.api.apiUrl(suite, 'commits');
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const params: Record<string, string> = { machine, sort: 'ordinal', limit: '10000' };
      if (cursor) params.cursor = cursor;
      const page = await this.api.fetchOneCursorPage<CommitSummary>(url, params, signal);
      for (const item of page.items) allCommits.push(item);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    this.baselineCommits.set(key, allCommits);
    return allCommits;
  }

  // ---- Regressions ----

  async getRegressions(
    suite: string, mode: 'active' | 'all', signal?: AbortSignal,
  ): Promise<RegressionListItem[]> {
    const key = regressionKey(suite, mode);
    const cached = this.regressions.get(key);
    if (cached) return cached;

    const all: RegressionListItem[] = [];
    let cursor: string | undefined;
    const url = this.api.apiUrl(suite, 'regressions');
    const stateFilter = mode === 'active' ? 'detected,active' : '';
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const params: Record<string, string> = { limit: '500' };
      if (stateFilter) params.state = stateFilter;
      if (cursor) params.cursor = cursor;
      const page = await this.api.fetchOneCursorPage<RegressionListItem>(url, params, signal);
      for (const item of page.items) all.push(item);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    this.regressions.set(key, all);
    return all;
  }

  readCachedRegressions(suite: string, mode: 'active' | 'all'): RegressionListItem[] | null {
    return this.regressions.get(regressionKey(suite, mode)) ?? null;
  }

  // ---- Cache Management ----

  /** Clear suite-specific caches (scaffolds, tests, query data, regressions).
   *  Preserves cross-suite baseline data and baseline commit caches. */
  clearSuite(): void {
    this.data.clear();
    this.testNames.clear();
    this.scaffolds.clear();
    this.regressions.clear();
  }

  /** Clear all caches including cross-suite baselines. */
  clear(): void {
    this.clearSuite();
    this.baselineData.clear();
    this.baselineCommits.clear();
  }
}
