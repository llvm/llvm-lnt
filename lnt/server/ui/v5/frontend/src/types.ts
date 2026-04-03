// v5 API response types

export interface FieldInfo {
  name: string;
  type: string;
  display_name: string | null;
  unit: string | null;
  unit_abbrev: string | null;
  bigger_is_better: boolean | null;
}

export interface OrderSummary {
  fields: Record<string, string>;
  tag: string | null;
}

export interface OrderDetail {
  fields: Record<string, string>;
  tag: string | null;
  previous_order: OrderNeighbor | null;
  next_order: OrderNeighbor | null;
}

export interface OrderNeighbor {
  fields: Record<string, string>;
  link: string;
}

export interface MachineInfo {
  name: string;
  info: Record<string, string>;
}

export interface RunInfo {
  uuid: string;
  machine: string;
  order: Record<string, string>;
  start_time: string | null;
  end_time: string | null;
  parameters?: Record<string, string>;
}

/** Run as returned by GET /machines/{name}/runs (no machine or parameters). */
export interface MachineRunInfo {
  uuid: string;
  order: Record<string, string>;
  start_time: string | null;
  end_time: string | null;
}

export interface RunDetail {
  uuid: string;
  machine: string;
  order: Record<string, string>;
  start_time: string | null;
  end_time: string | null;
  parameters: Record<string, string>;
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
  start_order: string | null;
  end_order: string | null;
  run_uuid: string | null;
}

export interface QueryDataPoint {
  test: string;
  machine: string;
  metric: string;
  value: number;
  order: Record<string, string>;
  run_uuid: string;
  timestamp: string | null;
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
  order: string;
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
    run_fields: Array<{ name: string; type: string }>;
    order_fields: Array<{ name: string; type: string }>;
    machine_fields: Array<{ name: string; type: string }>;
  };
}
