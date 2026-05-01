import type { ComparisonRow } from './types';
import type { GeomeanResult } from './comparison';
import { formatValue, formatPercent, formatRatio } from './utils';

function csvField(v: string): string {
  if (v.includes(',') || v.includes('"') || v.includes('\n') || v.includes('\r')) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

function csvRow(fields: string[]): string {
  return fields.map(csvField).join(',');
}

export function buildCsv(rows: ComparisonRow[], geomean: GeomeanResult | null): string {
  const lines: string[] = [
    csvRow(['Test', 'Value A', 'Value B', 'Delta', 'Delta %', 'Ratio', 'Status']),
  ];

  if (geomean) {
    lines.push(csvRow([
      'Geomean',
      formatValue(geomean.geomeanA),
      formatValue(geomean.geomeanB),
      formatValue(geomean.delta),
      formatPercent(geomean.deltaPct),
      formatRatio(geomean.ratioGeomean),
      '',
    ]));
  }

  for (const r of rows) {
    lines.push(csvRow([
      r.test,
      formatValue(r.valueA),
      formatValue(r.valueB),
      formatValue(r.delta),
      formatPercent(r.deltaPct),
      formatRatio(r.ratio),
      r.status,
    ]));
  }

  return lines.join('\n');
}
