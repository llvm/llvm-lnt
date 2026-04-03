// pages/machine-list.ts — Searchable machine list with offset pagination.

import type { PageModule, RouteParams } from '../router';
import type { MachineInfo } from '../types';
import { getMachines } from '../api';
import { el, spaLink, debounce } from '../utils';
import { renderDataTable } from '../components/data-table';
import { renderPagination } from '../components/pagination';

const PAGE_SIZE = 25;

let controller: AbortController | null = null;

export const machineListPage: PageModule = {
  mount(container: HTMLElement, params: RouteParams): void {
    if (controller) controller.abort();
    controller = new AbortController();
    const { signal } = controller;

    const ts = params.testsuite;
    container.append(el('h2', { class: 'page-header' }, 'Machines'));

    // Search input
    const searchRow = el('div', { class: 'table-controls' });
    const searchInput = el('input', {
      type: 'text',
      class: 'test-filter-input',
      placeholder: 'Filter by name...',
    }) as HTMLInputElement;

    const urlSearch = new URLSearchParams(window.location.search).get('search') || '';
    searchInput.value = urlSearch;
    searchRow.append(searchInput);
    container.append(searchRow);

    const tableContainer = el('div', {});
    const paginationContainer = el('div', {});
    container.append(tableContainer, paginationContainer);

    let currentOffset = 0;
    let currentSearch = urlSearch;

    async function loadPage(): Promise<void> {
      tableContainer.replaceChildren();
      paginationContainer.replaceChildren();
      tableContainer.append(el('p', { class: 'progress-label' }, 'Loading machines...'));

      try {
        const result = await getMachines(ts, {
          nameContains: currentSearch || undefined,
          limit: PAGE_SIZE,
          offset: currentOffset,
        }, signal);

        tableContainer.replaceChildren();

        renderDataTable(tableContainer, {
          columns: [
            { key: 'name', label: 'Name',
              render: (m: MachineInfo) => spaLink(m.name, `/machines/${encodeURIComponent(m.name)}`) },
            { key: 'info', label: 'Info', sortable: false,
              render: (m: MachineInfo) => formatInfo(m) },
          ],
          rows: result.items,
          emptyMessage: 'No machines found.',
        });

        const start = currentOffset + 1;
        const end = currentOffset + result.items.length;
        if (result.total > 0) {
          renderPagination(paginationContainer, {
            hasPrevious: currentOffset > 0,
            hasNext: end < result.total,
            rangeText: `${start}\u2013${end} of ${result.total}`,
            onPrevious: () => { currentOffset = Math.max(0, currentOffset - PAGE_SIZE); loadPage(); },
            onNext: () => { currentOffset += PAGE_SIZE; loadPage(); },
          });
        }
      } catch (e: unknown) {
        tableContainer.replaceChildren();
        tableContainer.append(el('p', { class: 'error-banner' }, `Failed to load machines: ${e}`));
      }
    }

    const onSearchChange = debounce(() => {
      currentSearch = searchInput.value.trim();
      currentOffset = 0;
      const qs = currentSearch ? `?search=${encodeURIComponent(currentSearch)}` : '';
      window.history.replaceState(null, '', window.location.pathname + qs);
      loadPage();
    }, 300);

    searchInput.addEventListener('input', onSearchChange as EventListener);
    loadPage();
  },

  unmount(): void {
    if (controller) { controller.abort(); controller = null; }
  },
};

function formatInfo(m: MachineInfo): string {
  const entries = Object.entries(m.info || {});
  if (entries.length === 0) return '';
  return entries.slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(', ');
}
