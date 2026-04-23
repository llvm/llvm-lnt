// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { decodeGraphState, encodeGraphState, replaceGraphUrl } from '../../../pages/graph/state';
import type { GraphState } from '../../../pages/graph/state';

function makeDefault(): GraphState {
  return {
    suite: '',
    machines: [],
    metric: '',
    testFilter: '',
    runAgg: 'median',
    sampleAgg: 'median',
    baselines: [],
    regressionMode: 'off',
  };
}

describe('decodeGraphState', () => {
  it('returns defaults for empty search string', () => {
    expect(decodeGraphState('')).toEqual(makeDefault());
  });

  it('returns defaults for "?"', () => {
    expect(decodeGraphState('?')).toEqual(makeDefault());
  });

  it('parses suite and metric', () => {
    const state = decodeGraphState('?suite=nts&metric=exec_time');
    expect(state.suite).toBe('nts');
    expect(state.metric).toBe('exec_time');
  });

  it('parses single machine', () => {
    const state = decodeGraphState('?machine=host1');
    expect(state.machines).toEqual(['host1']);
  });

  it('parses multiple machines (repeated param)', () => {
    const state = decodeGraphState('?machine=host1&machine=host2&machine=host3');
    expect(state.machines).toEqual(['host1', 'host2', 'host3']);
  });

  it('filters empty machine values', () => {
    const state = decodeGraphState('?machine=host1&machine=&machine=host2');
    expect(state.machines).toEqual(['host1', 'host2']);
  });

  it('parses test_filter', () => {
    const state = decodeGraphState('?test_filter=benchmark');
    expect(state.testFilter).toBe('benchmark');
  });

  it('parses aggregation functions', () => {
    const state = decodeGraphState('?run_agg=mean&sample_agg=max');
    expect(state.runAgg).toBe('mean');
    expect(state.sampleAgg).toBe('max');
  });

  it('defaults invalid aggregation to median', () => {
    const state = decodeGraphState('?run_agg=invalid&sample_agg=bogus');
    expect(state.runAgg).toBe('median');
    expect(state.sampleAgg).toBe('median');
  });

  it('parses single baseline', () => {
    const state = decodeGraphState('?baseline=nts::machine1::abc123');
    expect(state.baselines).toEqual([
      { suite: 'nts', machine: 'machine1', commit: 'abc123' },
    ]);
  });

  it('parses multiple baselines', () => {
    const state = decodeGraphState(
      '?baseline=nts::m1::c1&baseline=other::m2::c2',
    );
    expect(state.baselines).toHaveLength(2);
    expect(state.baselines[0]).toEqual({ suite: 'nts', machine: 'm1', commit: 'c1' });
    expect(state.baselines[1]).toEqual({ suite: 'other', machine: 'm2', commit: 'c2' });
  });

  it('skips malformed baselines', () => {
    const state = decodeGraphState(
      '?baseline=nts::m1::c1&baseline=bad_format&baseline=::m2::',
    );
    expect(state.baselines).toHaveLength(1);
    expect(state.baselines[0]).toEqual({ suite: 'nts', machine: 'm1', commit: 'c1' });
  });

  it('parses regressionMode', () => {
    expect(decodeGraphState('?regressions=active').regressionMode).toBe('active');
    expect(decodeGraphState('?regressions=all').regressionMode).toBe('all');
    expect(decodeGraphState('?regressions=off').regressionMode).toBe('off');
  });

  it('defaults invalid regressionMode to off', () => {
    expect(decodeGraphState('?regressions=bogus').regressionMode).toBe('off');
  });

  it('parses a full URL with all params', () => {
    const state = decodeGraphState(
      '?suite=nts&machine=m1&machine=m2&metric=exec_time&test_filter=bench' +
      '&run_agg=mean&sample_agg=min&baseline=nts::m1::c1&regressions=active',
    );
    expect(state.suite).toBe('nts');
    expect(state.machines).toEqual(['m1', 'm2']);
    expect(state.metric).toBe('exec_time');
    expect(state.testFilter).toBe('bench');
    expect(state.runAgg).toBe('mean');
    expect(state.sampleAgg).toBe('min');
    expect(state.baselines).toEqual([{ suite: 'nts', machine: 'm1', commit: 'c1' }]);
    expect(state.regressionMode).toBe('active');
  });
});

describe('encodeGraphState', () => {
  it('returns empty string for default state', () => {
    expect(encodeGraphState(makeDefault())).toBe('');
  });

  it('encodes suite and metric', () => {
    const state = { ...makeDefault(), suite: 'nts', metric: 'exec_time' };
    const search = encodeGraphState(state);
    expect(search).toContain('suite=nts');
    expect(search).toContain('metric=exec_time');
  });

  it('encodes multiple machines', () => {
    const state = { ...makeDefault(), machines: ['m1', 'm2'] };
    const search = encodeGraphState(state);
    expect(search).toContain('machine=m1');
    expect(search).toContain('machine=m2');
  });

  it('omits default aggregation', () => {
    const state = { ...makeDefault(), suite: 'nts' };
    const search = encodeGraphState(state);
    expect(search).not.toContain('run_agg');
    expect(search).not.toContain('sample_agg');
  });

  it('includes non-default aggregation', () => {
    const state = { ...makeDefault(), runAgg: 'mean' as const, sampleAgg: 'max' as const };
    const search = encodeGraphState(state);
    expect(search).toContain('run_agg=mean');
    expect(search).toContain('sample_agg=max');
  });

  it('omits regression mode when off (default)', () => {
    const state = { ...makeDefault(), suite: 'nts' };
    const search = encodeGraphState(state);
    expect(search).not.toContain('regressions');
  });

  it('includes regression mode when not off', () => {
    const state = { ...makeDefault(), regressionMode: 'active' as const };
    const search = encodeGraphState(state);
    expect(search).toContain('regressions=active');
  });

  it('encodes baselines', () => {
    const state = {
      ...makeDefault(),
      baselines: [
        { suite: 'nts', machine: 'm1', commit: 'c1' },
        { suite: 'other', machine: 'm2', commit: 'c2' },
      ],
    };
    const search = encodeGraphState(state);
    expect(search).toContain('baseline=nts%3A%3Am1%3A%3Ac1');
    expect(search).toContain('baseline=other%3A%3Am2%3A%3Ac2');
  });

  it('omits empty suite and metric', () => {
    const search = encodeGraphState(makeDefault());
    expect(search).not.toContain('suite=');
    expect(search).not.toContain('metric=');
  });
});

describe('encode/decode round-trip', () => {
  it('round-trips a full state', () => {
    const original: GraphState = {
      suite: 'nts',
      machines: ['m1', 'm2'],
      metric: 'exec_time',
      testFilter: 'bench',
      runAgg: 'mean',
      sampleAgg: 'min',
      baselines: [{ suite: 'nts', machine: 'm1', commit: 'c1' }],
      regressionMode: 'active',
    };
    const encoded = encodeGraphState(original);
    const decoded = decodeGraphState(encoded);
    expect(decoded).toEqual(original);
  });

  it('round-trips default state', () => {
    const original = makeDefault();
    const encoded = encodeGraphState(original);
    const decoded = decodeGraphState(encoded);
    expect(decoded).toEqual(original);
  });

  it('round-trips state with only suite', () => {
    const original = { ...makeDefault(), suite: 'nts' };
    const encoded = encodeGraphState(original);
    const decoded = decodeGraphState(encoded);
    expect(decoded).toEqual(original);
  });
});

describe('replaceGraphUrl', () => {
  it('calls history.replaceState with encoded URL', () => {
    const state = { ...makeDefault(), suite: 'nts', metric: 'exec_time' };
    replaceGraphUrl(state);
    expect(window.location.search).toContain('suite=nts');
    expect(window.location.search).toContain('metric=exec_time');
  });
});
