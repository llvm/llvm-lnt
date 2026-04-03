// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { buildTraces, computeActiveTests, buildRefsFromCache, setsEqual, TRACE_SEP } from '../../pages/graph';
import type { QueryDataPoint } from '../../types';

function makePoint(test: string, orderValue: string, value: number, runUuid = 'r1'): QueryDataPoint {
  return {
    test,
    machine: 'm1',
    metric: 'exec_time',
    value,
    order: { rev: orderValue },
    run_uuid: runUuid,
    timestamp: null,
  };
}

describe('buildTraces', () => {
  it('groups points by test name into separate traces', () => {
    const points = [
      makePoint('test-A', '100', 1.0),
      makePoint('test-A', '101', 2.0),
      makePoint('test-B', '100', 3.0),
    ];

    const traces = buildTraces(points, '', 'median', 'median');

    expect(traces).toHaveLength(2);
    expect(traces[0].testName).toBe('test-A');
    expect(traces[0].points).toHaveLength(2);
    expect(traces[1].testName).toBe('test-B');
    expect(traces[1].points).toHaveLength(1);
  });

  it('applies test filter (case-insensitive substring)', () => {
    const points = [
      makePoint('compile/test-A', '100', 1.0),
      makePoint('exec/test-B', '100', 2.0),
      makePoint('compile/test-C', '100', 3.0),
    ];

    const traces = buildTraces(points, 'compile', 'median', 'median');

    expect(traces).toHaveLength(2);
    expect(traces.map(t => t.testName).sort()).toEqual(['compile/test-A', 'compile/test-C']);
  });

  it('aggregates multiple runs at same order using run aggregation', () => {
    const points = [
      makePoint('test-A', '100', 1.0, 'r1'),
      makePoint('test-A', '100', 3.0, 'r2'),
      makePoint('test-A', '100', 5.0, 'r3'),
    ];

    // Median of [1.0, 3.0, 5.0] = 3.0
    const traces = buildTraces(points, '', 'median', 'median');
    expect(traces).toHaveLength(1);
    expect(traces[0].points).toHaveLength(1);
    expect(traces[0].points[0].value).toBe(3.0);
    expect(traces[0].points[0].runCount).toBe(3);
  });

  it('uses mean aggregation when specified', () => {
    const points = [
      makePoint('test-A', '100', 1.0, 'r1'),
      makePoint('test-A', '100', 3.0, 'r2'),
    ];

    // Mean of [1.0, 3.0] = 2.0
    const traces = buildTraces(points, '', 'mean', 'median');
    expect(traces[0].points[0].value).toBe(2.0);
  });

  it('returns empty array when no points match filter', () => {
    const points = [makePoint('test-A', '100', 1.0)];

    const traces = buildTraces(points, 'nonexistent', 'median', 'median');
    expect(traces).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    const traces = buildTraces([], '', 'median', 'median');
    expect(traces).toHaveLength(0);
  });

  it('sorts traces by test name', () => {
    const points = [
      makePoint('zebra', '100', 1.0),
      makePoint('alpha', '100', 2.0),
      makePoint('middle', '100', 3.0),
    ];

    const traces = buildTraces(points, '', 'median', 'median');
    expect(traces.map(t => t.testName)).toEqual(['alpha', 'middle', 'zebra']);
  });

  it('preserves order value across aggregation', () => {
    const points = [
      makePoint('test-A', '100', 1.0),
      makePoint('test-A', '101', 2.0),
      makePoint('test-A', '102', 3.0),
    ];

    const traces = buildTraces(points, '', 'median', 'median');
    const orderValues = traces[0].points.map(p => p.orderValue);
    expect(orderValues).toEqual(['100', '101', '102']);
  });

  it('preserves insertion order for reversed input (newest-first)', () => {
    const points = [
      makePoint('test-A', '102', 3.0),
      makePoint('test-A', '101', 2.0),
      makePoint('test-A', '100', 1.0),
    ];

    const traces = buildTraces(points, '', 'median', 'median');
    // buildTraces preserves Map insertion order, so reversed input stays reversed
    const orderValues = traces[0].points.map(p => p.orderValue);
    expect(orderValues).toEqual(['102', '101', '100']);
  });

  it('handles interleaved test data in reverse order', () => {
    const points = [
      makePoint('test-A', '102', 3.0),
      makePoint('test-B', '102', 6.0),
      makePoint('test-A', '101', 2.0),
      makePoint('test-B', '101', 5.0),
      makePoint('test-A', '100', 1.0),
      makePoint('test-B', '100', 4.0),
    ];

    const traces = buildTraces(points, '', 'median', 'median');
    expect(traces).toHaveLength(2);
    // test-A comes first alphabetically
    expect(traces[0].testName).toBe('test-A');
    expect(traces[0].points.map(p => p.orderValue)).toEqual(['102', '101', '100']);
    expect(traces[1].testName).toBe('test-B');
    expect(traces[1].points.map(p => p.orderValue)).toEqual(['102', '101', '100']);
  });
});

describe('computeActiveTests', () => {
  const names = ['alpha', 'beta', 'charlie', 'delta', 'echo',
    'foxtrot', 'golf', 'hotel', 'india', 'juliet',
    'kilo', 'lima', 'mike', 'november', 'oscar',
    'papa', 'quebec', 'romeo', 'sierra', 'tango',
    'uniform', 'victor', 'whiskey'];

  it('caps at 20 when autoCapped=true and no filter/hidden', () => {
    const active = computeActiveTests(names, '', new Set(), true);
    expect(active.size).toBe(20);
    expect(active.has('alpha')).toBe(true);
    expect(active.has('tango')).toBe(true);  // 20th
    expect(active.has('uniform')).toBe(false);  // 21st
  });

  it('disables cap when filter is non-empty', () => {
    const active = computeActiveTests(names, 'a', new Set(), true);
    // 'alpha', 'charlie', 'delta', 'tango', 'papa', 'sierra', 'whiskey' — all with 'a'
    for (const n of names) {
      if (n.toLowerCase().includes('a')) {
        expect(active.has(n)).toBe(true);
      } else {
        expect(active.has(n)).toBe(false);
      }
    }
  });

  it('removes manually hidden tests', () => {
    const hidden = new Set(['beta', 'charlie']);
    const active = computeActiveTests(names, '', hidden, false);
    expect(active.has('alpha')).toBe(true);
    expect(active.has('beta')).toBe(false);
    expect(active.has('charlie')).toBe(false);
    expect(active.has('delta')).toBe(true);
  });

  it('cap is disabled when manuallyHidden is non-empty', () => {
    const hidden = new Set(['alpha']);
    // autoCapped=true but hidden is non-empty → cap disabled
    const active = computeActiveTests(names, '', hidden, true);
    // All names except 'alpha' should be active (no 20-cap)
    expect(active.size).toBe(names.length - 1);
    expect(active.has('alpha')).toBe(false);
    expect(active.has('uniform')).toBe(true);  // would be capped otherwise
  });

  it('returns empty set for empty input', () => {
    const active = computeActiveTests([], '', new Set(), true);
    expect(active.size).toBe(0);
  });

  it('double-click isolation is just manuallyHidden with all others hidden', () => {
    // Simulates what onIsolate does: hide all except 'charlie'
    const hidden = new Set(names.filter(n => n !== 'charlie'));
    const active = computeActiveTests(names, '', hidden, false);
    expect(active.size).toBe(1);
    expect(active.has('charlie')).toBe(true);
  });

  it('after isolation, single-click unhide works naturally', () => {
    // After isolating 'charlie', user single-clicks 'alpha' to unhide it
    const hidden = new Set(names.filter(n => n !== 'charlie'));
    hidden.delete('alpha');
    const active = computeActiveTests(names, '', hidden, false);
    expect(active.size).toBe(2);
    expect(active.has('charlie')).toBe(true);
    expect(active.has('alpha')).toBe(true);
  });

  it('filters multi-machine trace names by test name portion only', () => {
    const traceNames = [
      `compile/test-A${TRACE_SEP}clang-x86`,
      `compile/test-A${TRACE_SEP}gcc-arm`,
      `exec/test-B${TRACE_SEP}clang-x86`,
      `exec/test-B${TRACE_SEP}gcc-arm`,
    ];
    const active = computeActiveTests(traceNames, 'compile', new Set(), false);
    expect(active.size).toBe(2);
    expect(active.has(`compile/test-A${TRACE_SEP}clang-x86`)).toBe(true);
    expect(active.has(`compile/test-A${TRACE_SEP}gcc-arm`)).toBe(true);
    expect(active.has(`exec/test-B${TRACE_SEP}clang-x86`)).toBe(false);
  });

  it('filter does not match machine name', () => {
    const traceNames = [
      `test-A${TRACE_SEP}clang-x86`,
      `test-A${TRACE_SEP}gcc-arm`,
    ];
    const active = computeActiveTests(traceNames, 'clang', new Set(), false);
    expect(active.size).toBe(0);
  });
});

describe('buildRefsFromCache', () => {
  function makeRefPoint(test: string, orderValue: string, value: number, machine = 'm1'): QueryDataPoint {
    return {
      test,
      machine,
      metric: 'exec_time',
      value,
      order: { rev: orderValue },
      run_uuid: 'r1',
      timestamp: null,
    };
  }

  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  const mean = (values: number[]): number =>
    values.reduce((s, v) => s + v, 0) / values.length;

  it('aggregates multiple runs at pinned order using the provided agg function', () => {
    const points = [
      makeRefPoint('test-A', '100', 1.0),
      makeRefPoint('test-A', '100', 3.0),
      makeRefPoint('test-A', '100', 5.0),
    ];
    const refs = [{ value: '100', tag: null }];

    const result = buildRefsFromCache(points, refs, median);

    expect(result).toHaveLength(1);
    expect(result[0].values.get('test-A')).toBe(3.0); // median of [1, 3, 5]
  });

  it('uses the same agg as buildTraces (consistency check)', () => {
    const points = [
      makeRefPoint('test-A', '100', 1.0),
      makeRefPoint('test-A', '100', 3.0),
      makeRefPoint('test-A', '100', 5.0),
    ];
    const refs = [{ value: '100', tag: null }];

    const pinResult = buildRefsFromCache(points, refs, median);
    const traces = buildTraces(points, '', 'median', 'median');

    // Both should produce exactly the same value for test-A at order 100
    const traceValue = traces.find(t => t.testName === 'test-A')!.points
      .find(p => p.orderValue === '100')!.value;
    expect(pinResult[0].values.get('test-A')).toBe(traceValue);
  });

  it('uses mean aggregation when provided', () => {
    const points = [
      makeRefPoint('test-A', '100', 1.0),
      makeRefPoint('test-A', '100', 3.0),
    ];
    const refs = [{ value: '100', tag: null }];

    const result = buildRefsFromCache(points, refs, mean);

    expect(result[0].values.get('test-A')).toBe(2.0); // mean of [1, 3]
  });

  it('handles single data point (no aggregation needed)', () => {
    const points = [makeRefPoint('test-A', '100', 42.0)];
    const refs = [{ value: '100', tag: null }];

    const result = buildRefsFromCache(points, refs, median);

    expect(result[0].values.get('test-A')).toBe(42.0);
  });

  it('handles multiple tests at the same pinned order', () => {
    const points = [
      makeRefPoint('test-A', '100', 1.0),
      makeRefPoint('test-A', '100', 3.0),
      makeRefPoint('test-B', '100', 10.0),
      makeRefPoint('test-B', '100', 20.0),
    ];
    const refs = [{ value: '100', tag: null }];

    const result = buildRefsFromCache(points, refs, median);

    expect(result[0].values.get('test-A')).toBe(2.0); // median of [1, 3]
    expect(result[0].values.get('test-B')).toBe(15.0); // median of [10, 20]
  });

  it('handles multiple pinned orders', () => {
    const points = [
      makeRefPoint('test-A', '100', 1.0),
      makeRefPoint('test-A', '101', 5.0),
    ];
    const refs = [
      { value: '100', tag: 'v1' },
      { value: '101', tag: null },
    ];

    const result = buildRefsFromCache(points, refs, median);

    expect(result).toHaveLength(2);
    expect(result[0].values.get('test-A')).toBe(1.0);
    expect(result[0].tag).toBe('v1');
    expect(result[1].values.get('test-A')).toBe(5.0);
    expect(result[1].tag).toBeNull();
  });

  it('returns empty values map when pinned order has no matching data', () => {
    const points = [makeRefPoint('test-A', '100', 1.0)];
    const refs = [{ value: '999', tag: null }];

    const result = buildRefsFromCache(points, refs, median);

    expect(result).toHaveLength(1);
    expect(result[0].values.size).toBe(0);
  });

  it('returns empty array when no refs provided', () => {
    const points = [makeRefPoint('test-A', '100', 1.0)];
    const result = buildRefsFromCache(points, [], median);
    expect(result).toHaveLength(0);
  });

  it('assigns distinct colors from PIN_COLORS to each pinned order', () => {
    const points = [
      makeRefPoint('test-A', '100', 1.0),
      makeRefPoint('test-A', '101', 2.0),
    ];
    const refs = [
      { value: '100', tag: null },
      { value: '101', tag: null },
    ];

    const result = buildRefsFromCache(points, refs, median);

    expect(result[0].color).not.toBe(result[1].color);
  });
});

describe('setsEqual', () => {
  it('returns true for two empty sets', () => {
    expect(setsEqual(new Set(), new Set())).toBe(true);
  });

  it('returns true for identical sets', () => {
    expect(setsEqual(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'c']))).toBe(true);
  });

  it('returns true regardless of insertion order', () => {
    expect(setsEqual(new Set(['c', 'a', 'b']), new Set(['b', 'c', 'a']))).toBe(true);
  });

  it('returns false when sizes differ', () => {
    expect(setsEqual(new Set(['a', 'b']), new Set(['a', 'b', 'c']))).toBe(false);
  });

  it('returns false when same size but different elements', () => {
    expect(setsEqual(new Set(['a', 'b']), new Set(['a', 'c']))).toBe(false);
  });

  it('returns false when one set is empty', () => {
    expect(setsEqual(new Set(), new Set(['a']))).toBe(false);
    expect(setsEqual(new Set(['a']), new Set())).toBe(false);
  });
});
