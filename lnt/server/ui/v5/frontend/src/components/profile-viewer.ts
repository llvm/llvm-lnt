// components/profile-viewer.ts — Straight-line disassembly view with heat-map.

import { el } from '../utils';
import { heatGradient } from './profile-colors';
import type { ProfileFunctionDetail } from '../types';

export type DisplayMode = 'relative' | 'absolute' | 'cumulative';

export interface ProfileViewerOptions {
  counter: string;
  displayMode: DisplayMode;
  showAll?: boolean;  // preserve "show all" state across re-renders
}

const DEFAULT_ROW_CAP = 500;

/**
 * Render a straight-line disassembly table for a single function.
 *
 * Columns: Counter value (heat-map background) | Address (hex) | Instruction text.
 * Large functions are capped at DEFAULT_ROW_CAP with a "Show all" button.
 */
export function renderProfileViewer(
  container: HTMLElement,
  detail: ProfileFunctionDetail,
  options: ProfileViewerOptions,
): { destroy: () => void; isShowAll: () => boolean } {
  container.replaceChildren();
  const cleanups: Array<() => void> = [];

  const instructions = detail.instructions;
  if (instructions.length === 0) {
    container.append(el('p', { class: 'no-results' }, 'No instructions.'));
    return { destroy() {}, isShowAll: () => false };
  }

  const counterValues = computeValues(instructions, options.counter, options.displayMode);
  const maxValue = Math.max(...counterValues.map(Math.abs), 1e-10);

  let showAll = options.showAll ?? false;
  const capped = instructions.length > DEFAULT_ROW_CAP;

  function render(): void {
    container.replaceChildren();

    const table = el('table', { class: 'profile-disasm' });
    const thead = el('thead');
    const headerRow = el('tr');
    headerRow.append(
      el('th', { class: 'profile-disasm-heat' }, options.counter),
      el('th', { class: 'profile-disasm-addr' }, 'Address'),
      el('th', { class: 'profile-disasm-text' }, 'Instruction'),
    );
    thead.append(headerRow);
    table.append(thead);

    const tbody = el('tbody');
    const limit = (capped && !showAll) ? DEFAULT_ROW_CAP : instructions.length;

    for (let i = 0; i < limit; i++) {
      const inst = instructions[i];
      const value = counterValues[i];
      const row = el('tr');

      // Counter value cell with heat-map background
      const heatCell = el('td', { class: 'profile-disasm-heat' });
      heatCell.style.backgroundColor = heatGradient(Math.min(Math.abs(value) / maxValue, 1));
      heatCell.textContent = formatValue(value, options.displayMode);
      row.append(heatCell);

      // Address
      row.append(el('td', { class: 'profile-disasm-addr' }, `0x${inst.address.toString(16)}`));

      // Instruction text
      row.append(el('td', { class: 'profile-disasm-text' }, inst.text));

      tbody.append(row);
    }

    table.append(tbody);
    container.append(table);

    if (capped && !showAll) {
      const msg = el('div', { class: 'profile-row-cap' });
      msg.append(
        document.createTextNode(`Showing ${DEFAULT_ROW_CAP} of ${instructions.length} instructions. `),
      );
      const showAllBtn = el('button', { class: 'admin-btn' }, 'Show all');
      const handler = () => { showAll = true; render(); };
      showAllBtn.addEventListener('click', handler);
      cleanups.push(() => showAllBtn.removeEventListener('click', handler));
      msg.append(showAllBtn);
      container.append(msg);
    }
  }

  render();

  return {
    destroy() {
      for (const fn of cleanups) fn();
      cleanups.length = 0;
    },
    isShowAll: () => showAll,
  };
}

/**
 * Compute display values for each instruction based on the selected counter
 * and display mode.
 */
function computeValues(
  instructions: ProfileFunctionDetail['instructions'],
  counter: string,
  mode: DisplayMode,
): number[] {
  const raw = instructions.map(inst => inst.counters[counter] ?? 0);

  if (mode === 'absolute') return raw;

  if (mode === 'relative') {
    const total = raw.reduce((a, b) => a + b, 0);
    if (total === 0) return raw.map(() => 0);
    return raw.map(v => (v / total) * 100);
  }

  // cumulative
  const result: number[] = [];
  let sum = 0;
  for (const v of raw) {
    sum += v;
    result.push(sum);
  }
  return result;
}

function formatValue(value: number, mode: DisplayMode): string {
  if (mode === 'relative') return `${value.toFixed(1)}%`;
  if (mode === 'absolute') return value.toFixed(1);
  // cumulative
  return value.toFixed(1);
}
