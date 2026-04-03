// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { encodeToUrl, decodeFromUrl, applyUrlState, getState, setState, setSideA, setSideB, swapSides, replaceUrl } from '../state';
import type { AppState } from '../types';

function makeDefaults(): AppState {
  return {
    sideA: { order: '', machine: '', runs: [], runAgg: 'median' },
    sideB: { order: '', machine: '', runs: [], runAgg: 'median' },
    metric: '',
    sampleAgg: 'median',
    noise: 1,
    sort: 'delta_pct',
    sortDir: 'desc',
    testFilter: '',
    hideNoise: false,
  };
}

describe('encodeToUrl', () => {
  it('returns empty string for all defaults', () => {
    expect(encodeToUrl(makeDefaults())).toBe('');
  });

  it('includes non-default values', () => {
    const state = makeDefaults();
    state.sideA.order = 'rev123';
    state.sideA.machine = 'machine-a';
    state.sideA.runs = ['uuid-1'];
    state.sideB.order = 'rev456';
    state.sideB.machine = 'machine-b';
    state.sideB.runs = ['uuid-2', 'uuid-3'];
    state.sideB.runAgg = 'mean';
    state.metric = 'exec_time';
    state.sampleAgg = 'min';
    state.noise = 2.5;
    state.sort = 'ratio';
    state.sortDir = 'asc';
    state.testFilter = 'bench';
    state.hideNoise = true;

    const qs = encodeToUrl(state);
    const params = new URLSearchParams(qs);

    expect(params.get('order_a')).toBe('rev123');
    expect(params.get('machine_a')).toBe('machine-a');
    expect(params.get('runs_a')).toBe('uuid-1');
    expect(params.get('order_b')).toBe('rev456');
    expect(params.get('machine_b')).toBe('machine-b');
    expect(params.get('runs_b')).toBe('uuid-2,uuid-3');
    expect(params.get('run_agg_b')).toBe('mean');
    expect(params.get('metric')).toBe('exec_time');
    expect(params.get('sample_agg')).toBe('min');
    expect(params.get('noise')).toBe('2.5');
    expect(params.get('sort')).toBe('ratio');
    expect(params.get('sort_dir')).toBe('asc');
    expect(params.get('test_filter')).toBe('bench');
    expect(params.get('hide_noise')).toBe('1');
  });

  it('omits default runAgg (median)', () => {
    const state = makeDefaults();
    state.sideA.order = 'rev';
    state.sideA.runAgg = 'median';
    const params = new URLSearchParams(encodeToUrl(state));
    expect(params.has('run_agg_a')).toBe(false);
  });

  it('omits noise when it equals default (1)', () => {
    const state = makeDefaults();
    state.noise = 1;
    state.metric = 'x'; // need something non-default to generate output
    const params = new URLSearchParams(encodeToUrl(state));
    expect(params.has('noise')).toBe(false);
  });

  it('includes noise when non-default', () => {
    const state = makeDefaults();
    state.noise = 2.5;
    const params = new URLSearchParams(encodeToUrl(state));
    expect(params.get('noise')).toBe('2.5');
  });
});

describe('decodeFromUrl', () => {
  it('returns empty object for empty query string', () => {
    const result = decodeFromUrl('');
    expect(result).toEqual({});
  });

  it('decodes side A parameters', () => {
    const result = decodeFromUrl('?order_a=rev123&machine_a=machine-a&runs_a=uuid-1');
    expect(result.sideA?.order).toBe('rev123');
    expect(result.sideA?.machine).toBe('machine-a');
    expect(result.sideA?.runs).toEqual(['uuid-1']);
  });

  it('decodes multiple run UUIDs', () => {
    const result = decodeFromUrl('?runs_b=uuid-1,uuid-2,uuid-3');
    expect(result.sideB?.runs).toEqual(['uuid-1', 'uuid-2', 'uuid-3']);
  });

  it('ignores invalid agg values', () => {
    const result = decodeFromUrl('?sample_agg=bogus&run_agg_a=invalid');
    expect(result.sampleAgg).toBeUndefined();
    // sideA should not be set since only run_agg_a was provided with invalid value
    // But order_a/machine_a/runs_a are all absent, so runAggA is undefined,
    // and nothing triggers sideA creation
    expect(result.sideA).toBeUndefined();
  });

  it('ignores invalid sort values', () => {
    const result = decodeFromUrl('?sort=bogus&sort_dir=invalid');
    expect(result.sort).toBeUndefined();
    expect(result.sortDir).toBeUndefined();
  });

  it('decodes hideNoise=1 as true', () => {
    const result = decodeFromUrl('?hide_noise=1');
    expect(result.hideNoise).toBe(true);
  });

  it('decodes hideNoise=0 as false', () => {
    const result = decodeFromUrl('?hide_noise=0');
    expect(result.hideNoise).toBe(false);
  });

  it('leaves hideNoise unset when absent', () => {
    const result = decodeFromUrl('?metric=exec_time');
    expect(result.hideNoise).toBeUndefined();
  });

  it('empty runs_a= produces runs: [] (not [""])', () => {
    const result = decodeFromUrl('?runs_a=');
    expect(result.sideA?.runs ?? []).toEqual([]);
  });

  it('runs_a=,, (commas only) produces runs: []', () => {
    const result = decodeFromUrl('?runs_a=,,');
    expect(result.sideA?.runs ?? []).toEqual([]);
  });

  it('runs_a=abc,,def (empty element in middle) produces runs without empty strings', () => {
    const result = decodeFromUrl('?runs_a=abc,,def');
    expect(result.sideA?.runs).toEqual(['abc', 'def']);
  });
});

describe('round-trip', () => {
  it('encode then decode preserves full non-default state', () => {
    const state = makeDefaults();
    state.sideA = { order: 'rev1', machine: 'mach-a', runs: ['u1', 'u2'], runAgg: 'mean' };
    state.sideB = { order: 'rev2', machine: 'mach-b', runs: ['u3'], runAgg: 'max' };
    state.metric = 'exec_time';
    state.sampleAgg = 'min';
    state.noise = 3;
    state.sort = 'test';
    state.sortDir = 'asc';
    state.testFilter = 'bench';
    state.hideNoise = true;

    const qs = encodeToUrl(state);
    const decoded = decodeFromUrl(qs);

    expect(decoded.sideA).toEqual(state.sideA);
    expect(decoded.sideB).toEqual(state.sideB);
    expect(decoded.metric).toBe(state.metric);
    expect(decoded.sampleAgg).toBe(state.sampleAgg);
    expect(decoded.noise).toBe(state.noise);
    expect(decoded.sort).toBe(state.sort);
    expect(decoded.sortDir).toBe(state.sortDir);
    expect(decoded.testFilter).toBe(state.testFilter);
    expect(decoded.hideNoise).toBe(state.hideNoise);
  });

  it('round-trips multiple run UUIDs', () => {
    const state = makeDefaults();
    state.sideA.runs = ['aaa-111', 'bbb-222', 'ccc-333'];
    state.sideA.order = 'x'; // needed to trigger sideA encoding

    const qs = encodeToUrl(state);
    const decoded = decodeFromUrl(qs);

    expect(decoded.sideA?.runs).toEqual(['aaa-111', 'bbb-222', 'ccc-333']);
  });
});

describe('applyUrlState', () => {
  beforeEach(() => {
    // Reset global state to defaults before each test
    applyUrlState('');
  });

  it('restores state from URL on page load', () => {
    applyUrlState('?order_a=rev1&machine_a=mach-a&metric=exec_time&noise=3&sort=ratio&sort_dir=asc');
    const s = getState();
    expect(s.sideA.order).toBe('rev1');
    expect(s.sideA.machine).toBe('mach-a');
    expect(s.metric).toBe('exec_time');
    expect(s.noise).toBe(3);
    expect(s.sort).toBe('ratio');
    expect(s.sortDir).toBe('asc');
  });

  it('resets absent fields to defaults', () => {
    // First set some non-default state
    setState({ metric: 'exec_time', noise: 5, sort: 'ratio', testFilter: 'bench' });
    expect(getState().metric).toBe('exec_time');
    expect(getState().noise).toBe(5);

    // Now apply a URL that only sets metric — everything else should reset to defaults
    applyUrlState('?metric=compile_time');
    const s = getState();
    expect(s.metric).toBe('compile_time');
    expect(s.noise).toBe(1); // default
    expect(s.sort).toBe('delta_pct'); // default
    expect(s.sortDir).toBe('desc'); // default
    expect(s.testFilter).toBe(''); // default
    expect(s.hideNoise).toBe(false); // default
    expect(s.sideA).toEqual({ order: '', machine: '', runs: [], runAgg: 'median' });
    expect(s.sideB).toEqual({ order: '', machine: '', runs: [], runAgg: 'median' });
  });

  it('with empty search string sets state to all defaults', () => {
    // Set non-default state first
    setState({ metric: 'exec_time', noise: 5 });
    setSideA({ order: 'rev1', machine: 'mach-a' });

    applyUrlState('');
    const s = getState();
    expect(s).toEqual(makeDefaults());
  });

  it('with partial URL sets only specified fields, unset fields are defaults', () => {
    applyUrlState('?order_b=rev2&sample_agg=min&hide_noise=1');
    const s = getState();

    // Specified fields
    expect(s.sideB.order).toBe('rev2');
    expect(s.sampleAgg).toBe('min');
    expect(s.hideNoise).toBe(true);

    // Unset fields should be defaults
    expect(s.sideA).toEqual({ order: '', machine: '', runs: [], runAgg: 'median' });
    expect(s.sideB.machine).toBe('');
    expect(s.sideB.runs).toEqual([]);
    expect(s.sideB.runAgg).toBe('median');
    expect(s.metric).toBe('');
    expect(s.noise).toBe(1);
    expect(s.sort).toBe('delta_pct');
    expect(s.sortDir).toBe('desc');
    expect(s.testFilter).toBe('');
  });
});

describe('getState / setState / setSideA / setSideB', () => {
  beforeEach(() => {
    applyUrlState('');
  });

  it('getState returns the current state', () => {
    const s = getState();
    expect(s).toEqual(makeDefaults());
  });

  it('setState merges partial state', () => {
    setState({ metric: 'exec_time', noise: 2.5 });
    const s = getState();
    expect(s.metric).toBe('exec_time');
    expect(s.noise).toBe(2.5);
    // Other fields unchanged from defaults
    expect(s.sort).toBe('delta_pct');
    expect(s.sortDir).toBe('desc');
    expect(s.sampleAgg).toBe('median');
  });

  it('setSideA merges partial side A selection', () => {
    setSideA({ order: 'rev123', machine: 'mach-a' });
    const s = getState();
    expect(s.sideA.order).toBe('rev123');
    expect(s.sideA.machine).toBe('mach-a');
    // Unset fields keep their defaults
    expect(s.sideA.runs).toEqual([]);
    expect(s.sideA.runAgg).toBe('median');
  });

  it('setSideB merges partial side B selection', () => {
    setSideB({ runs: ['uuid-1', 'uuid-2'], runAgg: 'mean' });
    const s = getState();
    expect(s.sideB.runs).toEqual(['uuid-1', 'uuid-2']);
    expect(s.sideB.runAgg).toBe('mean');
    // Unset fields keep their defaults
    expect(s.sideB.order).toBe('');
    expect(s.sideB.machine).toBe('');
  });

  it('state is preserved across calls (not reset)', () => {
    setState({ metric: 'exec_time' });
    setState({ noise: 3 });
    setSideA({ order: 'rev1' });
    setSideA({ machine: 'mach-a' });
    setSideB({ order: 'rev2' });

    const s = getState();
    // All previous calls should have been preserved
    expect(s.metric).toBe('exec_time');
    expect(s.noise).toBe(3);
    expect(s.sideA.order).toBe('rev1');
    expect(s.sideA.machine).toBe('mach-a');
    expect(s.sideB.order).toBe('rev2');
  });

  it('swapSides exchanges sideA and sideB', () => {
    setSideA({ order: 'rev1', machine: 'mach-a', runs: ['u1'], runAgg: 'mean' });
    setSideB({ order: 'rev2', machine: 'mach-b', runs: ['u2', 'u3'], runAgg: 'max' });

    swapSides();

    const s = getState();
    expect(s.sideA).toEqual({ order: 'rev2', machine: 'mach-b', runs: ['u2', 'u3'], runAgg: 'max' });
    expect(s.sideB).toEqual({ order: 'rev1', machine: 'mach-a', runs: ['u1'], runAgg: 'mean' });
  });

  it('swapSides twice restores original state', () => {
    setSideA({ order: 'rev1', machine: 'mach-a' });
    setSideB({ order: 'rev2', machine: 'mach-b' });

    swapSides();
    swapSides();

    const s = getState();
    expect(s.sideA.order).toBe('rev1');
    expect(s.sideA.machine).toBe('mach-a');
    expect(s.sideB.order).toBe('rev2');
    expect(s.sideB.machine).toBe('mach-b');
  });
});

describe('URL special characters round-trip', () => {
  it('round-trips order and machine with spaces', () => {
    const state = makeDefaults();
    state.sideA.order = 'rev 123';
    state.sideA.machine = 'my machine';

    const qs = encodeToUrl(state);
    const decoded = decodeFromUrl(qs);

    expect(decoded.sideA?.order).toBe('rev 123');
    expect(decoded.sideA?.machine).toBe('my machine');
  });

  it('round-trips values with +', () => {
    const state = makeDefaults();
    state.sideA.order = 'r+1';
    state.sideA.machine = 'host+name';

    const qs = encodeToUrl(state);
    const decoded = decodeFromUrl(qs);

    expect(decoded.sideA?.order).toBe('r+1');
    expect(decoded.sideA?.machine).toBe('host+name');
  });

  it('round-trips values with &', () => {
    const state = makeDefaults();
    state.sideA.order = 'a&b';
    state.sideB.order = 'c&d';

    const qs = encodeToUrl(state);
    const decoded = decodeFromUrl(qs);

    expect(decoded.sideA?.order).toBe('a&b');
    expect(decoded.sideB?.order).toBe('c&d');
  });

  it('round-trips values with =', () => {
    const state = makeDefaults();
    state.sideA.machine = 'x=y';
    state.sideB.machine = 'key=value';

    const qs = encodeToUrl(state);
    const decoded = decodeFromUrl(qs);

    expect(decoded.sideA?.machine).toBe('x=y');
    expect(decoded.sideB?.machine).toBe('key=value');
  });

  it('full round-trip with mixed special characters', () => {
    const state = makeDefaults();
    state.sideA = { order: 'rev 123+rc1', machine: 'host&name=prod', runs: ['uuid-1'], runAgg: 'mean' };
    state.sideB = { order: 'a&b=c+d e', machine: 'machine two', runs: ['uuid-2', 'uuid-3'], runAgg: 'max' };
    state.metric = 'exec_time';
    state.testFilter = 'bench+suite & more';
    state.noise = 2;
    state.sort = 'ratio';
    state.sortDir = 'asc';
    state.hideNoise = true;

    const qs = encodeToUrl(state);
    const decoded = decodeFromUrl(qs);

    expect(decoded.sideA).toEqual(state.sideA);
    expect(decoded.sideB).toEqual(state.sideB);
    expect(decoded.metric).toBe(state.metric);
    expect(decoded.testFilter).toBe(state.testFilter);
    expect(decoded.noise).toBe(state.noise);
    expect(decoded.sort).toBe(state.sort);
    expect(decoded.sortDir).toBe(state.sortDir);
    expect(decoded.hideNoise).toBe(state.hideNoise);
  });
});

describe('decodeFromUrl noise edge cases', () => {
  it('noise=0 produces { noise: 0 }', () => {
    const result = decodeFromUrl('?noise=0');
    expect(result.noise).toBe(0);
  });

  it('noise=abc does NOT produce a noise field (NaN rejected)', () => {
    const result = decodeFromUrl('?noise=abc');
    expect(result.noise).toBeUndefined();
  });

  it('noise=-1 does NOT produce a noise field (negative rejected)', () => {
    const result = decodeFromUrl('?noise=-1');
    expect(result.noise).toBeUndefined();
  });

  it('noise=5 produces { noise: 5 }', () => {
    const result = decodeFromUrl('?noise=5');
    expect(result.noise).toBe(5);
  });
});

describe('replaceUrl', () => {
  beforeEach(() => {
    applyUrlState('');
  });

  it('calls window.history.replaceState with the encoded URL', () => {
    const spy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});

    // setState auto-calls replaceUrl
    setState({ metric: 'compile_time', sort: 'ratio', sortDir: 'asc' });

    expect(spy).toHaveBeenCalledOnce();
    const url = spy.mock.calls[0][2] as string;
    expect(url).toContain('metric=compile_time');
    expect(url).toContain('sort=ratio');
    expect(url).toContain('sort_dir=asc');
    // First two arguments should be null and ''
    expect(spy.mock.calls[0][0]).toBeNull();
    expect(spy.mock.calls[0][1]).toBe('');

    spy.mockRestore();
  });

  it('includes pathname in the URL', () => {
    const spy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});

    Object.defineProperty(window, 'location', {
      value: { ...window.location, pathname: '/v5/nts/compare' },
      writable: true,
      configurable: true,
    });

    setState({ metric: 'exec_time' });
    replaceUrl();

    const url = spy.mock.calls[0][2] as string;
    expect(url).toMatch(/^\/v5\/nts\/compare\?/);

    spy.mockRestore();
  });

  it('replaces with pathname only when state is all defaults', () => {
    const spy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});

    Object.defineProperty(window, 'location', {
      value: { ...window.location, pathname: '/compare' },
      writable: true,
      configurable: true,
    });

    // State is already defaults from beforeEach
    replaceUrl();

    const url = spy.mock.calls[0][2] as string;
    expect(url).toBe('/compare');

    spy.mockRestore();
  });
});
