// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the API module
vi.mock('../api', () => ({
  getFields: vi.fn(),
  getOrders: vi.fn(),
  getRuns: vi.fn(),
}));

import { getFields, getOrders } from '../api';
import { initSelection, fetchSideData, getMetricFields } from '../selection';
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
    vi.clearAllMocks();
    initSelection(['test-suite']);
    // Default: both API calls resolve with empty data
    (getFields as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (getOrders as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it('returns only Real-typed fields', async () => {
    const fields: FieldInfo[] = [
      makeField({ name: 'exec_time', type: 'Real' }),
      makeField({ name: 'score', type: 'Real' }),
      makeField({ name: 'hash', type: 'Status' }),
    ];
    (getFields as ReturnType<typeof vi.fn>).mockResolvedValue(fields);

    await fetchSideData('a', 'test-suite');

    const result = getMetricFields();

    expect(result).toHaveLength(2);
    expect(result.map(f => f.name)).toEqual(['exec_time', 'score']);
  });

  it('excludes Status-typed fields', async () => {
    const fields: FieldInfo[] = [
      makeField({ name: 'hash', type: 'Status' }),
      makeField({ name: 'status_field', type: 'Status' }),
    ];
    (getFields as ReturnType<typeof vi.fn>).mockResolvedValue(fields);

    await fetchSideData('a', 'test-suite');

    const result = getMetricFields();

    expect(result).toHaveLength(0);
  });

  it('returns empty array when no fields exist', () => {
    // initSelection already cleared fields
    const result = getMetricFields();

    expect(result).toEqual([]);
  });

  it('preserves field order from input', async () => {
    const fields: FieldInfo[] = [
      makeField({ name: 'z_metric', type: 'Real' }),
      makeField({ name: 'non_metric', type: 'Status' }),
      makeField({ name: 'a_metric', type: 'Real' }),
      makeField({ name: 'm_metric', type: 'Real' }),
    ];
    (getFields as ReturnType<typeof vi.fn>).mockResolvedValue(fields);

    await fetchSideData('a', 'test-suite');

    const result = getMetricFields();

    expect(result.map(f => f.name)).toEqual(['z_metric', 'a_metric', 'm_metric']);
  });
});
