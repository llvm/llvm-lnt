import { describe, it, expect } from 'vitest';
import { buildCsv } from '../csvExport';
import type { ComparisonRow } from '../types';
import type { GeomeanResult } from '../comparison';

function row(overrides: Partial<ComparisonRow> & { test: string }): ComparisonRow {
  return {
    valueA: 100, valueB: 110, delta: 10, deltaPct: 10, ratio: 1.1,
    status: 'regressed', sidePresent: 'both', noiseReasons: [],
    ...overrides,
  };
}

describe('buildCsv', () => {
  it('produces correct header row', () => {
    const csv = buildCsv([], null);
    expect(csv).toBe('Test,Value A,Value B,Delta,Delta %,Ratio,Status');
  });

  it('includes geomean row when provided', () => {
    const geomean: GeomeanResult = {
      geomeanA: 100, geomeanB: 105, delta: 5, deltaPct: 5, ratioGeomean: 1.05,
    };
    const lines = buildCsv([], geomean).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('Geomean');
    expect(lines[1]).toContain('1.0500');
  });

  it('omits geomean row when null', () => {
    const lines = buildCsv([row({ test: 'foo' })], null).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^foo,/);
  });

  it('formats data rows using format functions', () => {
    const lines = buildCsv([
      row({ test: 'bench/algo', valueA: 100, valueB: 110, delta: 10, deltaPct: 10, ratio: 1.1, status: 'regressed' }),
    ], null).split('\n');
    expect(lines[1]).toBe('bench/algo,100.0,110.0,10.00,+10.00%,1.1000,regressed');
  });

  it('renders null values as N/A', () => {
    const lines = buildCsv([
      row({ test: 'x', valueA: 0, valueB: null, delta: null, deltaPct: null, ratio: null, status: 'na' }),
    ], null).split('\n');
    expect(lines[1]).toBe('x,0,N/A,N/A,N/A,N/A,na');
  });

  it('quotes fields containing commas', () => {
    const lines = buildCsv([row({ test: 'std::map<int, int>::find' })], null).split('\n');
    expect(lines[1]).toMatch(/^"std::map<int, int>::find"/);
  });

  it('quotes and escapes fields containing double quotes', () => {
    const lines = buildCsv([row({ test: 'test "quoted" name' })], null).split('\n');
    expect(lines[1]).toMatch(/^"test ""quoted"" name"/);
  });

  it('quotes fields containing newlines', () => {
    const csv = buildCsv([row({ test: 'line1\nline2' })], null);
    // Can't split on \n since the field itself contains one.
    // The quoted field should appear after the header line.
    expect(csv).toContain('"line1\nline2"');
  });

  it('preserves row ordering', () => {
    const rows = [row({ test: 'b' }), row({ test: 'a' }), row({ test: 'c' })];
    const lines = buildCsv(rows, null).split('\n');
    expect(lines[1]).toMatch(/^b,/);
    expect(lines[2]).toMatch(/^a,/);
    expect(lines[3]).toMatch(/^c,/);
  });
});
