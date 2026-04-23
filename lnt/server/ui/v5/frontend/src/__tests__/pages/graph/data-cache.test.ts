// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GraphDataCache, type GraphDataApi } from '../../../pages/graph/data-cache';
import type { QueryDataPoint } from '../../../types';

function makePoint(test: string, commitValue: string, value: number, machine = 'm1', metric = 'exec_time'): QueryDataPoint {
  return {
    test,
    machine,
    metric,
    value,
    commit: commitValue,
    ordinal: null,
    tag: null,
    run_uuid: 'r1',
    submitted_at: null,
  };
}

function createMockApi(): GraphDataApi & {
  fetchOneCursorPage: ReturnType<typeof vi.fn>;
  postOneCursorPage: ReturnType<typeof vi.fn>;
} {
  return {
    apiUrl: (suite: string, path: string) => `/api/v5/${suite}/${path}`,
    fetchOneCursorPage: vi.fn(),
    postOneCursorPage: vi.fn(),
  };
}

describe('GraphDataCache', () => {
  let api: ReturnType<typeof createMockApi>;
  let cache: GraphDataCache;

  beforeEach(() => {
    api = createMockApi();
    cache = new GraphDataCache(api);
  });

  // ---- Scaffold ----

  describe('getScaffold', () => {
    it('fetches commits sorted by ordinal and caches', async () => {
      api.fetchOneCursorPage.mockResolvedValueOnce({
        items: [
          { commit: '100', ordinal: 10, tag: null, fields: {} },
          { commit: '101', ordinal: 20, tag: null, fields: {} },
        ],
        nextCursor: null,
      });

      const result = await cache.getScaffold('nts', 'm1');
      expect(result).toEqual(['100', '101']);
      expect(api.fetchOneCursorPage).toHaveBeenCalledTimes(1);

      const [url, params] = api.fetchOneCursorPage.mock.calls[0];
      expect(url).toContain('/commits');
      expect(params).toMatchObject({ machine: 'm1', sort: 'ordinal' });

      // Second call returns cached
      const result2 = await cache.getScaffold('nts', 'm1');
      expect(result2).toEqual(['100', '101']);
      expect(api.fetchOneCursorPage).toHaveBeenCalledTimes(1);
    });

    it('paginates through all results', async () => {
      api.fetchOneCursorPage
        .mockResolvedValueOnce({
          items: [{ commit: '100', ordinal: 10, tag: null, fields: {} }],
          nextCursor: 'cursor1',
        })
        .mockResolvedValueOnce({
          items: [{ commit: '101', ordinal: 20, tag: null, fields: {} }],
          nextCursor: null,
        });

      const result = await cache.getScaffold('nts', 'm1');
      expect(result).toEqual(['100', '101']);
      expect(api.fetchOneCursorPage).toHaveBeenCalledTimes(2);
    });
  });

  // ---- Test Discovery ----

  describe('discoverTests', () => {
    it('fetches once and caches (sorted)', async () => {
      api.fetchOneCursorPage.mockResolvedValueOnce({
        items: [{ name: 'test-B' }, { name: 'test-A' }],
        nextCursor: null,
      });

      const result = await cache.discoverTests('nts', 'm1', 'exec_time');
      expect(result).toEqual(['test-A', 'test-B']);
      expect(api.fetchOneCursorPage).toHaveBeenCalledTimes(1);

      const result2 = await cache.discoverTests('nts', 'm1', 'exec_time');
      expect(result2).toEqual(['test-A', 'test-B']);
      expect(api.fetchOneCursorPage).toHaveBeenCalledTimes(1);
    });

    it('paginates through all results', async () => {
      api.fetchOneCursorPage
        .mockResolvedValueOnce({ items: [{ name: 'test-A' }], nextCursor: 'c1' })
        .mockResolvedValueOnce({ items: [{ name: 'test-B' }], nextCursor: null });

      const result = await cache.discoverTests('nts', 'm1', 'exec_time');
      expect(result).toEqual(['test-A', 'test-B']);
      expect(api.fetchOneCursorPage).toHaveBeenCalledTimes(2);
    });
  });

  // ---- Query Data ----

  describe('ensureTestData', () => {
    it('fetches only uncached tests', async () => {
      // Pre-cache test-A via ensureTestData
      api.postOneCursorPage.mockResolvedValueOnce({
        items: [makePoint('test-A', '100', 1.0)], nextCursor: null,
      });
      await cache.ensureTestData('nts', 'm1', 'exec_time', ['test-A']);

      // Now ensure test-A + test-B — only test-B fetched
      api.postOneCursorPage.mockResolvedValueOnce({
        items: [makePoint('test-B', '100', 3.0)], nextCursor: null,
      });
      await cache.ensureTestData('nts', 'm1', 'exec_time', ['test-A', 'test-B']);

      expect(api.postOneCursorPage).toHaveBeenCalledTimes(2);
      expect(api.postOneCursorPage.mock.calls[1][1].test).toEqual(['test-B']);
    });

    it('is a no-op for fully cached tests', async () => {
      api.postOneCursorPage.mockResolvedValueOnce({
        items: [makePoint('test-A', '100', 1.0)], nextCursor: null,
      });
      await cache.ensureTestData('nts', 'm1', 'exec_time', ['test-A']);

      await cache.ensureTestData('nts', 'm1', 'exec_time', ['test-A']);
      expect(api.postOneCursorPage).toHaveBeenCalledTimes(1);
    });

    it('calls onProgress after each page and on completion', async () => {
      api.postOneCursorPage
        .mockResolvedValueOnce({
          items: [makePoint('test-A', '100', 1.0)], nextCursor: 'c1',
        })
        .mockResolvedValueOnce({
          items: [makePoint('test-A', '101', 2.0)], nextCursor: null,
        });

      const onProgress = vi.fn();
      await cache.ensureTestData('nts', 'm1', 'exec_time', ['test-A'], { onProgress });
      expect(onProgress).toHaveBeenCalledTimes(2);
    });

    it('distributes points to per-test entries', async () => {
      api.postOneCursorPage.mockResolvedValueOnce({
        items: [
          makePoint('test-A', '100', 1.0),
          makePoint('test-B', '100', 2.0),
          makePoint('test-A', '101', 3.0),
        ],
        nextCursor: null,
      });

      await cache.ensureTestData('nts', 'm1', 'exec_time', ['test-A', 'test-B']);
      expect(cache.readCachedTestData('nts', 'm1', 'exec_time', 'test-A')).toHaveLength(2);
      expect(cache.readCachedTestData('nts', 'm1', 'exec_time', 'test-B')).toHaveLength(1);
    });
  });

  describe('readCachedTestData', () => {
    it('returns [] for uncached test', () => {
      expect(cache.readCachedTestData('nts', 'm1', 'exec_time', 'test-A')).toEqual([]);
    });
  });

  describe('isComplete', () => {
    it('returns false for uncached', () => {
      expect(cache.isComplete('nts', 'm1', 'exec_time', 'test-A')).toBe(false);
    });

    it('returns true after ensureTestData completes', async () => {
      api.postOneCursorPage.mockResolvedValueOnce({ items: [], nextCursor: null });
      await cache.ensureTestData('nts', 'm1', 'exec_time', ['test-A']);
      expect(cache.isComplete('nts', 'm1', 'exec_time', 'test-A')).toBe(true);
    });
  });

  // ---- Baseline Data (delta-fetch) ----

  describe('getBaselineData', () => {
    it('fetches once and caches', async () => {
      const points = [makePoint('test-A', '100', 5.0)];
      api.postOneCursorPage.mockResolvedValueOnce({ items: points, nextCursor: null });

      const result = await cache.getBaselineData('nts', 'm1', '100', 'exec_time', ['test-A']);
      expect(result).toEqual(points);
      expect(api.postOneCursorPage).toHaveBeenCalledTimes(1);

      // Second call with same tests — no API hit
      const result2 = await cache.getBaselineData('nts', 'm1', '100', 'exec_time', ['test-A']);
      expect(result2).toEqual(points);
      expect(api.postOneCursorPage).toHaveBeenCalledTimes(1);
    });

    it('delta-fetches only new tests', async () => {
      const pointsA = [makePoint('test-A', '100', 5.0)];
      api.postOneCursorPage.mockResolvedValueOnce({ items: pointsA, nextCursor: null });
      await cache.getBaselineData('nts', 'm1', '100', 'exec_time', ['test-A']);

      // Now request with test-B added — only test-B should be fetched
      const pointsB = [makePoint('test-B', '100', 10.0)];
      api.postOneCursorPage.mockResolvedValueOnce({ items: pointsB, nextCursor: null });
      const result = await cache.getBaselineData('nts', 'm1', '100', 'exec_time', ['test-A', 'test-B']);

      expect(api.postOneCursorPage).toHaveBeenCalledTimes(2);
      // Second call should only request test-B
      expect(api.postOneCursorPage.mock.calls[1][1].test).toEqual(['test-B']);
      // Result includes both test-A and test-B points (merged)
      expect(result).toHaveLength(2);
      expect(result.map(p => p.test)).toEqual(['test-A', 'test-B']);
    });

    it('no-op when all requested tests are covered', async () => {
      const points = [makePoint('test-A', '100', 5.0), makePoint('test-B', '100', 10.0)];
      api.postOneCursorPage.mockResolvedValueOnce({ items: points, nextCursor: null });
      await cache.getBaselineData('nts', 'm1', '100', 'exec_time', ['test-A', 'test-B']);

      const result = await cache.getBaselineData('nts', 'm1', '100', 'exec_time', ['test-A']);
      expect(result).toEqual(points);
      expect(api.postOneCursorPage).toHaveBeenCalledTimes(1);
    });
  });

  describe('readCachedBaselineData', () => {
    it('returns [] for uncached', () => {
      expect(cache.readCachedBaselineData('nts', 'm1', '100', 'exec_time')).toEqual([]);
    });

    it('returns data for cached baseline', async () => {
      const points = [makePoint('test-A', '100', 5.0)];
      api.postOneCursorPage.mockResolvedValueOnce({ items: points, nextCursor: null });
      await cache.getBaselineData('nts', 'm1', '100', 'exec_time', ['test-A']);
      expect(cache.readCachedBaselineData('nts', 'm1', '100', 'exec_time')).toEqual(points);
    });
  });

  // ---- Baseline Commits ----

  describe('getBaselineCommits', () => {
    it('fetches and caches commit list', async () => {
      const commits = [
        { commit: '100', ordinal: 10, tag: null, fields: {} },
        { commit: '101', ordinal: 20, tag: null, fields: {} },
      ];
      api.fetchOneCursorPage.mockResolvedValueOnce({ items: commits, nextCursor: null });

      const result = await cache.getBaselineCommits('nts', 'm1');
      expect(result).toEqual(commits);
      expect(api.fetchOneCursorPage).toHaveBeenCalledTimes(1);

      // Cached
      const result2 = await cache.getBaselineCommits('nts', 'm1');
      expect(result2).toEqual(commits);
      expect(api.fetchOneCursorPage).toHaveBeenCalledTimes(1);
    });
  });

  // ---- Regressions ----

  describe('getRegressions', () => {
    it('fetches active regressions with state filter', async () => {
      const items = [
        { uuid: 'r1', title: 'Reg1', bug: null, state: 'active' as const, commit: '100', machine_count: 1, test_count: 1 },
      ];
      api.fetchOneCursorPage.mockResolvedValueOnce({ items, nextCursor: null });

      const result = await cache.getRegressions('nts', 'active');
      expect(result).toEqual(items);
      expect(api.fetchOneCursorPage).toHaveBeenCalledTimes(1);

      const [, params] = api.fetchOneCursorPage.mock.calls[0];
      expect(params.state).toBe('detected,active');
    });

    it('fetches all regressions without state filter', async () => {
      api.fetchOneCursorPage.mockResolvedValueOnce({ items: [], nextCursor: null });
      await cache.getRegressions('nts', 'all');

      const [, params] = api.fetchOneCursorPage.mock.calls[0];
      expect(params.state).toBeUndefined();
    });

    it('caches results', async () => {
      api.fetchOneCursorPage.mockResolvedValueOnce({ items: [], nextCursor: null });
      await cache.getRegressions('nts', 'active');
      await cache.getRegressions('nts', 'active');
      expect(api.fetchOneCursorPage).toHaveBeenCalledTimes(1);
    });
  });

  describe('readCachedRegressions', () => {
    it('returns null for uncached', () => {
      expect(cache.readCachedRegressions('nts', 'active')).toBeNull();
    });

    it('returns cached data', async () => {
      api.fetchOneCursorPage.mockResolvedValueOnce({ items: [], nextCursor: null });
      await cache.getRegressions('nts', 'active');
      expect(cache.readCachedRegressions('nts', 'active')).toEqual([]);
    });
  });

  // ---- Error Handling ----

  describe('error handling', () => {
    it('does not cache on API error (allows retry)', async () => {
      api.postOneCursorPage.mockRejectedValueOnce(new Error('Network error'));
      await expect(
        cache.ensureTestData('nts', 'm1', 'exec_time', ['test-A']),
      ).rejects.toThrow('Network error');
      expect(cache.isComplete('nts', 'm1', 'exec_time', 'test-A')).toBe(false);
    });

    it('propagates error to caller', async () => {
      api.fetchOneCursorPage.mockRejectedValueOnce(new Error('Server error'));
      await expect(cache.getScaffold('nts', 'm1')).rejects.toThrow('Server error');
    });
  });

  // ---- Abort Signal ----

  describe('abort signal', () => {
    it('does not corrupt cache on abort during ensureTestData', async () => {
      const controller = new AbortController();

      api.postOneCursorPage.mockImplementation(async () => {
        controller.abort();
        return { items: [makePoint('test-A', '100', 1.0)], nextCursor: 'cursor1' };
      });

      await expect(
        cache.ensureTestData('nts', 'm1', 'exec_time', ['test-A'], { signal: controller.signal }),
      ).rejects.toThrow('Aborted');
      expect(cache.isComplete('nts', 'm1', 'exec_time', 'test-A')).toBe(false);
    });
  });

  // ---- Scaffold Union ----

  describe('scaffoldUnion', () => {
    it('computes union across machines sorted by ordinal', async () => {
      api.fetchOneCursorPage
        .mockResolvedValueOnce({
          items: [
            { commit: '100', ordinal: 10, tag: null, fields: {} },
            { commit: '101', ordinal: 30, tag: null, fields: {} },
          ],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          items: [
            { commit: '101', ordinal: 30, tag: null, fields: {} },
            { commit: '102', ordinal: 40, tag: null, fields: {} },
          ],
          nextCursor: null,
        });

      await cache.getScaffold('nts', 'm1');
      await cache.getScaffold('nts', 'm2');

      const union = cache.scaffoldUnion('nts', ['m1', 'm2']);
      expect(union?.commits).toEqual(['100', '101', '102']);
    });

    it('merges interleaved ordinals correctly', async () => {
      api.fetchOneCursorPage
        .mockResolvedValueOnce({
          items: [
            { commit: 'a', ordinal: 1, tag: null, fields: {} },
            { commit: 'c', ordinal: 3, tag: null, fields: {} },
            { commit: 'e', ordinal: 5, tag: null, fields: {} },
          ],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          items: [
            { commit: 'b', ordinal: 2, tag: null, fields: {} },
            { commit: 'c', ordinal: 3, tag: null, fields: {} },
            { commit: 'f', ordinal: 6, tag: null, fields: {} },
          ],
          nextCursor: null,
        });

      await cache.getScaffold('nts', 'm1');
      await cache.getScaffold('nts', 'm2');

      const union = cache.scaffoldUnion('nts', ['m1', 'm2']);
      expect(union?.commits).toEqual(['a', 'b', 'c', 'e', 'f']);
    });

    it('returns null when no scaffolds cached', () => {
      expect(cache.scaffoldUnion('nts', ['m1'])).toBeNull();
    });

    it('populates displayMap when commitFields has a display field', async () => {
      api.fetchOneCursorPage.mockResolvedValueOnce({
        items: [
          { commit: 'abc', ordinal: 1, tag: null, fields: { sha: 'short-abc' } },
          { commit: 'def', ordinal: 2, tag: null, fields: { sha: 'short-def' } },
        ],
        nextCursor: null,
      });
      await cache.getScaffold('nts', 'm1');

      const commitFields = [{ name: 'sha', display: true }];
      const union = cache.scaffoldUnion('nts', ['m1'], commitFields);
      expect(union?.displayMap.get('abc')).toBe('short-abc');
      expect(union?.displayMap.get('def')).toBe('short-def');
    });

    it('returns empty displayMap when no commitFields provided', async () => {
      api.fetchOneCursorPage.mockResolvedValueOnce({
        items: [
          { commit: 'abc', ordinal: 1, tag: null, fields: { sha: 'short-abc' } },
        ],
        nextCursor: null,
      });

      await cache.getScaffold('nts', 'm1');

      const union = cache.scaffoldUnion('nts', ['m1']);
      expect(union?.displayMap.size).toBe(0);
    });

    it('includes tag in displayMap when commits have tags', async () => {
      api.fetchOneCursorPage.mockResolvedValueOnce({
        items: [
          { commit: 'abc', ordinal: 1, tag: 'release-1.0', fields: { sha: 'short-abc' } },
          { commit: 'def', ordinal: 2, tag: null, fields: { sha: 'short-def' } },
        ],
        nextCursor: null,
      });
      await cache.getScaffold('nts', 'm1');

      const commitFields = [{ name: 'sha', display: true }];
      const union = cache.scaffoldUnion('nts', ['m1'], commitFields);
      // Tagged commit: display field + tag suffix
      expect(union?.displayMap.get('abc')).toBe('short-abc (release-1.0)');
      // Untagged commit: display field only
      expect(union?.displayMap.get('def')).toBe('short-def');
    });

    it('includes tag in displayMap even without display fields', async () => {
      api.fetchOneCursorPage.mockResolvedValueOnce({
        items: [
          { commit: 'abc', ordinal: 1, tag: 'v1.0', fields: {} },
          { commit: 'def', ordinal: 2, tag: null, fields: {} },
        ],
        nextCursor: null,
      });
      await cache.getScaffold('nts', 'm1');

      const commitFields = [{ name: 'sha' }]; // no display: true
      const union = cache.scaffoldUnion('nts', ['m1'], commitFields);
      // Tag appended to raw commit string
      expect(union?.displayMap.get('abc')).toBe('abc (v1.0)');
      // Untagged commit: no entry in displayMap (display === commit)
      expect(union?.displayMap.has('def')).toBe(false);
    });
  });

  // ---- Cache Management ----

  describe('clearSuite', () => {
    it('clears suite-specific caches', async () => {
      api.fetchOneCursorPage
        .mockResolvedValueOnce({
          items: [{ commit: '100', ordinal: 10, tag: null, fields: {} }], nextCursor: null,
        })
        .mockResolvedValueOnce({
          items: [{ name: 'test-A' }], nextCursor: null,
        });
      api.postOneCursorPage
        .mockResolvedValueOnce({ items: [makePoint('test-A', '100', 1.0)], nextCursor: null });

      await cache.getScaffold('nts', 'm1');
      await cache.discoverTests('nts', 'm1', 'exec_time');
      await cache.ensureTestData('nts', 'm1', 'exec_time', ['test-A']);

      cache.clearSuite();

      expect(cache.scaffoldUnion('nts', ['m1'])).toBeNull();
      expect(cache.readCachedTestData('nts', 'm1', 'exec_time', 'test-A')).toEqual([]);
    });

    it('preserves baseline commit cache across clearSuite', async () => {
      api.fetchOneCursorPage.mockResolvedValueOnce({
        items: [{ commit: '100', ordinal: 10, tag: null, fields: {} }],
        nextCursor: null,
      });
      await cache.getBaselineCommits('other', 'm1');

      cache.clearSuite();

      // Baseline commits should still be cached (no API call)
      api.fetchOneCursorPage.mockClear();
      const result = await cache.getBaselineCommits('other', 'm1');
      expect(result).toHaveLength(1);
      expect(api.fetchOneCursorPage).not.toHaveBeenCalled();
    });

    it('preserves baseline data cache across clearSuite', async () => {
      const points = [makePoint('test-A', '100', 5.0)];
      api.postOneCursorPage.mockResolvedValueOnce({ items: points, nextCursor: null });
      await cache.getBaselineData('other', 'm1', '100', 'exec_time', ['test-A']);

      cache.clearSuite();

      expect(cache.readCachedBaselineData('other', 'm1', '100', 'exec_time')).toEqual(points);
    });
  });

  describe('clear', () => {
    it('clears everything including baselines', async () => {
      api.fetchOneCursorPage.mockResolvedValueOnce({
        items: [{ commit: '100', ordinal: 10, tag: null, fields: {} }], nextCursor: null,
      });
      api.postOneCursorPage.mockResolvedValueOnce({
        items: [makePoint('test-A', '100', 5.0)], nextCursor: null,
      });

      await cache.getBaselineCommits('other', 'm1');
      await cache.getBaselineData('other', 'm1', '100', 'exec_time', ['test-A']);

      cache.clear();

      expect(cache.readCachedBaselineData('other', 'm1', '100', 'exec_time')).toEqual([]);
      // getBaselineCommits would need to re-fetch
      api.fetchOneCursorPage.mockResolvedValueOnce({
        items: [], nextCursor: null,
      });
      const result = await cache.getBaselineCommits('other', 'm1');
      expect(result).toEqual([]);
    });
  });
});