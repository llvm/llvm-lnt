import type { ComparisonRow } from '../types';
import { el, STATUS_COLORS, matchesFilter } from '../utils';

export interface SummaryCounts {
  improved: number;
  regressed: number;
  noise: number;
  unchanged: number;
  onlyInA: number;
  onlyInB: number;
  na: number;
  total: number;
}

type SummaryCategory = Exclude<keyof SummaryCounts, 'total'>;

export function computeSummaryCounts(
  rows: ComparisonRow[],
  textFilter: string,
  zoomFilter: Set<string> | null,
): SummaryCounts {
  const counts: SummaryCounts = {
    improved: 0, regressed: 0, noise: 0, unchanged: 0,
    onlyInA: 0, onlyInB: 0, na: 0, total: 0,
  };

  for (const r of rows) {
    if (textFilter && !matchesFilter(r.test, textFilter)) continue;
    if (zoomFilter && !zoomFilter.has(r.test)) continue;

    switch (r.status) {
      case 'improved': counts.improved++; break;
      case 'regressed': counts.regressed++; break;
      case 'noise': counts.noise++; break;
      case 'unchanged': counts.unchanged++; break;
      case 'missing':
        if (r.sidePresent === 'a_only') counts.onlyInA++;
        else counts.onlyInB++;
        break;
      case 'na': counts.na++; break;
    }
    counts.total++;
  }

  return counts;
}

const CATEGORIES: Array<{ key: SummaryCategory; label: string; color: string }> = [
  { key: 'improved', label: 'Improved', color: STATUS_COLORS.improved },
  { key: 'regressed', label: 'Regressed', color: STATUS_COLORS.regressed },
  { key: 'noise', label: 'Noise', color: STATUS_COLORS.noise },
  { key: 'unchanged', label: 'Unchanged', color: STATUS_COLORS.unchanged },
  { key: 'onlyInA', label: 'Only in A', color: '#888888' },
  { key: 'onlyInB', label: 'Only in B', color: '#888888' },
  { key: 'na', label: 'N/A', color: '#888888' },
];

export function renderSummaryBar(container: HTMLElement, counts: SummaryCounts): void {
  container.replaceChildren();

  if (counts.total === 0) return;

  const bar = el('div', { class: 'comparison-summary' });

  for (const cat of CATEGORIES) {
    const count = counts[cat.key];
    const pct = Math.round((count / counts.total) * 100);

    const dot = el('span', { class: 'summary-dot' });
    dot.style.backgroundColor = cat.color;

    const item = el('span',
      { class: count === 0 ? 'summary-item summary-item-zero' : 'summary-item' },
      dot,
      el('span', { class: 'summary-label' }, cat.label),
      el('span', { class: 'summary-count' }, `${count} (${pct}%)`),
    );

    bar.append(item);
  }

  container.append(bar);
}
