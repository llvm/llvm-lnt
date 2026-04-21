import type { AggFn, AppState, NoiseConfig, NoiseKnob, SideSelection, SortCol, SortDir } from './types';

const NOISE_DEFAULTS: NoiseConfig = {
  pct:   { enabled: false, value: 1 },
  pval:  { enabled: false, value: 0.05 },
  floor: { enabled: false, value: 0 },
};

const DEFAULTS: AppState = {
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

let state: AppState = structuredClone(DEFAULTS);

export function getState(): AppState {
  return state;
}

export function setState(partial: Partial<AppState>): void {
  Object.assign(state, partial);
  replaceUrl();
}

export function setNoiseConfig(knob: keyof NoiseConfig, partial: Partial<NoiseKnob>): void {
  state.noiseConfig = {
    ...state.noiseConfig,
    [knob]: { ...state.noiseConfig[knob], ...partial },
  };
  replaceUrl();
}

export function setSideA(partial: Partial<AppState['sideA']>): void {
  Object.assign(state.sideA, partial);
  replaceUrl();
}

export function setSideB(partial: Partial<AppState['sideB']>): void {
  Object.assign(state.sideB, partial);
  replaceUrl();
}

export function swapSides(): void {
  const tmp = state.sideA;
  state.sideA = state.sideB;
  state.sideB = tmp;
  replaceUrl();
}

const VALID_AGG: AggFn[] = ['median', 'mean', 'min', 'max'];
const VALID_SORT: SortCol[] = ['test', 'value_a', 'value_b', 'delta', 'delta_pct', 'ratio', 'status'];
const VALID_DIR: SortDir[] = ['asc', 'desc'];

function parseAgg(v: string | null): AggFn | undefined {
  return v && VALID_AGG.includes(v as AggFn) ? v as AggFn : undefined;
}

function decodeSide(p: URLSearchParams, suffix: string): SideSelection | undefined {
  const suite = p.get(`suite_${suffix}`);
  const commit = p.get(`commit_${suffix}`);
  const machine = p.get(`machine_${suffix}`);
  const runs = p.get(`runs_${suffix}`);
  const runAgg = parseAgg(p.get(`run_agg_${suffix}`));
  if (suite || commit || machine || runs || runAgg) {
    return {
      suite: suite || '',
      commit: commit || '',
      machine: machine || '',
      runs: runs ? runs.split(',').filter(Boolean) : [],
      runAgg: runAgg || 'median',
    };
  }
  return undefined;
}

function encodeSide(p: URLSearchParams, side: SideSelection, suffix: string): void {
  if (side.suite) p.set(`suite_${suffix}`, side.suite);
  if (side.commit) p.set(`commit_${suffix}`, side.commit);
  if (side.machine) p.set(`machine_${suffix}`, side.machine);
  if (side.runs.length) p.set(`runs_${suffix}`, side.runs.join(','));
  if (side.runAgg !== 'median') p.set(`run_agg_${suffix}`, side.runAgg);
}

function decodeNoiseConfig(p: URLSearchParams): Partial<NoiseConfig> | undefined {
  const result: Partial<NoiseConfig> = {};
  let hasAny = false;

  // Delta % knob
  const pctVal = p.get('noise_pct');
  const pctOn = p.get('noise_pct_on');
  if (pctVal !== null || pctOn !== null) {
    hasAny = true;
    const knob: NoiseKnob = { ...NOISE_DEFAULTS.pct };
    if (pctVal !== null) {
      const n = parseFloat(pctVal);
      if (Number.isFinite(n) && n >= 0) knob.value = n;
    }
    if (pctOn === '0') knob.enabled = false;
    else if (pctOn === '1') knob.enabled = true;
    result.pct = knob;
  }

  // P-value knob
  const pvalVal = p.get('noise_pval');
  const pvalOn = p.get('noise_pval_on');
  if (pvalVal !== null || pvalOn !== null) {
    hasAny = true;
    const knob: NoiseKnob = { ...NOISE_DEFAULTS.pval };
    if (pvalVal !== null) {
      const n = parseFloat(pvalVal);
      if (Number.isFinite(n) && n >= 0 && n <= 1) knob.value = n;
    }
    if (pvalOn === '0') knob.enabled = false;
    else if (pvalOn === '1') knob.enabled = true;
    result.pval = knob;
  }

  // Floor knob
  const floorVal = p.get('noise_floor');
  const floorOn = p.get('noise_floor_on');
  if (floorVal !== null || floorOn !== null) {
    hasAny = true;
    const knob: NoiseKnob = { ...NOISE_DEFAULTS.floor };
    if (floorVal !== null) {
      const n = parseFloat(floorVal);
      if (Number.isFinite(n) && n >= 0) knob.value = n;
    }
    if (floorOn === '0') knob.enabled = false;
    else if (floorOn === '1') knob.enabled = true;
    result.floor = knob;
  }

  // Legacy migration: ?noise=X → pct.value
  if (!hasAny) {
    const legacyNoise = p.get('noise');
    if (legacyNoise !== null) {
      const n = parseFloat(legacyNoise);
      if (Number.isFinite(n) && n >= 0) {
        return { pct: { enabled: true, value: n } };
      }
    }
  }

  return hasAny ? result : undefined;
}

function encodeNoiseConfig(p: URLSearchParams, nc: NoiseConfig): void {
  // pct: defaults are enabled=true, value=1
  if (nc.pct.value !== NOISE_DEFAULTS.pct.value) p.set('noise_pct', String(nc.pct.value));
  if (nc.pct.enabled !== NOISE_DEFAULTS.pct.enabled) p.set('noise_pct_on', nc.pct.enabled ? '1' : '0');

  // pval: defaults are enabled=false, value=0.05
  if (nc.pval.value !== NOISE_DEFAULTS.pval.value) p.set('noise_pval', String(nc.pval.value));
  if (nc.pval.enabled !== NOISE_DEFAULTS.pval.enabled) p.set('noise_pval_on', nc.pval.enabled ? '1' : '0');

  // floor: defaults are enabled=false, value=0
  if (nc.floor.value !== NOISE_DEFAULTS.floor.value) p.set('noise_floor', String(nc.floor.value));
  if (nc.floor.enabled !== NOISE_DEFAULTS.floor.enabled) p.set('noise_floor_on', nc.floor.enabled ? '1' : '0');
}

export function decodeFromUrl(search: string): Partial<AppState> {
  const p = new URLSearchParams(search);
  const result: Partial<AppState> = {};

  const sideA = decodeSide(p, 'a');
  if (sideA) result.sideA = sideA;

  const sideB = decodeSide(p, 'b');
  if (sideB) result.sideB = sideB;

  const metric = p.get('metric');
  if (metric) result.metric = metric;

  const sampleAgg = parseAgg(p.get('sample_agg'));
  if (sampleAgg) result.sampleAgg = sampleAgg;

  const noiseConfig = decodeNoiseConfig(p);
  if (noiseConfig) result.noiseConfig = { ...structuredClone(NOISE_DEFAULTS), ...noiseConfig };

  const sort = p.get('sort');
  if (sort && VALID_SORT.includes(sort as SortCol)) result.sort = sort as SortCol;

  const sortDir = p.get('sort_dir');
  if (sortDir && VALID_DIR.includes(sortDir as SortDir)) result.sortDir = sortDir as SortDir;

  const testFilter = p.get('test_filter');
  if (testFilter) result.testFilter = testFilter;

  const hideNoise = p.get('hide_noise');
  if (hideNoise === '1') result.hideNoise = true;
  else if (hideNoise === '0') result.hideNoise = false;

  return result;
}

export function encodeToUrl(s: AppState): string {
  const p = new URLSearchParams();

  encodeSide(p, s.sideA, 'a');
  encodeSide(p, s.sideB, 'b');

  if (s.metric) p.set('metric', s.metric);
  if (s.sampleAgg !== 'median') p.set('sample_agg', s.sampleAgg);
  encodeNoiseConfig(p, s.noiseConfig);
  if (s.sort !== 'delta_pct') p.set('sort', s.sort);
  if (s.sortDir !== 'desc') p.set('sort_dir', s.sortDir);
  if (s.testFilter) p.set('test_filter', s.testFilter);
  if (s.hideNoise) p.set('hide_noise', '1');

  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

/** Decode URL params and apply onto a fresh default state. */
export function applyUrlState(search: string): void {
  const decoded = decodeFromUrl(search);
  // Reset to defaults first, then apply decoded URL params
  state = structuredClone(DEFAULTS);
  if (decoded.sideA) state.sideA = { ...state.sideA, ...decoded.sideA };
  if (decoded.sideB) state.sideB = { ...state.sideB, ...decoded.sideB };
  if (decoded.metric !== undefined) state.metric = decoded.metric;
  if (decoded.sampleAgg !== undefined) state.sampleAgg = decoded.sampleAgg;
  if (decoded.noiseConfig !== undefined) state.noiseConfig = decoded.noiseConfig;
  if (decoded.sort !== undefined) state.sort = decoded.sort;
  if (decoded.sortDir !== undefined) state.sortDir = decoded.sortDir;
  if (decoded.testFilter !== undefined) state.testFilter = decoded.testFilter;
  if (decoded.hideNoise !== undefined) state.hideNoise = decoded.hideNoise;
}

export function replaceUrl(): void {
  const qs = encodeToUrl(state);
  const url = window.location.pathname + qs;
  window.history.replaceState(null, '', url);
}
