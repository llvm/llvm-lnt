// components/profile-stats.ts — Top-level counter comparison bar for profiles.

import { el } from '../utils';

/**
 * Render a top-level counter comparison table.
 *
 * Single-profile mode (only countersA): simple name | value table.
 * Comparison mode (both sides): name | value A | value B | delta % with bar.
 */
export function renderProfileStats(
  container: HTMLElement,
  countersA: Record<string, number>,
  countersB?: Record<string, number>,
): { destroy: () => void } {
  container.replaceChildren();

  const allNames = new Set([
    ...Object.keys(countersA),
    ...(countersB ? Object.keys(countersB) : []),
  ]);

  if (allNames.size === 0) {
    container.append(el('p', { class: 'no-results' }, 'No counters available.'));
    return { destroy() {} };
  }

  const table = el('table', { class: 'profile-stats' });
  const thead = el('thead');
  const tbody = el('tbody');

  if (countersB) {
    // Comparison mode
    const headerRow = el('tr');
    headerRow.append(
      el('th', {}, 'Counter'),
      el('th', {}, 'A'),
      el('th', {}, 'B'),
      el('th', {}, 'Delta'),
    );
    thead.append(headerRow);

    for (const name of sorted(allNames)) {
      const a = countersA[name] ?? null;
      const b = countersB[name] ?? null;
      const row = el('tr');

      row.append(el('td', {}, name));
      row.append(el('td', { class: 'profile-stats-value' }, a !== null ? formatCounter(a) : '--'));
      row.append(el('td', { class: 'profile-stats-value' }, b !== null ? formatCounter(b) : '--'));

      if (a !== null && b !== null && a !== 0) {
        const deltaPct = ((b - a) / a) * 100;
        const isImproved = deltaPct < 0; // lower is better
        const cls = isImproved ? 'profile-stats-improved' : deltaPct > 0 ? 'profile-stats-regressed' : '';

        const deltaCell = el('td', { class: `profile-stats-delta ${cls}` });
        deltaCell.append(el('span', {}, `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%`));

        // CSS bar proportional to |deltaPct|, capped at 100%
        const barWidth = Math.min(Math.abs(deltaPct), 100);
        const bar = el('div', { class: 'profile-stats-bar' });
        bar.style.width = `${barWidth}%`;
        deltaCell.append(bar);

        row.append(deltaCell);
      } else {
        row.append(el('td', { class: 'profile-stats-delta' }, '--'));
      }

      tbody.append(row);
    }
  } else {
    // Single-profile mode
    const headerRow = el('tr');
    headerRow.append(el('th', {}, 'Counter'), el('th', {}, 'Value'));
    thead.append(headerRow);

    for (const name of sorted(allNames)) {
      const val = countersA[name] ?? null;
      const row = el('tr');
      row.append(el('td', {}, name));
      row.append(el('td', { class: 'profile-stats-value' }, val !== null ? formatCounter(val) : '--'));
      tbody.append(row);
    }
  }

  table.append(thead, tbody);
  container.append(table);

  return { destroy() {} };
}

function formatCounter(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toFixed(2);
}

function sorted(names: Set<string>): string[] {
  return [...names].sort();
}
