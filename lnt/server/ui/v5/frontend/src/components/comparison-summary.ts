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

const CATEGORIES: Array<{ key: SummaryCategory; label: string; color: string; comparable: boolean }> = [
  { key: 'improved', label: 'Improved', color: STATUS_COLORS.improved, comparable: true },
  { key: 'regressed', label: 'Regressed', color: STATUS_COLORS.regressed, comparable: true },
  { key: 'noise', label: 'Noise', color: STATUS_COLORS.noise, comparable: true },
  { key: 'unchanged', label: 'Unchanged', color: STATUS_COLORS.unchanged, comparable: true },
  { key: 'onlyInA', label: 'Only in A', color: '#888888', comparable: false },
  { key: 'onlyInB', label: 'Only in B', color: '#888888', comparable: false },
  { key: 'na', label: 'N/A', color: '#888888', comparable: false },
];

function formatPct(n: number): string {
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

const PCT_TOOLTIP = 'Percentage of comparable tests (excludes Only in A, Only in B, N/A)';

export function renderSummaryBar(container: HTMLElement, counts: SummaryCounts): void {
  container.replaceChildren();

  if (counts.total === 0) return;

  const bar = el('div', { class: 'comparison-summary' });
  const comparable = counts.improved + counts.regressed + counts.noise + counts.unchanged;

  for (const cat of CATEGORIES) {
    const count = counts[cat.key];
    const showPct = cat.comparable && comparable > 0;
    const countText = showPct
      ? `${count} (${formatPct((count / comparable) * 100)}%)`
      : `${count}`;

    const dot = el('span', { class: 'summary-dot' });
    dot.style.backgroundColor = cat.color;

    const countAttrs: Record<string, string | boolean> = { class: 'summary-count' };
    if (showPct) countAttrs.title = PCT_TOOLTIP;

    const item = el('span',
      { class: count === 0 ? 'summary-item summary-item-zero' : 'summary-item' },
      dot,
      el('span', { class: 'summary-label' }, cat.label),
      el('span', countAttrs, countText),
    );

    bar.append(item);
  }

  container.append(bar);
}
