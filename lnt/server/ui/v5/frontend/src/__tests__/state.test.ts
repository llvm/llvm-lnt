// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { encodeToUrl, decodeFromUrl, applyUrlState, getState, setState, setNoiseConfig, setSideA, setSideB, swapSides, replaceUrl } from '../state';
import type { AppState, NoiseConfig } from '../types';

const NOISE_DEFAULTS: NoiseConfig = {
  pct:   { enabled: false, value: 1 },
  pval:  { enabled: false, value: 0.05 },
  floor: { enabled: false, value: 0 },
};

function makeDefaults(): AppState {
  return {
    sideA: { suite: '', commit: '', machine: '', runs: [], runAgg: 'median' },
    sideB: { suite: '', commit: '', machine: '', runs: [], runAgg: 'median' },
    metric: '',
    sampleAgg: 'median',
    noiseConfig: structuredClone(NOISE_DEFAULTS),
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
    state.sideA.commit = 'rev123';
    state.sideA.machine = 'machine-a';
    state.sideA.runs = ['uuid-1'];
    state.sideB.commit = 'rev456';
    state.sideB.machine = 'machine-b';
    state.sideB.runs = ['uuid-2', 'uuid-3'];
    state.sideB.runAgg = 'mean';
    state.metric = 'exec_time';
    state.sampleAgg = 'min';
    state.noiseConfig = {
      pct: { enabled: true, value: 2.5 },
      pval: { enabled: true, value: 0.01 },
      floor: { enabled: true, value: 5 },
    };
    state.sort = 'ratio';
    state.sortDir = 'asc';
    state.testFilter = 'bench';
    state.hideNoise = true;

    const qs = encodeToUrl(state);
    const params = new URLSearchParams(qs);

    expect(params.get('commit_a')).toBe('rev123');
    expect(params.get('machine_a')).toBe('machine-a');
    expect(params.get('runs_a')).toBe('uuid-1');
    expect(params.get('commit_b')).toBe('rev456');
    expect(params.get('machine_b')).toBe('machine-b');
    expect(params.get('runs_b')).toBe('uuid-2,uuid-3');
    expect(params.get('run_agg_b')).toBe('mean');
    expect(params.get('metric')).toBe('exec_time');
    expect(params.get('sample_agg')).toBe('min');
    expect(params.get('noise_pct')).toBe('2.5');
    expect(params.get('noise_pct_on')).toBe('1');
    expect(params.get('noise_pval')).toBe('0.01');
    expect(params.get('noise_pval_on')).toBe('1');
    expect(params.get('noise_floor')).toBe('5');
    expect(params.get('noise_floor_on')).toBe('1');
    expect(params.get('sort')).toBe('ratio');
    expect(params.get('sort_dir')).toBe('asc');
    expect(params.get('test_filter')).toBe('bench');
    expect(params.get('hide_noise')).toBe('1');
  });

  it('omits default runAgg (median)', () => {
    const state = makeDefaults();
    state.sideA.commit = 'rev';
    state.sideA.runAgg = 'median';
    const params = new URLSearchParams(encodeToUrl(state));
    expect(params.has('run_agg_a')).toBe(false);
  });

  it('omits noise params when at defaults', () => {
    const state = makeDefaults();
    state.metric = 'x';
    const params = new URLSearchParams(encodeToUrl(state));
    expect(params.has('noise_pct')).toBe(false);
    expect(params.has('noise_pct_on')).toBe(false);
    expect(params.has('noise_pval')).toBe(false);
    expect(params.has('noise_pval_on')).toBe(false);
    expect(params.has('noise_floor')).toBe(false);
    expect(params.has('noise_floor_on')).toBe(false);
  });

  it('encodes noise_pct when non-default', () => {
    const state = makeDefaults();
    state.noiseConfig.pct.value = 2.5;
    const params = new URLSearchParams(encodeToUrl(state));
    expect(params.get('noise_pct')).toBe('2.5');
  });

  it('does not encode noise_pct_on when pct is at default (disabled)', () => {
    const state = makeDefaults();
    // pct.enabled is already false (default) — should not appear in URL
    const params = new URLSearchParams(encodeToUrl(state));
    expect(params.has('noise_pct_on')).toBe(false);
  });

  it('encodes noise_pct_on=1 when pct enabled', () => {
    const state = makeDefaults();
    state.noiseConfig.pct.enabled = true;
    const params = new URLSearchParams(encodeToUrl(state));
    expect(params.get('noise_pct_on')).toBe('1');
  });
});

describe('decodeFromUrl', () => {
  it('returns empty object for empty query string', () => {
    const result = decodeFromUrl('');
    expect(result).toEqual({});
  });

  it('decodes side A parameters', () => {
    const result = decodeFromUrl('?commit_a=rev123&machine_a=machine-a&runs_a=uuid-1');
    expect(result.sideA?.commit).toBe('rev123');
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

describe('decodeFromUrl — noise config', () => {
  it('decodes noise_pct', () => {
    const result = decodeFromUrl('?noise_pct=2.5');
    expect(result.noiseConfig?.pct.value).toBe(2.5);
    expect(result.noiseConfig?.pct.enabled).toBe(false); // default
  });

  it('decodes noise_pct_on=0', () => {
    const result = decodeFromUrl('?noise_pct_on=0');
    expect(result.noiseConfig?.pct.enabled).toBe(false);
  });

  it('decodes noise_pval', () => {
    const result = decodeFromUrl('?noise_pval=0.01&noise_pval_on=1');
    expect(result.noiseConfig?.pval.value).toBe(0.01);
    expect(result.noiseConfig?.pval.enabled).toBe(true);
  });

  it('decodes noise_floor', () => {
    const result = decodeFromUrl('?noise_floor=5&noise_floor_on=1');
    expect(result.noiseConfig?.floor.value).toBe(5);
    expect(result.noiseConfig?.floor.enabled).toBe(true);
  });

  it('rejects noise_pval < 0', () => {
    const result = decodeFromUrl('?noise_pval=-0.1&noise_pval_on=1');
    expect(result.noiseConfig?.pval.value).toBe(0.05); // default preserved
  });

  it('rejects noise_pval > 1', () => {
    const result = decodeFromUrl('?noise_pval=1.5&noise_pval_on=1');
    expect(result.noiseConfig?.pval.value).toBe(0.05); // default preserved
  });

  it('accepts noise_pval=0', () => {
    const result = decodeFromUrl('?noise_pval=0&noise_pval_on=1');
    expect(result.noiseConfig?.pval.value).toBe(0);
  });

  it('accepts noise_pval=1', () => {
    const result = decodeFromUrl('?noise_pval=1&noise_pval_on=1');
    expect(result.noiseConfig?.pval.value).toBe(1);
  });

  it('rejects noise_floor < 0', () => {
    const result = decodeFromUrl('?noise_floor=-1&noise_floor_on=1');
    expect(result.noiseConfig?.floor.value).toBe(0); // default preserved
  });

  it('ignores invalid *_on values', () => {
    const result = decodeFromUrl('?noise_pval_on=yes');
    // 'yes' is not '0' or '1', so enabled stays at default (false)
    expect(result.noiseConfig?.pval.enabled).toBe(false);
  });

  it('legacy ?noise=5 maps to pct.value', () => {
    const result = decodeFromUrl('?noise=5');
    expect(result.noiseConfig?.pct.value).toBe(5);
    expect(result.noiseConfig?.pct.enabled).toBe(true);
  });

  it('legacy ?noise is ignored when noise_pct is present', () => {
    const result = decodeFromUrl('?noise=5&noise_pct=2');
    expect(result.noiseConfig?.pct.value).toBe(2);
  });

  it('leaves noiseConfig unset when no noise params present', () => {
    const result = decodeFromUrl('?metric=exec_time');
    expect(result.noiseConfig).toBeUndefined();
  });
});

describe('round-trip', () => {
  it('encode then decode preserves full non-default state', () => {
    const state = makeDefaults();
    state.sideA = { suite: 'nts', commit: 'rev1', machine: 'mach-a', runs: ['u1', 'u2'], runAgg: 'mean' };
    state.sideB = { suite: 'compile', commit: 'rev2', machine: 'mach-b', runs: ['u3'], runAgg: 'max' };
    state.metric = 'exec_time';
    state.sampleAgg = 'min';
    state.noiseConfig = {
      pct: { enabled: false, value: 3 },
      pval: { enabled: true, value: 0.01 },
      floor: { enabled: true, value: 10 },
    };
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
    expect(decoded.noiseConfig).toEqual(state.noiseConfig);
    expect(decoded.sort).toBe(state.sort);
    expect(decoded.sortDir).toBe(state.sortDir);
    expect(decoded.testFilter).toBe(state.testFilter);
    expect(decoded.hideNoise).toBe(state.hideNoise);
  });

  it('round-trips multiple run UUIDs', () => {
    const state = makeDefaults();
    state.sideA.runs = ['aaa-111', 'bbb-222', 'ccc-333'];
    state.sideA.commit = 'x'; // needed to trigger sideA encoding

    const qs = encodeToUrl(state);
    const decoded = decodeFromUrl(qs);

    expect(decoded.sideA?.runs).toEqual(['aaa-111', 'bbb-222', 'ccc-333']);
  });

  it('round-trips noiseConfig with all non-default values', () => {
    const state = makeDefaults();
    state.noiseConfig = {
      pct: { enabled: false, value: 5 },
      pval: { enabled: true, value: 0.1 },
      floor: { enabled: true, value: 100 },
    };
    const qs = encodeToUrl(state);
    const decoded = decodeFromUrl(qs);
    expect(decoded.noiseConfig).toEqual(state.noiseConfig);
  });
});

describe('applyUrlState', () => {
  beforeEach(() => {
    applyUrlState('');
  });

  it('restores state from URL on page load', () => {
    applyUrlState('?commit_a=rev1&machine_a=mach-a&metric=exec_time&noise_pct=3&sort=ratio&sort_dir=asc');
    const s = getState();
    expect(s.sideA.commit).toBe('rev1');
    expect(s.sideA.machine).toBe('mach-a');
    expect(s.metric).toBe('exec_time');
    expect(s.noiseConfig.pct.value).toBe(3);
    expect(s.sort).toBe('ratio');
    expect(s.sortDir).toBe('asc');
  });

  it('resets absent fields to defaults', () => {
    setState({ metric: 'exec_time', noiseConfig: { pct: { enabled: true, value: 5 }, pval: { enabled: false, value: 0.05 }, floor: { enabled: false, value: 0 } } });
    expect(getState().metric).toBe('exec_time');
    expect(getState().noiseConfig.pct.value).toBe(5);

    applyUrlState('?metric=compile_time');
    const s = getState();
    expect(s.metric).toBe('compile_time');
    expect(s.noiseConfig).toEqual(NOISE_DEFAULTS);
    expect(s.sort).toBe('delta_pct');
    expect(s.sortDir).toBe('desc');
    expect(s.testFilter).toBe('');
    expect(s.hideNoise).toBe(false);
    expect(s.sideA).toEqual({ suite: '', commit: '', machine: '', runs: [], runAgg: 'median' });
    expect(s.sideB).toEqual({ suite: '', commit: '', machine: '', runs: [], runAgg: 'median' });
  });

  it('with empty search string sets state to all defaults', () => {
    setState({ metric: 'exec_time' });
    setNoiseConfig('pct', { value: 5 });
    setSideA({ commit: 'rev1', machine: 'mach-a' });

    applyUrlState('');
    const s = getState();
    expect(s).toEqual(makeDefaults());
  });

  it('with partial URL sets only specified fields, unset fields are defaults', () => {
    applyUrlState('?commit_b=rev2&sample_agg=min&hide_noise=1');
    const s = getState();

    expect(s.sideB.commit).toBe('rev2');
    expect(s.sampleAgg).toBe('min');
    expect(s.hideNoise).toBe(true);

    expect(s.sideA).toEqual({ suite: '', commit: '', machine: '', runs: [], runAgg: 'median' });
    expect(s.sideB.machine).toBe('');
    expect(s.sideB.runs).toEqual([]);
    expect(s.sideB.runAgg).toBe('median');
    expect(s.metric).toBe('');
    expect(s.noiseConfig).toEqual(NOISE_DEFAULTS);
    expect(s.sort).toBe('delta_pct');
    expect(s.sortDir).toBe('desc');
    expect(s.testFilter).toBe('');
  });

  it('with partial noise params, unset knobs keep defaults', () => {
    applyUrlState('?noise_pval_on=1');
    const s = getState();
    expect(s.noiseConfig.pval.enabled).toBe(true);
    expect(s.noiseConfig.pval.value).toBe(0.05); // default value
    expect(s.noiseConfig.pct).toEqual(NOISE_DEFAULTS.pct);
    expect(s.noiseConfig.floor).toEqual(NOISE_DEFAULTS.floor);
  });
});

describe('getState / setState / setNoiseConfig / setSideA / setSideB', () => {
  beforeEach(() => {
    applyUrlState('');
  });

  it('getState returns the current state', () => {
    const s = getState();
    expect(s).toEqual(makeDefaults());
  });

  it('setState merges partial state', () => {
    setState({ metric: 'exec_time' });
    const s = getState();
    expect(s.metric).toBe('exec_time');
    expect(s.sort).toBe('delta_pct');
    expect(s.sortDir).toBe('desc');
    expect(s.sampleAgg).toBe('median');
  });

  it('setNoiseConfig updates a single knob', () => {
    setNoiseConfig('pct', { value: 5 });
    const s = getState();
    expect(s.noiseConfig.pct.value).toBe(5);
    expect(s.noiseConfig.pct.enabled).toBe(false); // unchanged from default
    expect(s.noiseConfig.pval).toEqual(NOISE_DEFAULTS.pval); // other knobs unchanged
    expect(s.noiseConfig.floor).toEqual(NOISE_DEFAULTS.floor);
  });

  it('setNoiseConfig updates enabled state', () => {
    setNoiseConfig('pval', { enabled: true });
    expect(getState().noiseConfig.pval.enabled).toBe(true);
    expect(getState().noiseConfig.pval.value).toBe(0.05); // value unchanged
  });

  it('setSideA merges partial side A selection', () => {
    setSideA({ commit: 'rev123', machine: 'mach-a' });
    const s = getState();
    expect(s.sideA.commit).toBe('rev123');
    expect(s.sideA.machine).toBe('mach-a');
    expect(s.sideA.runs).toEqual([]);
    expect(s.sideA.runAgg).toBe('median');
  });

  it('setSideB merges partial side B selection', () => {
    setSideB({ runs: ['uuid-1', 'uuid-2'], runAgg: 'mean' });
    const s = getState();
    expect(s.sideB.runs).toEqual(['uuid-1', 'uuid-2']);
    expect(s.sideB.runAgg).toBe('mean');
    expect(s.sideB.commit).toBe('');
    expect(s.sideB.machine).toBe('');
  });

  it('state is preserved across calls (not reset)', () => {
    setState({ metric: 'exec_time' });
    setNoiseConfig('pct', { value: 3 });
    setSideA({ commit: 'rev1' });
    setSideA({ machine: 'mach-a' });
    setSideB({ commit: 'rev2' });

    const s = getState();
    expect(s.metric).toBe('exec_time');
    expect(s.noiseConfig.pct.value).toBe(3);
    expect(s.sideA.commit).toBe('rev1');
    expect(s.sideA.machine).toBe('mach-a');
    expect(s.sideB.commit).toBe('rev2');
  });

  it('swapSides exchanges sideA and sideB', () => {
    setSideA({ commit: 'rev1', machine: 'mach-a', runs: ['u1'], runAgg: 'mean' });
    setSideB({ commit: 'rev2', machine: 'mach-b', runs: ['u2', 'u3'], runAgg: 'max' });

    swapSides();

    const s = getState();
    expect(s.sideA).toEqual({ suite: '', commit: 'rev2', machine: 'mach-b', runs: ['u2', 'u3'], runAgg: 'max' });
    expect(s.sideB).toEqual({ suite: '', commit: 'rev1', machine: 'mach-a', runs: ['u1'], runAgg: 'mean' });
  });

  it('swapSides twice restores original state', () => {
    setSideA({ commit: 'rev1', machine: 'mach-a' });
    setSideB({ commit: 'rev2', machine: 'mach-b' });

    swapSides();
    swapSides();

    const s = getState();
    expect(s.sideA.commit).toBe('rev1');
    expect(s.sideA.machine).toBe('mach-a');
    expect(s.sideB.commit).toBe('rev2');
    expect(s.sideB.machine).toBe('mach-b');
  });
});

describe('URL special characters round-trip', () => {
  it('round-trips commit and machine with spaces', () => {
    const state = makeDefaults();
    state.sideA.commit = 'rev 123';
    state.sideA.machine = 'my machine';

    const qs = encodeToUrl(state);
    const decoded = decodeFromUrl(qs);

    expect(decoded.sideA?.commit).toBe('rev 123');
    expect(decoded.sideA?.machine).toBe('my machine');
  });

  it('round-trips values with +', () => {
    const state = makeDefaults();
    state.sideA.commit = 'r+1';
    state.sideA.machine = 'host+name';

    const qs = encodeToUrl(state);
    const decoded = decodeFromUrl(qs);

    expect(decoded.sideA?.commit).toBe('r+1');
    expect(decoded.sideA?.machine).toBe('host+name');
  });

  it('round-trips values with &', () => {
    const state = makeDefaults();
    state.sideA.commit = 'a&b';
    state.sideB.commit = 'c&d';

    const qs = encodeToUrl(state);
    const decoded = decodeFromUrl(qs);

    expect(decoded.sideA?.commit).toBe('a&b');
    expect(decoded.sideB?.commit).toBe('c&d');
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
    state.sideA = { suite: '', commit: 'rev 123+rc1', machine: 'host&name=prod', runs: ['uuid-1'], runAgg: 'mean' };
    state.sideB = { suite: '', commit: 'a&b=c+d e', machine: 'machine two', runs: ['uuid-2', 'uuid-3'], runAgg: 'max' };
    state.metric = 'exec_time';
    state.testFilter = 'bench+suite & more';
    state.noiseConfig = {
      pct: { enabled: true, value: 2 },
      pval: { enabled: true, value: 0.01 },
      floor: { enabled: false, value: 0 },
    };
    state.sort = 'ratio';
    state.sortDir = 'asc';
    state.hideNoise = true;

    const qs = encodeToUrl(state);
    const decoded = decodeFromUrl(qs);

    expect(decoded.sideA).toEqual(state.sideA);
    expect(decoded.sideB).toEqual(state.sideB);
    expect(decoded.metric).toBe(state.metric);
    expect(decoded.testFilter).toBe(state.testFilter);
    expect(decoded.noiseConfig).toEqual(state.noiseConfig);
    expect(decoded.sort).toBe(state.sort);
    expect(decoded.sortDir).toBe(state.sortDir);
    expect(decoded.hideNoise).toBe(state.hideNoise);
  });
});

describe('decodeFromUrl noise edge cases', () => {
  it('noise_pct=0 produces value: 0', () => {
    const result = decodeFromUrl('?noise_pct=0');
    expect(result.noiseConfig?.pct.value).toBe(0);
  });

  it('noise_pct=abc does NOT produce a noiseConfig field (NaN rejected)', () => {
    const result = decodeFromUrl('?noise_pct=abc');
    // The param is present but invalid, so it falls back to default
    expect(result.noiseConfig?.pct.value).toBe(1); // default
  });

  it('noise_pct=-1 does NOT change the value (negative rejected)', () => {
    const result = decodeFromUrl('?noise_pct=-1');
    expect(result.noiseConfig?.pct.value).toBe(1); // default
  });

  it('noise_pct=5 produces value: 5', () => {
    const result = decodeFromUrl('?noise_pct=5');
    expect(result.noiseConfig?.pct.value).toBe(5);
  });
});

describe('replaceUrl', () => {
  beforeEach(() => {
    applyUrlState('');
  });

  it('calls window.history.replaceState with the encoded URL', () => {
    const spy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});

    setState({ metric: 'compile_time', sort: 'ratio', sortDir: 'asc' });

    expect(spy).toHaveBeenCalledOnce();
    const url = spy.mock.calls[0][2] as string;
    expect(url).toContain('metric=compile_time');
    expect(url).toContain('sort=ratio');
    expect(url).toContain('sort_dir=asc');
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

    replaceUrl();

    const url = spy.mock.calls[0][2] as string;
    expect(url).toBe('/compare');

    spy.mockRestore();
  });
});
