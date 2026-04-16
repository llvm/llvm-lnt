// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderMetricSelector, filterMetricFields, METRIC_TYPES } from '../components/metric-selector';
import type { FieldInfo } from '../types';

function makeField(name: string, type: string = METRIC_TYPES.REAL, displayName: string | null = null): FieldInfo {
  return { name, type, display_name: displayName, unit: null, unit_abbrev: null, bigger_is_better: null };
}

describe('filterMetricFields', () => {
  it('returns only real-typed fields', () => {
    const fields = [
      makeField('status', METRIC_TYPES.STATUS),
      makeField('compile_time', METRIC_TYPES.REAL),
      makeField('exec_time', METRIC_TYPES.REAL),
    ];
    const result = filterMetricFields(fields);
    expect(result).toHaveLength(2);
    expect(result.map(f => f.name)).toEqual(['compile_time', 'exec_time']);
  });

  it('returns empty array when no real fields', () => {
    const result = filterMetricFields([makeField('status', METRIC_TYPES.STATUS)]);
    expect(result).toHaveLength(0);
  });
});

describe('renderMetricSelector', () => {
  it('returns empty string and renders nothing when fields array is empty', () => {
    const container = document.createElement('div');
    const result = renderMetricSelector(container, [], vi.fn());

    expect(result).toBe('');
    expect(container.querySelector('select')).toBeNull();
  });

  it('renders all fields passed to it', () => {
    const container = document.createElement('div');
    renderMetricSelector(container, [
      makeField('compile_time'),
      makeField('exec_time'),
    ], vi.fn());

    const options = container.querySelectorAll('option');
    expect(options).toHaveLength(2);
  });

  it('returns the first field name as initial metric', () => {
    const container = document.createElement('div');
    const result = renderMetricSelector(container, [
      makeField('compile_time'),
      makeField('exec_time'),
    ], vi.fn());

    expect(result).toBe('compile_time');
  });

  it('uses display_name when available', () => {
    const container = document.createElement('div');
    renderMetricSelector(container, [
      makeField('ct', METRIC_TYPES.REAL, 'Compile Time'),
    ], vi.fn());

    const option = container.querySelector('option');
    expect(option!.textContent).toBe('Compile Time');
    expect(option!.getAttribute('value')).toBe('ct');
  });

  it('falls back to name when display_name is null', () => {
    const container = document.createElement('div');
    renderMetricSelector(container, [
      makeField('exec_time'),
    ], vi.fn());

    const option = container.querySelector('option');
    expect(option!.textContent).toBe('exec_time');
  });

  it('calls onChange with selected metric on change', () => {
    const onChange = vi.fn();
    const container = document.createElement('div');
    renderMetricSelector(container, [
      makeField('compile_time'),
      makeField('exec_time'),
    ], onChange);

    const select = container.querySelector('select') as HTMLSelectElement;
    select.value = 'exec_time';
    select.dispatchEvent(new Event('change'));

    expect(onChange).toHaveBeenCalledWith('exec_time');
  });

  it('shows placeholder option when placeholder: true', () => {
    const container = document.createElement('div');
    const result = renderMetricSelector(container, [
      makeField('compile_time'),
      makeField('exec_time'),
    ], vi.fn(), undefined, { placeholder: true });

    const options = container.querySelectorAll('option');
    expect(options).toHaveLength(3);
    expect(options[0].textContent).toBe('-- Select metric --');
    expect(options[0].getAttribute('value')).toBe('');
    expect(result).toBe('');
  });

  it('selects initialValue even with placeholder', () => {
    const container = document.createElement('div');
    const result = renderMetricSelector(container, [
      makeField('compile_time'),
      makeField('exec_time'),
    ], vi.fn(), 'exec_time', { placeholder: true });

    expect(result).toBe('exec_time');
  });
});
