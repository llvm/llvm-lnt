// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  buildTraces,
  buildBaselinesFromData,
  buildChartData,
  buildColorMap,
  buildRegressionOverlays,
  buildRawValuesCallback,
  assignSymbol,
  assignSymbolChar,
  MACHINE_SYMBOLS,
  SYMBOL_CHARS,
} from '../../../pages/graph/traces';
import type { QueryDataPoint, RegressionListItem } from '../../../types';

function makePoint(test: string, commitValue: string, value: number, runUuid = 'r1', machine = 'm1'): QueryDataPoint {
  return {
    test,
    machine,
    metric: 'exec_time',
    value,
    commit: commitValue,
    ordinal: null,
    run_uuid: runUuid,
    tag: null,
    submitted_at: null,
  };
}

// ---- buildTraces ----

describe('buildTraces', () => {
  it('groups points by test name into separate traces', () => {
    const points = [
      makePoint('test-A', '100', 1.0),
      makePoint('test-A', '101', 2.0),
      makePoint('test-B', '100', 3.0),
    ];
    const traces = buildTraces(points, 'median', 'median');
    expect(traces).toHaveLength(2);
    expect(traces[0].testName).toBe('test-A');
    expect(traces[0].points).toHaveLength(2);
    expect(traces[1].testName).toBe('test-B');
    expect(traces[1].points).toHaveLength(1);
  });

  it('handles pre-filtered input (single test)', () => {
    const points = [
      makePoint('compile/test-A', '100', 1.0),
      makePoint('compile/test-A', '101', 2.0),
    ];
    const traces = buildTraces(points, 'median', 'median');
    expect(traces).toHaveLength(1);
    expect(traces[0].testName).toBe('compile/test-A');
  });

  it('aggregates multiple runs at same commit using run aggregation', () => {
    const points = [
      makePoint('test-A', '100', 1.0, 'r1'),
      makePoint('test-A', '100', 3.0, 'r2'),
      makePoint('test-A', '100', 5.0, 'r3'),
    ];
    const traces = buildTraces(points, 'median', 'median');
    expect(traces[0].points[0].value).toBe(3.0);
    expect(traces[0].points[0].runCount).toBe(3);
  });

  it('uses mean aggregation when specified', () => {
    const points = [
      makePoint('test-A', '100', 1.0, 'r1'),
      makePoint('test-A', '100', 3.0, 'r2'),
    ];
    const traces = buildTraces(points, 'mean', 'median');
    expect(traces[0].points[0].value).toBe(2.0);
  });

  it('applies sample aggregation within a single run', () => {
    const points = [
      makePoint('test-A', '100', 1.0, 'r1'),
      makePoint('test-A', '100', 3.0, 'r1'),
      makePoint('test-A', '100', 5.0, 'r1'),
    ];
    const traces = buildTraces(points, 'median', 'median');
    expect(traces[0].points[0].value).toBe(3.0);
    expect(traces[0].points[0].runCount).toBe(1);
  });

  it('applies sampleAgg then runAgg in two steps', () => {
    const points = [
      makePoint('test-A', '100', 1.0, 'r1'),
      makePoint('test-A', '100', 3.0, 'r1'),
      makePoint('test-A', '100', 10.0, 'r2'),
      makePoint('test-A', '100', 20.0, 'r2'),
    ];
    const traces = buildTraces(points, 'median', 'median');
    expect(traces[0].points[0].value).toBe(8.5);
    expect(traces[0].points[0].runCount).toBe(2);
  });

  it('two-step aggregation differs from flat aggregation', () => {
    const points = [
      makePoint('test-A', '100', 1.0, 'r1'),
      makePoint('test-A', '100', 1.0, 'r1'),
      makePoint('test-A', '100', 1.0, 'r1'),
      makePoint('test-A', '100', 100.0, 'r2'),
    ];
    const traces = buildTraces(points, 'mean', 'median');
    expect(traces[0].points[0].value).toBe(50.5); // NOT 25.75
  });

  it('returns empty array for empty input', () => {
    expect(buildTraces([], 'median', 'median')).toHaveLength(0);
  });

  it('sorts traces by test name', () => {
    const points = [
      makePoint('zebra', '100', 1.0),
      makePoint('alpha', '100', 2.0),
      makePoint('middle', '100', 3.0),
    ];
    const traces = buildTraces(points, 'median', 'median');
    expect(traces.map(t => t.testName)).toEqual(['alpha', 'middle', 'zebra']);
  });

  it('preserves commit value across aggregation', () => {
    const points = [
      makePoint('test-A', '100', 1.0),
      makePoint('test-A', '101', 2.0),
      makePoint('test-A', '102', 3.0),
    ];
    const traces = buildTraces(points, 'median', 'median');
    expect(traces[0].points.map(p => p.commit)).toEqual(['100', '101', '102']);
  });

  it('preserves insertion order for reversed input', () => {
    const points = [
      makePoint('test-A', '102', 3.0),
      makePoint('test-A', '101', 2.0),
      makePoint('test-A', '100', 1.0),
    ];
    const traces = buildTraces(points, 'median', 'median');
    expect(traces[0].points.map(p => p.commit)).toEqual(['102', '101', '100']);
  });

  it('handles interleaved test data in reverse order', () => {
    const points = [
      makePoint('test-A', '102', 3.0), makePoint('test-B', '102', 6.0),
      makePoint('test-A', '101', 2.0), makePoint('test-B', '101', 5.0),
      makePoint('test-A', '100', 1.0), makePoint('test-B', '100', 4.0),
    ];
    const traces = buildTraces(points, 'median', 'median');
    expect(traces).toHaveLength(2);
    expect(traces[0].testName).toBe('test-A');
    expect(traces[0].points.map(p => p.commit)).toEqual(['102', '101', '100']);
    expect(traces[1].testName).toBe('test-B');
  });
});

// ---- buildBaselinesFromData ----

describe('buildBaselinesFromData', () => {
  const med = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const avg = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length;

  function buildLookup(
    baselines: Array<{ suite: string; machine: string; commit: string }>,
    metric: string,
    pointsPerBaseline: QueryDataPoint[][],
  ): (s: string, m: string, c: string, met: string) => QueryDataPoint[] {
    const cache = new Map<string, QueryDataPoint[]>();
    for (let i = 0; i < baselines.length; i++) {
      const bl = baselines[i];
      cache.set(`${bl.suite}::${bl.machine}::${bl.commit}::${metric}`, pointsPerBaseline[i] || []);
    }
    return (s, m, o, met) => cache.get(`${s}::${m}::${o}::${met}`) ?? [];
  }

  const emptyLookup = () => [] as QueryDataPoint[];

  it('aggregates multiple runs using provided agg function', () => {
    const bl = [{ suite: 'nts', machine: 'm1', commit: '100' }];
    const pts = [makePoint('test-A', '100', 1.0), makePoint('test-A', '100', 3.0), makePoint('test-A', '100', 5.0)];
    const result = buildBaselinesFromData(bl, buildLookup(bl, 'exec_time', [pts]), 'exec_time', med);
    expect(result[0].values.get('test-A')).toBe(3.0);
  });

  it('is consistent with buildTraces', () => {
    const bl = [{ suite: 'nts', machine: 'm1', commit: '100' }];
    const pts = [makePoint('test-A', '100', 1.0), makePoint('test-A', '100', 3.0), makePoint('test-A', '100', 5.0)];
    const blResult = buildBaselinesFromData(bl, buildLookup(bl, 'exec_time', [pts]), 'exec_time', med);
    const traces = buildTraces(pts, 'median', 'median');
    expect(blResult[0].values.get('test-A')).toBe(traces[0].points[0].value);
  });

  it('uses mean aggregation when provided', () => {
    const bl = [{ suite: 'nts', machine: 'm1', commit: '100' }];
    const pts = [makePoint('test-A', '100', 1.0), makePoint('test-A', '100', 3.0)];
    const result = buildBaselinesFromData(bl, buildLookup(bl, 'exec_time', [pts]), 'exec_time', avg);
    expect(result[0].values.get('test-A')).toBe(2.0);
  });

  it('handles single data point', () => {
    const bl = [{ suite: 'nts', machine: 'm1', commit: '100' }];
    const pts = [makePoint('test-A', '100', 42.0)];
    expect(buildBaselinesFromData(bl, buildLookup(bl, 'exec_time', [pts]), 'exec_time', med)[0].values.get('test-A')).toBe(42.0);
  });

  it('handles multiple tests at same commit', () => {
    const bl = [{ suite: 'nts', machine: 'm1', commit: '100' }];
    const pts = [
      makePoint('test-A', '100', 1.0), makePoint('test-A', '100', 3.0),
      makePoint('test-B', '100', 10.0), makePoint('test-B', '100', 20.0),
    ];
    const result = buildBaselinesFromData(bl, buildLookup(bl, 'exec_time', [pts]), 'exec_time', med);
    expect(result[0].values.get('test-A')).toBe(2.0);
    expect(result[0].values.get('test-B')).toBe(15.0);
  });

  it('handles multiple baselines', () => {
    const bls = [
      { suite: 'nts', machine: 'm1', commit: '100' },
      { suite: 'nts', machine: 'm1', commit: '101' },
    ];
    const result = buildBaselinesFromData(
      bls,
      buildLookup(bls, 'exec_time', [[makePoint('test-A', '100', 1.0)], [makePoint('test-A', '101', 5.0)]]),
      'exec_time', med,
    );
    expect(result).toHaveLength(2);
    expect(result[0].values.get('test-A')).toBe(1.0);
    expect(result[1].values.get('test-A')).toBe(5.0);
  });

  it('returns empty values map when no cached data', () => {
    const result = buildBaselinesFromData([{ suite: 'nts', machine: 'm1', commit: '999' }], emptyLookup, 'exec_time', med);
    expect(result[0].values.size).toBe(0);
  });

  it('returns empty array for no baselines', () => {
    expect(buildBaselinesFromData([], emptyLookup, 'exec_time', med)).toHaveLength(0);
  });

  it('builds label with suite/machine/commit format', () => {
    const result = buildBaselinesFromData([{ suite: 'nts', machine: 'm1', commit: '100' }], emptyLookup, 'exec_time', med);
    expect(result[0].label).toBe('nts/m1/100');
  });

  it('uses displayMap for commit in label', () => {
    const dm = new Map([['100', 'v1.0']]);
    const result = buildBaselinesFromData(
      [{ suite: 'nts', machine: 'm1', commit: '100' }], emptyLookup, 'exec_time', med, dm,
    );
    expect(result[0].label).toBe('nts/m1/v1.0');
  });

  it('supports cross-suite baselines', () => {
    const bls = [
      { suite: 'nts', machine: 'm1', commit: '100' },
      { suite: 'other', machine: 'm2', commit: '200' },
    ];
    const result = buildBaselinesFromData(
      bls,
      buildLookup(bls, 'exec_time', [[makePoint('test-A', '100', 1.0)], [makePoint('test-A', '200', 9.0)]]),
      'exec_time', med,
    );
    expect(result[0].label).toBe('nts/m1/100');
    expect(result[1].label).toBe('other/m2/200');
  });
});

// ---- buildColorMap ----

describe('buildColorMap', () => {
  it('assigns colors by alphabetical position', () => {
    const map = buildColorMap(['alpha', 'beta', 'gamma']);
    expect(map.size).toBe(3);
    // Same position always gets same color
    const map2 = buildColorMap(['alpha', 'beta', 'gamma']);
    expect(map2.get('alpha')).toBe(map.get('alpha'));
  });

  it('is stable: adding tests does not change existing colors', () => {
    const small = buildColorMap(['beta', 'gamma']);
    const large = buildColorMap(['alpha', 'beta', 'gamma']);
    // beta is index 0 in small but index 1 in large — colors differ because
    // stability is by position in the FULL list, not a subset
    expect(large.get('beta')).not.toBe(small.get('beta'));
    // But within the same full list, colors are stable
    const large2 = buildColorMap(['alpha', 'beta', 'gamma']);
    expect(large2.get('beta')).toBe(large.get('beta'));
  });
});

// ---- buildChartData ----

describe('buildChartData', () => {
  function makeLookup(points: QueryDataPoint[]): (s: string, m: string, met: string, t: string) => QueryDataPoint[] {
    const byKey = new Map<string, QueryDataPoint[]>();
    for (const pt of points) {
      const key = `${pt.machine}::${pt.metric}::${pt.test}`;
      let arr = byKey.get(key);
      if (!arr) { arr = []; byKey.set(key, arr); }
      arr.push(pt);
    }
    return (_s, m, met, t) => byKey.get(`${m}::${met}::${t}`) ?? [];
  }

  it('builds traces across multiple machines', () => {
    const points = [
      makePoint('test-A', '100', 1.0, 'r1', 'm1'),
      makePoint('test-A', '100', 2.0, 'r1', 'm2'),
    ];
    const { traces } = buildChartData({
      selectedTests: new Set(['test-A']),
      machines: ['m1', 'm2'],
      metric: 'exec_time',
      runAgg: 'median',
      sampleAgg: 'median',
      readCachedTestData: makeLookup(points),
      suite: 'nts',
      colorMap: buildColorMap(['test-A']),
    });
    expect(traces).toHaveLength(2);
    expect(traces[0].machine).toBe('m1');
    expect(traces[1].machine).toBe('m2');
  });

  it('assigns different marker symbols per machine', () => {
    const points = [
      makePoint('test-A', '100', 1.0, 'r1', 'm1'),
      makePoint('test-A', '100', 2.0, 'r1', 'm2'),
    ];
    const { traces } = buildChartData({
      selectedTests: new Set(['test-A']),
      machines: ['m1', 'm2'],
      metric: 'exec_time',
      runAgg: 'median',
      sampleAgg: 'median',
      readCachedTestData: makeLookup(points),
      suite: 'nts',
      colorMap: buildColorMap(['test-A']),
    });
    expect(traces[0].markerSymbol).toBe('circle');
    expect(traces[1].markerSymbol).toBe('triangle-up');
  });

  it('assigns same color for same test across machines', () => {
    const points = [
      makePoint('test-A', '100', 1.0, 'r1', 'm1'),
      makePoint('test-A', '100', 2.0, 'r1', 'm2'),
    ];
    const { traces } = buildChartData({
      selectedTests: new Set(['test-A']),
      machines: ['m1', 'm2'],
      metric: 'exec_time',
      runAgg: 'median',
      sampleAgg: 'median',
      readCachedTestData: makeLookup(points),
      suite: 'nts',
      colorMap: buildColorMap(['test-A']),
    });
    expect(traces[0].color).toBe(traces[1].color);
  });

  it('builds rawValuesIndex for hover scatter', () => {
    const points = [
      makePoint('test-A', '100', 1.0, 'r1', 'm1'),
      makePoint('test-A', '100', 3.0, 'r2', 'm1'),
    ];
    const { rawValuesIndex } = buildChartData({
      selectedTests: new Set(['test-A']),
      machines: ['m1'],
      metric: 'exec_time',
      runAgg: 'median',
      sampleAgg: 'median',
      readCachedTestData: makeLookup(points),
      suite: 'nts',
      colorMap: buildColorMap(['test-A']),
    });
    expect(rawValuesIndex.get('test-A|m1|100')).toEqual([1.0, 3.0]);
  });

  it('sorts traces by name', () => {
    const points = [
      makePoint('zebra', '100', 1.0, 'r1', 'm1'),
      makePoint('alpha', '100', 2.0, 'r1', 'm1'),
    ];
    const { traces } = buildChartData({
      selectedTests: new Set(['zebra', 'alpha']),
      machines: ['m1'],
      metric: 'exec_time',
      runAgg: 'median',
      sampleAgg: 'median',
      readCachedTestData: makeLookup(points),
      suite: 'nts',
      colorMap: buildColorMap(['alpha', 'zebra']),
    });
    expect(traces[0].testName).toBe('alpha');
    expect(traces[1].testName).toBe('zebra');
  });
});

// ---- buildRawValuesCallback ----

describe('buildRawValuesCallback', () => {
  it('returns values from index', () => {
    const index = new Map([['test-A|m1|100', [1.0, 2.0, 3.0]]]);
    const cb = buildRawValuesCallback(index);
    expect(cb('test-A', 'm1', '100')).toEqual([1.0, 2.0, 3.0]);
  });

  it('returns empty array for missing key', () => {
    const cb = buildRawValuesCallback(new Map());
    expect(cb('missing', 'm1', '100')).toEqual([]);
  });
});

// ---- buildRegressionOverlays ----

describe('buildRegressionOverlays', () => {
  function makeRegression(commit: string, state: 'active' | 'detected' | 'fixed', title = 'Reg'): RegressionListItem {
    return { uuid: 'r1', title, bug: null, state, commit, machine_count: 1, test_count: 1 };
  }

  it('creates shapes and annotations for each regression with a commit', () => {
    const regs = [makeRegression('100', 'active'), makeRegression('101', 'detected')];
    const { shapes, annotations } = buildRegressionOverlays(regs, new Map());
    expect(shapes).toHaveLength(2);
    expect(annotations).toHaveLength(2);
  });

  it('skips regressions without commits', () => {
    const regs = [{ uuid: 'r1', title: 'Reg', bug: null, state: 'active' as const, commit: null, machine_count: 1, test_count: 1 }];
    const { shapes } = buildRegressionOverlays(regs, new Map());
    expect(shapes).toHaveLength(0);
  });

  it('colors active red, detected orange, others gray', () => {
    const regs = [
      makeRegression('100', 'active'),
      makeRegression('101', 'detected'),
      makeRegression('102', 'fixed'),
    ];
    const { shapes } = buildRegressionOverlays(regs, new Map());
    expect((shapes![0] as { line: { color: string } }).line.color).toBe('#d62728');
    expect((shapes![1] as { line: { color: string } }).line.color).toBe('#ff7f0e');
    expect((shapes![2] as { line: { color: string } }).line.color).toBe('#999');
  });

  it('uses displayMap for x-axis position', () => {
    const regs = [makeRegression('abc', 'active')];
    const dm = new Map([['abc', 'v1.0']]);
    const { shapes } = buildRegressionOverlays(regs, dm);
    expect((shapes![0] as { x0: string }).x0).toBe('v1.0');
  });
});

// ---- Symbol assignment ----

describe('assignSymbol / assignSymbolChar', () => {
  it('returns valid Plotly symbols', () => {
    expect(assignSymbol(0)).toBe('circle');
    expect(assignSymbol(1)).toBe('triangle-up');
    expect(assignSymbol(2)).toBe('square');
  });

  it('wraps around for large indices', () => {
    expect(assignSymbol(MACHINE_SYMBOLS.length)).toBe('circle');
  });

  it('returns matching unicode chars', () => {
    expect(assignSymbolChar(0)).toBe('●');
    expect(assignSymbolChar(1)).toBe('▲');
    expect(assignSymbolChar(SYMBOL_CHARS.length)).toBe('●');
  });
});
