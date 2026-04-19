// v5 API response types

export interface FieldInfo {
  name: string;
  type: string;
  display_name: string | null;
  unit: string | null;
  unit_abbrev: string | null;
  bigger_is_better: boolean | null;
}

export interface CommitSummary {
  commit: string;
  ordinal: number | null;
  fields: Record<string, string>;
}

export interface CommitDetail {
  commit: string;
  ordinal: number | null;
  fields: Record<string, string>;
  previous_commit: CommitNeighbor | null;
  next_commit: CommitNeighbor | null;
}

export interface CommitNeighbor {
  commit: string;
  ordinal: number | null;
  link: string;
}

export interface CommitResolveResponse {
  results: Record<string, CommitSummary>;
  not_found: string[];
}

export interface MachineInfo {
  name: string;
  info: Record<string, string>;
}

export interface RunInfo {
  uuid: string;
  machine: string;
  commit: string;
  submitted_at: string | null;
  run_parameters?: Record<string, string>;
}

/** Run as returned by GET /machines/{name}/runs. */
export interface MachineRunInfo {
  uuid: string;
  commit: string;
  submitted_at: string | null;
}

export interface RunDetail {
  uuid: string;
  machine: string;
  commit: string;
  submitted_at: string | null;
  run_parameters: Record<string, string>;
}

export interface SampleInfo {
  test: string;
  has_profile: boolean;
  metrics: Record<string, number | null>;
}

export interface FieldChangeInfo {
  uuid: string;
  test: string | null;
  machine: string | null;
  metric: string | null;
  old_value: number;
  new_value: number;
  start_commit: string | null;
  end_commit: string | null;
}

export interface QueryDataPoint {
  test: string;
  machine: string;
  metric: string;
  value: number;
  commit: string;
  ordinal: number | null;
  run_uuid: string;
  submitted_at: string | null;
}

export interface CursorPaginated<T> {
  items: T[];
  cursor: {
    next: string | null;
    previous: string | null;
  };
}

export interface OffsetPaginated<T> {
  items: T[];
  total: number;
  cursor: {
    next: string | null;
    previous: string | null;
  };
}

// App state

export type AggFn = 'median' | 'mean' | 'min' | 'max';
export type SortDir = 'asc' | 'desc';
export type SortCol = 'test' | 'value_a' | 'value_b' | 'delta' | 'delta_pct' | 'ratio' | 'status';

export interface SideSelection {
  suite: string;
  commit: string;
  machine: string;
  runs: string[];     // UUIDs
  runAgg: AggFn;
}

export interface AppState {
  sideA: SideSelection;
  sideB: SideSelection;
  metric: string;
  sampleAgg: AggFn;
  noise: number;       // percentage (e.g. 1 = 1%)
  sort: SortCol;
  sortDir: SortDir;
  testFilter: string;
  hideNoise: boolean;
}

// Comparison results

export type RowStatus = 'improved' | 'regressed' | 'unchanged' | 'noise' | 'missing' | 'na';

export interface ComparisonRow {
  test: string;
  valueA: number | null;
  valueB: number | null;
  delta: number | null;
  deltaPct: number | null;
  ratio: number | null;
  status: RowStatus;
  sidePresent: 'both' | 'a_only' | 'b_only';
}

// Admin types

export interface APIKeyItem {
  prefix: string;
  name: string;
  scope: string;
  created_at: string;
  last_used_at: string | null;
  is_active: boolean;
}

export interface APIKeyCreateResponse {
  key: string;
  prefix: string;
  scope: string;
}

export interface TestSuiteInfo {
  name: string;
  schema: {
    metrics: FieldInfo[];
    commit_fields: Array<{ name: string; type: string; display?: boolean }>;
    machine_fields: Array<{ name: string; type: string }>;
  };
}

// Regression types

export type RegressionState =
  | 'detected'
  | 'active'
  | 'not_to_be_fixed'
  | 'fixed'
  | 'false_positive';

export interface RegressionIndicator {
  uuid: string;
  machine: string | null;
  test: string | null;
  metric: string;
}

/** Regression as returned by GET /regressions (list endpoint). */
export interface RegressionListItem {
  uuid: string;
  title: string | null;
  bug: string | null;
  state: RegressionState;
  commit: string | null;
  machine_count: number;
  test_count: number;
}

/** Regression as returned by GET /regressions/{uuid} (detail endpoint). */
export interface RegressionDetail {
  uuid: string;
  title: string | null;
  bug: string | null;
  notes: string | null;
  state: RegressionState;
  commit: string | null;
  indicators: RegressionIndicator[];
}
