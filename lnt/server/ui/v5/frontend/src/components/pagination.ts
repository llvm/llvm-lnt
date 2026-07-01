// components/pagination.ts — Previous/Next pagination controls.

import { el } from '../utils';

export interface PaginationOptions {
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  rangeText?: string;
}

/**
 * Render pagination controls (Previous / Next buttons + optional range text).
 */
export function renderPagination(
  container: HTMLElement,
  options: PaginationOptions,
): void {
  const row = el('div', { class: 'pagination-controls' });

  const prevBtn = el('button', {
    class: 'pagination-btn',
  }, '\u2190 Previous') as HTMLButtonElement;
  if (!options.hasPrevious) prevBtn.disabled = true;
  prevBtn.addEventListener('click', options.onPrevious);

  const nextBtn = el('button', {
    class: 'pagination-btn',
  }, 'Next \u2192') as HTMLButtonElement;
  if (!options.hasNext) nextBtn.disabled = true;
  nextBtn.addEventListener('click', options.onNext);

  row.append(prevBtn);
  if (options.rangeText) {
    row.append(el('span', { class: 'pagination-range' }, options.rangeText));
  }
  row.append(nextBtn);
  container.append(row);
}
