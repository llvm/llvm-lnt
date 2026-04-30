// components/metric-selector.ts — Reusable metric drop-down.

import { el } from '../utils';
import type { FieldInfo } from '../types';

/**
 * Valid v5 metric types. Must match the backend's VALID_METRIC_TYPES
 * in lnt/server/db/v5/schema.py.
 */
export const METRIC_TYPES = { REAL: 'real', STATUS: 'status', HASH: 'hash' } as const;

/** Filter fields to only plottable numeric metrics (type === 'real'). */
export function filterMetricFields(fields: FieldInfo[]): FieldInfo[] {
  return fields.filter(f => f.type === METRIC_TYPES.REAL);
}

export interface MetricSelectorOptions {
  /** When true, prepend a "-- Select metric --" placeholder with empty value. */
  placeholder?: boolean;
}

/**
 * Create a metric selector dropdown from the given fields.
 * Callers should pre-filter with filterMetricFields() if needed.
 * If initialValue matches a field name, that option is pre-selected.
 * Returns the effective initial metric name ('' when placeholder is active).
 */
/**
 * Render a disabled metric dropdown with a placeholder option.
 * Used when no suite is selected yet and metrics aren't available.
 */
export function renderEmptyMetricSelector(container: HTMLElement): void {
  const group = el('div', { class: 'control-group' });
  group.append(el('label', {}, 'Metric'));
  const select = el('select', { class: 'metric-select', disabled: '' }) as HTMLSelectElement;
  select.append(el('option', { value: '' }, '-- Select metric --'));
  group.append(select);
  container.append(group);
}

export function renderMetricSelector(
  container: HTMLElement,
  fields: FieldInfo[],
  onChange: (metric: string) => void,
  initialValue?: string,
  options?: MetricSelectorOptions,
): string {
  if (fields.length === 0) return '';

  const group = el('div', { class: 'control-group' });
  group.append(el('label', {}, 'Metric'));
  const select = el('select', { class: 'metric-select' }) as HTMLSelectElement;

  if (options?.placeholder) {
    select.append(el('option', { value: '' }, '-- Select metric --'));
  }

  for (const f of fields) {
    const opt = el('option', { value: f.name }, f.display_name || f.name);
    if (initialValue && f.name === initialValue) (opt as HTMLOptionElement).selected = true;
    select.append(opt);
  }
  select.addEventListener('change', () => onChange(select.value));
  group.append(select);
  container.append(group);

  return select.value;
}
