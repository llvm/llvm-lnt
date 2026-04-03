// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { setCachedData, getMetricFields } from '../selection';
import type { FieldInfo } from '../types';

function makeField(overrides: Partial<FieldInfo> & { name: string }): FieldInfo {
  return {
    type: 'Real',
    display_name: null,
    unit: null,
    unit_abbrev: null,
    bigger_is_better: null,
    ...overrides,
  };
}

describe('getMetricFields', () => {
  beforeEach(() => {
    setCachedData([], [], 'test-suite');
  });

  it('returns only Real-typed fields', () => {
    const fields: FieldInfo[] = [
      makeField({ name: 'exec_time', type: 'Real' }),
      makeField({ name: 'score', type: 'Real' }),
      makeField({ name: 'hash', type: 'Status' }),
    ];
    setCachedData([], fields, 'test-suite');

    const result = getMetricFields();

    expect(result).toHaveLength(2);
    expect(result.map(f => f.name)).toEqual(['exec_time', 'score']);
  });

  it('excludes Status-typed fields', () => {
    const fields: FieldInfo[] = [
      makeField({ name: 'hash', type: 'Status' }),
      makeField({ name: 'status_field', type: 'Status' }),
    ];
    setCachedData([], fields, 'test-suite');

    const result = getMetricFields();

    expect(result).toHaveLength(0);
  });

  it('returns empty array when no fields exist', () => {
    setCachedData([], [], 'test-suite');

    const result = getMetricFields();

    expect(result).toEqual([]);
  });

  it('preserves field order from input', () => {
    const fields: FieldInfo[] = [
      makeField({ name: 'z_metric', type: 'Real' }),
      makeField({ name: 'non_metric', type: 'Status' }),
      makeField({ name: 'a_metric', type: 'Real' }),
      makeField({ name: 'm_metric', type: 'Real' }),
    ];
    setCachedData([], fields, 'test-suite');

    const result = getMetricFields();

    expect(result.map(f => f.name)).toEqual(['z_metric', 'a_metric', 'm_metric']);
  });
});
