import type { AggFn, AppState, SideSelection, SortCol, SortDir } from './types';

const DEFAULTS: AppState = {
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

let state: AppState = structuredClone(DEFAULTS);

export function getState(): AppState {
  return state;
}

export function setState(partial: Partial<AppState>): void {
  Object.assign(state, partial);
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
  const order = p.get(`order_${suffix}`);
  const machine = p.get(`machine_${suffix}`);
  const runs = p.get(`runs_${suffix}`);
  const runAgg = parseAgg(p.get(`run_agg_${suffix}`));
  if (order || machine || runs || runAgg) {
    return {
      order: order || '',
      machine: machine || '',
      runs: runs ? runs.split(',').filter(Boolean) : [],
      runAgg: runAgg || 'median',
    };
  }
  return undefined;
}

function encodeSide(p: URLSearchParams, side: SideSelection, suffix: string): void {
  if (side.order) p.set(`order_${suffix}`, side.order);
  if (side.machine) p.set(`machine_${suffix}`, side.machine);
  if (side.runs.length) p.set(`runs_${suffix}`, side.runs.join(','));
  if (side.runAgg !== 'median') p.set(`run_agg_${suffix}`, side.runAgg);
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

  const noise = p.get('noise');
  if (noise !== null) {
    const n = parseFloat(noise);
    if (Number.isFinite(n) && n >= 0) result.noise = n;
  }

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
  if (s.noise !== 1) p.set('noise', String(s.noise));
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
  if (decoded.noise !== undefined) state.noise = decoded.noise;
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
