// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GraphDataCache, type GraphDataApi } from '../../pages/graph-data-cache';
import type { QueryDataPoint } from '../../types';

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

  // -------------------------------------------------------------------------
  // getScaffold
  // -------------------------------------------------------------------------

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

      // Verify the endpoint and params
      const [url, params] = api.fetchOneCursorPage.mock.calls[0];
      expect(url).toContain('/commits');
      expect(params).toMatchObject({ machine: 'm1', sort: 'ordinal' });

      // Second call returns cached (no API hit)
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

  // -------------------------------------------------------------------------
  // getTestNames
  // -------------------------------------------------------------------------

  describe('getTestNames', () => {
    it('fetches once and caches', async () => {
      api.fetchOneCursorPage.mockResolvedValueOnce({
        items: [{ name: 'test-B' }, { name: 'test-A' }],
        nextCursor: null,
      });

      const result = await cache.getTestNames('nts', 'm1', 'exec_time');
      expect(result).toEqual(['test-A', 'test-B']); // sorted
      expect(api.fetchOneCursorPage).toHaveBeenCalledTimes(1);

      // Second call — no API hit
      const result2 = await cache.getTestNames('nts', 'm1', 'exec_time');
      expect(result2).toEqual(['test-A', 'test-B']);
      expect(api.fetchOneCursorPage).toHaveBeenCalledTimes(1);
    });

    it('paginates through all results', async () => {
      api.fetchOneCursorPage
        .mockResolvedValueOnce({
          items: [{ name: 'test-A' }],
          nextCursor: 'cursor1',
        })
        .mockResolvedValueOnce({
          items: [{ name: 'test-B' }],
          nextCursor: null,
        });

      const result = await cache.getTestNames('nts', 'm1', 'exec_time');
      expect(result).toEqual(['test-A', 'test-B']);
      expect(api.fetchOneCursorPage).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // getTestData / ensureTestData / readCachedTestData
  // -------------------------------------------------------------------------

  describe('getTestData', () => {
    it('fetches on demand if not pre-fetched', async () => {
      const points = [makePoint('test-A', '100', 1.0), makePoint('test-A', '101', 2.0)];
      api.postOneCursorPage.mockResolvedValueOnce({ items: points, nextCursor: null });

      const result = await cache.getTestData('nts', 'm1', 'exec_time', 'test-A');
      expect(result).toEqual(points);
      expect(api.postOneCursorPage).toHaveBeenCalledTimes(1);
    });

    it('returns cached data on second call', async () => {
      const points = [makePoint('test-A', '100', 1.0)];
      api.postOneCursorPage.mockResolvedValueOnce({ items: points, nextCursor: null });

      await cache.getTestData('nts', 'm1', 'exec_time', 'test-A');
      const result2 = await cache.getTestData('nts', 'm1', 'exec_time', 'test-A');
      expect(result2).toEqual(points);
      expect(api.postOneCursorPage).toHaveBeenCalledTimes(1);
    });
  });

  describe('ensureTestData', () => {
    it('fetches only uncached tests', async () => {
      // Pre-cache test-A
      const pointsA = [makePoint('test-A', '100', 1.0)];
      api.postOneCursorPage.mockResolvedValueOnce({ items: pointsA, nextCursor: null });
      await cache.getTestData('nts', 'm1', 'exec_time', 'test-A');

      // ensureTestData for test-A + test-B — only test-B should be fetched
      const pointsB = [makePoint('test-B', '100', 3.0)];
      api.postOneCursorPage.mockResolvedValueOnce({ items: pointsB, nextCursor: null });

      await cache.ensureTestData('nts', 'm1', 'exec_time', ['test-A', 'test-B']);

      // Should have called postOneCursorPage twice total (1 for test-A, 1 for test-B)
      expect(api.postOneCursorPage).toHaveBeenCalledTimes(2);
      // The second call should only include test-B
      const secondCallBody = api.postOneCursorPage.mock.calls[1][1];
      expect(secondCallBody.test).toEqual(['test-B']);
    });

    it('is a no-op for fully cached tests', async () => {
      const pointsA = [makePoint('test-A', '100', 1.0)];
      api.postOneCursorPage.mockResolvedValueOnce({ items: pointsA, nextCursor: null });
      await cache.getTestData('nts', 'm1', 'exec_time', 'test-A');

      await cache.ensureTestData('nts', 'm1', 'exec_time', ['test-A']);
      // No additional API call
      expect(api.postOneCursorPage).toHaveBeenCalledTimes(1);
    });

    it('calls onProgress after each page', async () => {
      api.postOneCursorPage
        .mockResolvedValueOnce({
          items: [makePoint('test-A', '100', 1.0)],
          nextCursor: 'cursor1',
        })
        .mockResolvedValueOnce({
          items: [makePoint('test-A', '101', 2.0)],
          nextCursor: null,
        });

      const onProgress = vi.fn();
      await cache.ensureTestData('nts', 'm1', 'exec_time', ['test-A'], { onProgress });

      // onProgress called after first page and after completion
      expect(onProgress).toHaveBeenCalledTimes(2);
    });

    it('distributes points to per-test entries', async () => {
      const points = [
        makePoint('test-A', '100', 1.0),
        makePoint('test-B', '100', 2.0),
        makePoint('test-A', '101', 3.0),
      ];
      api.postOneCursorPage.mockResolvedValueOnce({ items: points, nextCursor: null });

      await cache.ensureTestData('nts', 'm1', 'exec_time', ['test-A', 'test-B']);

      expect(cache.readCachedTestData('nts', 'm1', 'exec_time', 'test-A')).toHaveLength(2);
      expect(cache.readCachedTestData('nts', 'm1', 'exec_time', 'test-B')).toHaveLength(1);
    });
  });

  describe('readCachedTestData', () => {
    it('returns [] for uncached test', () => {
      expect(cache.readCachedTestData('nts', 'm1', 'exec_time', 'test-A')).toEqual([]);
    });

    it('returns data for cached test', async () => {
      const points = [makePoint('test-A', '100', 1.0)];
      api.postOneCursorPage.mockResolvedValueOnce({ items: points, nextCursor: null });
      await cache.getTestData('nts', 'm1', 'exec_time', 'test-A');

      expect(cache.readCachedTestData('nts', 'm1', 'exec_time', 'test-A')).toEqual(points);
    });
  });

  describe('isComplete', () => {
    it('returns false for uncached', () => {
      expect(cache.isComplete('nts', 'm1', 'exec_time', 'test-A')).toBe(false);
    });

    it('returns true after getTestData completes', async () => {
      api.postOneCursorPage.mockResolvedValueOnce({ items: [], nextCursor: null });
      await cache.getTestData('nts', 'm1', 'exec_time', 'test-A');
      expect(cache.isComplete('nts', 'm1', 'exec_time', 'test-A')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // getBaselineData / readCachedBaselineData
  // -------------------------------------------------------------------------

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

    it('re-fetches when requested test list includes new tests', async () => {
      const points1 = [makePoint('test-A', '100', 5.0)];
      api.postOneCursorPage.mockResolvedValueOnce({ items: points1, nextCursor: null });
      await cache.getBaselineData('nts', 'm1', '100', 'exec_time', ['test-A']);

      // Now request with test-B added
      const points2 = [makePoint('test-A', '100', 5.0), makePoint('test-B', '100', 10.0)];
      api.postOneCursorPage.mockResolvedValueOnce({ items: points2, nextCursor: null });
      const result = await cache.getBaselineData('nts', 'm1', '100', 'exec_time', ['test-A', 'test-B']);

      expect(result).toEqual(points2);
      expect(api.postOneCursorPage).toHaveBeenCalledTimes(2);
    });

    it('no-op when all requested tests are covered', async () => {
      const points = [makePoint('test-A', '100', 5.0), makePoint('test-B', '100', 10.0)];
      api.postOneCursorPage.mockResolvedValueOnce({ items: points, nextCursor: null });
      await cache.getBaselineData('nts', 'm1', '100', 'exec_time', ['test-A', 'test-B']);

      // Request subset
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

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('does not cache on API error (allows retry)', async () => {
      api.postOneCursorPage.mockRejectedValueOnce(new Error('Network error'));

      await expect(cache.getTestData('nts', 'm1', 'exec_time', 'test-A')).rejects.toThrow('Network error');

      // Entry should not be cached — next call should retry
      expect(cache.isComplete('nts', 'm1', 'exec_time', 'test-A')).toBe(false);

      // Retry succeeds
      const points = [makePoint('test-A', '100', 1.0)];
      api.postOneCursorPage.mockResolvedValueOnce({ items: points, nextCursor: null });
      const result = await cache.getTestData('nts', 'm1', 'exec_time', 'test-A');
      expect(result).toEqual(points);
    });

    it('propagates error to caller', async () => {
      api.fetchOneCursorPage.mockRejectedValueOnce(new Error('Server error'));
      await expect(cache.getScaffold('nts', 'm1')).rejects.toThrow('Server error');
    });
  });

  // -------------------------------------------------------------------------
  // Abort signal
  // -------------------------------------------------------------------------

  describe('abort signal', () => {
    it('does not corrupt cache on abort during ensureTestData', async () => {
      const controller = new AbortController();

      api.postOneCursorPage.mockImplementation(async () => {
        controller.abort();
        return { items: [makePoint('test-A', '100', 1.0)], nextCursor: 'cursor1' };
      });

      await cache.ensureTestData('nts', 'm1', 'exec_time', ['test-A'], { signal: controller.signal });

      // Entry should NOT be marked complete (abort happened mid-fetch)
      expect(cache.isComplete('nts', 'm1', 'exec_time', 'test-A')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // scaffoldUnion
  // -------------------------------------------------------------------------

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
  });

  // -------------------------------------------------------------------------
  // clear
  // -------------------------------------------------------------------------

  describe('clear', () => {
    it('resets all caches', async () => {
      // Populate each cache type
      api.fetchOneCursorPage
        .mockResolvedValueOnce({
          items: [{ commit: '100', ordinal: 10, tag: null, fields: {} }],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          items: [{ name: 'test-A' }],
          nextCursor: null,
        });
      api.postOneCursorPage
        .mockResolvedValueOnce({ items: [makePoint('test-A', '100', 1.0)], nextCursor: null })
        .mockResolvedValueOnce({ items: [makePoint('test-A', '100', 5.0)], nextCursor: null });

      await cache.getScaffold('nts', 'm1');
      await cache.getTestNames('nts', 'm1', 'exec_time');
      await cache.getTestData('nts', 'm1', 'exec_time', 'test-A');
      await cache.getBaselineData('nts', 'm1', '100', 'exec_time', ['test-A']);

      cache.clear();

      expect(cache.scaffoldUnion('nts', ['m1'])).toBeNull();
      expect(cache.readCachedTestData('nts', 'm1', 'exec_time', 'test-A')).toEqual([]);
      expect(cache.readCachedBaselineData('nts', 'm1', '100', 'exec_time')).toEqual([]);
      expect(cache.isComplete('nts', 'm1', 'exec_time', 'test-A')).toBe(false);
    });
  });
});
