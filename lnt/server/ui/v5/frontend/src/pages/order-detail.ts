// pages/order-detail.ts — Order detail with tag editing, prev/next, machine filter, runs table.

import type { PageModule, RouteParams } from '../router';
import type { RunInfo, OrderDetail } from '../types';
import { getOrder, getRunsByOrder, updateOrderTag, authErrorMessage } from '../api';
import { el, spaLink, formatTime, primaryOrderValue, debounce } from '../utils';
import { navigate } from '../router';
import { renderDataTable } from '../components/data-table';

let controller: AbortController | null = null;

export const orderDetailPage: PageModule = {
  mount(container: HTMLElement, params: RouteParams): void {
    if (controller) controller.abort();
    controller = new AbortController();
    const { signal } = controller;

    const ts = params.testsuite;
    const orderValue = params.value;

    container.append(el('h2', { class: 'page-header' }, `Order: ${orderValue}`));

    const fieldsContainer = el('div', { class: 'order-fields' });
    const tagContainer = el('div', { class: 'tag-display' });
    const navContainer = el('div', { class: 'order-nav' });
    const summaryContainer = el('div', {});
    const filterContainer = el('div', { class: 'table-controls' });
    const tableContainer = el('div', {});
    container.append(
      fieldsContainer, tagContainer, navContainer,
      summaryContainer, filterContainer, tableContainer,
    );

    const loading = el('p', { class: 'progress-label' }, 'Loading order data...');
    container.append(loading);

    let runs: RunInfo[] = [];
    let machineFilter = '';

    Promise.all([
      getOrder(ts, orderValue, signal),
      getRunsByOrder(ts, orderValue, signal),
    ]).then(([order, orderRuns]) => {
      loading.remove();
      runs = orderRuns;

      // Order fields
      const dl = el('dl', { class: 'metadata-dl' });
      for (const [k, v] of Object.entries(order.fields)) {
        dl.append(el('dt', {}, k), el('dd', {}, v || ''));
      }
      fieldsContainer.append(dl);

      // Tag display + edit
      renderTag(tagContainer, ts, orderValue, order);

      // Prev/Next navigation
      if (order.previous_order) {
        const prevValue = primaryOrderValue(order.previous_order.fields);
        const prevBtn = el('button', { class: 'pagination-btn' }, '\u2190 Previous');
        prevBtn.addEventListener('click', () => navigate(`/orders/${encodeURIComponent(prevValue)}`));
        navContainer.append(prevBtn);
      }
      if (order.next_order) {
        const nextValue = primaryOrderValue(order.next_order.fields);
        const nextBtn = el('button', { class: 'pagination-btn' }, 'Next \u2192');
        nextBtn.addEventListener('click', () => navigate(`/orders/${encodeURIComponent(nextValue)}`));
        navContainer.append(nextBtn);
      }

      // Machine filter
      const filterInput = el('input', {
        type: 'text',
        class: 'test-filter-input',
        placeholder: 'Filter machines...',
      }) as HTMLInputElement;
      const doFilter = debounce(() => {
        machineFilter = filterInput.value.toLowerCase();
        renderSummaryAndTable();
      }, 200);
      filterInput.addEventListener('input', () => doFilter());
      filterContainer.append(filterInput);

      renderSummaryAndTable();
    }).catch(e => {
      loading.remove();
      container.append(el('p', { class: 'error-banner' }, `Failed to load order: ${e}`));
    });

    function filteredRuns(): RunInfo[] {
      if (!machineFilter) return runs;
      return runs.filter(r => r.machine.toLowerCase().includes(machineFilter));
    }

    function renderSummaryAndTable(): void {
      const visible = filteredRuns();
      const allMachines = new Set(runs.map(r => r.machine));
      const visibleMachines = new Set(visible.map(r => r.machine));

      summaryContainer.replaceChildren();
      if (machineFilter && visible.length !== runs.length) {
        summaryContainer.append(el('p', {},
          `${visible.length} of ${runs.length} run${runs.length !== 1 ? 's' : ''} across ${visibleMachines.size} of ${allMachines.size} machine${allMachines.size !== 1 ? 's' : ''}`
        ));
      } else {
        summaryContainer.append(el('p', {},
          `${runs.length} run${runs.length !== 1 ? 's' : ''} across ${allMachines.size} machine${allMachines.size !== 1 ? 's' : ''}`
        ));
      }

      tableContainer.replaceChildren();
      renderDataTable(tableContainer, {
        columns: [
          { key: 'machine', label: 'Machine',
            render: (r: RunInfo) => spaLink(r.machine, `/machines/${encodeURIComponent(r.machine)}`) },
          { key: 'uuid', label: 'Run UUID',
            render: (r: RunInfo) => spaLink(r.uuid.slice(0, 8), `/runs/${encodeURIComponent(r.uuid)}`) },
          { key: 'start_time', label: 'Start Time',
            render: (r: RunInfo) => formatTime(r.start_time) },
        ],
        rows: visible,
        emptyMessage: machineFilter ? 'No runs matching filter.' : 'No runs at this order.',
      });
    }
  },

  unmount(): void {
    if (controller) { controller.abort(); controller = null; }
  },
};

function renderTag(
  container: HTMLElement,
  ts: string,
  orderValue: string,
  order: OrderDetail,
): void {
  container.replaceChildren();

  const tagLabel = el('strong', {}, 'Tag: ');
  const tagValue = el('span', {}, order.tag || '(none)');
  const editBtn = el('button', { class: 'pagination-btn' }, 'Edit');
  container.append(tagLabel, tagValue, editBtn);

  editBtn.addEventListener('click', () => {
    container.replaceChildren();
    container.append(el('strong', {}, 'Tag: '));

    const input = el('input', {
      type: 'text',
      class: 'tag-edit-input combobox-input',
      placeholder: 'Enter tag (max 64 chars)...',
      maxlength: '64',
    }) as HTMLInputElement;
    input.value = order.tag || '';
    input.style.width = '200px';

    const saveBtn = el('button', { class: 'compare-btn' }, 'Save') as HTMLButtonElement;
    const cancelBtn = el('button', { class: 'pagination-btn' }, 'Cancel');
    const errorEl = el('span', { class: 'error-banner', style: 'display:inline;margin-left:8px;padding:4px 8px' });

    container.append(input, saveBtn, cancelBtn, errorEl);
    input.focus();

    cancelBtn.addEventListener('click', () => renderTag(container, ts, orderValue, order));

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      errorEl.textContent = '';
      const newTag = input.value.trim() || null;
      try {
        const updated = await updateOrderTag(ts, orderValue, newTag);
        order.tag = updated.tag;
        renderTag(container, ts, orderValue, order);
      } catch (e: unknown) {
        errorEl.textContent = authErrorMessage(e);
        saveBtn.disabled = false;
      }
    });
  });
}
