// pages/graph/state.ts — URL state management for the Graph page.
// Pure encode/decode functions for the URL query string.

import type { AggFn } from '../../types';

/** A pinned baseline reference (suite, machine, commit). */
export interface BaselineRef {
  suite: string;
  machine: string;
  commit: string;
}

/** Regression annotation display mode. */
export type RegressionAnnotationMode = 'off' | 'active' | 'all';

/** Complete URL-reflected state for the Graph page. */
export interface GraphState {
  suite: string;
  machines: string[];
  metric: string;
  testFilter: string;
  runAgg: AggFn;
  sampleAgg: AggFn;
  baselines: BaselineRef[];
  regressionMode: RegressionAnnotationMode;
}

const VALID_AGG: AggFn[] = ['median', 'mean', 'min', 'max'];
const VALID_REG_MODE: RegressionAnnotationMode[] = ['off', 'active', 'all'];
const DEFAULT_AGG: AggFn = 'median';
const DEFAULT_REG_MODE: RegressionAnnotationMode = 'off';
const BASELINE_SEP = '::';

function parseAgg(value: string | null): AggFn {
  if (value && VALID_AGG.includes(value as AggFn)) return value as AggFn;
  return DEFAULT_AGG;
}

function parseRegMode(value: string | null): RegressionAnnotationMode {
  if (value && VALID_REG_MODE.includes(value as RegressionAnnotationMode)) {
    return value as RegressionAnnotationMode;
  }
  return DEFAULT_REG_MODE;
}

function parseBaseline(encoded: string): BaselineRef | null {
  const parts = encoded.split(BASELINE_SEP);
  if (parts.length !== 3) return null;
  const [suite, machine, commit] = parts;
  if (!suite || !machine || !commit) return null;
  return { suite, machine, commit };
}

function encodeBaseline(b: BaselineRef): string {
  return `${b.suite}${BASELINE_SEP}${b.machine}${BASELINE_SEP}${b.commit}`;
}

/** Decode URL search string into typed GraphState. */
export function decodeGraphState(search: string): GraphState {
  const params = new URLSearchParams(search);
  return {
    suite: params.get('suite') || '',
    machines: params.getAll('machine').filter(m => m.length > 0),
    metric: params.get('metric') || '',
    testFilter: params.get('test_filter') || '',
    runAgg: parseAgg(params.get('run_agg')),
    sampleAgg: parseAgg(params.get('sample_agg')),
    baselines: params.getAll('baseline')
      .map(parseBaseline)
      .filter((b): b is BaselineRef => b !== null),
    regressionMode: parseRegMode(params.get('regressions')),
  };
}

/** Encode GraphState to URL search string. Omits default values. */
export function encodeGraphState(state: GraphState): string {
  const params = new URLSearchParams();

  if (state.suite) params.set('suite', state.suite);
  for (const m of state.machines) params.append('machine', m);
  if (state.metric) params.set('metric', state.metric);
  if (state.testFilter) params.set('test_filter', state.testFilter);
  if (state.runAgg !== DEFAULT_AGG) params.set('run_agg', state.runAgg);
  if (state.sampleAgg !== DEFAULT_AGG) params.set('sample_agg', state.sampleAgg);
  for (const b of state.baselines) params.append('baseline', encodeBaseline(b));
  if (state.regressionMode !== DEFAULT_REG_MODE) {
    params.set('regressions', state.regressionMode);
  }

  const str = params.toString();
  return str ? `?${str}` : '';
}

/** Update the browser URL with the encoded state (no navigation). */
export function replaceGraphUrl(state: GraphState): void {
  const search = encodeGraphState(state);
  const url = window.location.pathname + search;
  window.history.replaceState(null, '', url);
}
