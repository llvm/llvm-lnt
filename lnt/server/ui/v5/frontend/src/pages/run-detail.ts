// pages/run-detail.ts — Single run metadata, samples table with progressive
// loading, test filter, metric selector, and run deletion.

import type { PageModule, RouteParams } from '../router';
import type { SampleInfo } from '../types';
import { getRun, getFields, deleteRun, fetchOneCursorPage, apiUrl } from '../api';
import { el, spaLink, agnosticLink, formatValue, formatTime, primaryOrderValue, debounce } from '../utils';
import { navigate } from '../router';
import { renderDataTable } from '../components/data-table';
import { renderMetricSelector, filterMetricFields } from '../components/metric-selector';
import { renderDeleteConfirm } from '../components/delete-confirm';

/** Instance-scoped abort controller for the current mount's sample fetches. */
let activeFetchController: AbortController | null = null;

export const runDetailPage: PageModule = {
  mount(container: HTMLElement, params: RouteParams): void {
    // Abort any in-flight fetches from a previous mount before creating a new controller.
    if (activeFetchController) activeFetchController.abort();
    activeFetchController = new AbortController();

    const ts = params.testsuite;
    const uuid = params.uuid;

    container.append(el('h2', { class: 'page-header' }, `Run: ${uuid.slice(0, 8)}\u2026`));

    const metaContainer = el('div', {});
    const actionsContainer = el('div', { class: 'action-links' });
    const controlsContainer = el('div', { class: 'global-controls' });
    const filterContainer = el('div', { class: 'table-controls' });
    const summaryContainer = el('div', {});
    const tableContainer = el('div', {});
    const deleteContainer = el('div', { class: 'delete-machine-section' });
    container.append(
      metaContainer, actionsContainer, controlsContainer,
      filterContainer, summaryContainer, tableContainer, deleteContainer,
    );

    const loading = el('p', { class: 'progress-label' }, 'Loading run data...');
    container.append(loading);

    let allSamples: SampleInfo[] = [];
    let currentMetric = '';
    let testFilter = '';
    let machineName = '';

    Promise.all([
      getRun(ts, uuid),
      getFields(ts),
    ]).then(([run, fields]) => {
      loading.remove();
      machineName = run.machine;

      // Metadata
      const dl = el('dl', { class: 'metadata-dl' });
      dl.append(el('dt', {}, 'UUID'), el('dd', {}, run.uuid));

      const machineDd = el('dd', {});
      machineDd.append(spaLink(run.machine, `/machines/${encodeURIComponent(run.machine)}`));
      dl.append(el('dt', {}, 'Machine'), machineDd);

      const orderValue = primaryOrderValue(run.order);
      const orderDd = el('dd', {});
      orderDd.append(spaLink(orderValue, `/orders/${encodeURIComponent(orderValue)}`));
      dl.append(el('dt', {}, 'Order'), orderDd);

      dl.append(el('dt', {}, 'Start Time'), el('dd', {}, formatTime(run.start_time)));
      dl.append(el('dt', {}, 'End Time'), el('dd', {}, formatTime(run.end_time)));

      for (const [k, v] of Object.entries(run.parameters || {})) {
        dl.append(el('dt', {}, k), el('dd', {}, v));
      }
      metaContainer.append(dl);

      // Actions
      const compareLink = agnosticLink(
        'Compare with\u2026',
        `/compare?suite_a=${encodeURIComponent(ts)}&machine_a=${encodeURIComponent(run.machine)}&order_a=${encodeURIComponent(orderValue)}&runs_a=${encodeURIComponent(uuid)}`,
      );
      compareLink.classList.add('action-link');
      actionsContainer.append(compareLink);

      // Metric selector
      currentMetric = renderMetricSelector(controlsContainer, filterMetricFields(fields), (metric) => {
        currentMetric = metric;
        renderSamplesTable();
      });

      // Test filter
      const filterInput = el('input', {
        type: 'text',
        class: 'test-filter-input',
        placeholder: 'Filter tests...',
      }) as HTMLInputElement;
      const doFilter = debounce(() => {
        testFilter = filterInput.value.toLowerCase();
        renderSamplesTable();
      }, 200);
      filterInput.addEventListener('input', () => doFilter());
      filterContainer.append(filterInput);

      // Progressive sample loading
      loadSamplesProgressively(ts, uuid);

      // Delete section
      const shortUuid = uuid.slice(0, 8);
      renderDeleteConfirm(deleteContainer, {
        label: 'Delete Run',
        prompt: `Type "${shortUuid}" to confirm deletion. This will delete the run and all its samples.`,
        confirmValue: shortUuid,
        placeholder: 'Run UUID prefix',
        onDelete: () => deleteRun(ts, uuid),
        onSuccess: () => navigate(`/machines/${encodeURIComponent(machineName)}`),
      });
    }).catch(e => {
      loading.remove();
      container.append(el('p', { class: 'error-banner' }, `Failed to load run: ${e}`));
    });

    async function loadSamplesProgressively(tsName: string, runUuid: string): Promise<void> {
      const { signal } = activeFetchController!;
      const progressEl = el('p', { class: 'progress-label' }, 'Loading samples...');
      summaryContainer.append(progressEl);

      let cursor: string | null = null;
      try {
        do {
          const params: Record<string, string> = { limit: '2000' };
          if (cursor) params.cursor = cursor;
          const page = await fetchOneCursorPage<SampleInfo>(
            apiUrl(tsName, `runs/${encodeURIComponent(runUuid)}/samples`),
            params,
            signal,
          );
          allSamples.push(...page.items);
          cursor = page.nextCursor;
          progressEl.textContent = `Loading samples: ${allSamples.length}${cursor ? '...' : ''}`;
          renderSamplesTable();
        } while (cursor);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        summaryContainer.replaceChildren(
          el('p', { class: 'error-banner' }, `Failed to load samples: ${err}`),
        );
        return;
      }
      progressEl.remove();
    }

    let filterMessage: HTMLElement | null = null;

    function filteredSamples(): SampleInfo[] {
      if (!testFilter) return allSamples;
      return allSamples.filter(s => s.test.toLowerCase().includes(testFilter));
    }

    function renderSamplesTable(): void {
      const visible = filteredSamples();

      if (filterMessage) { filterMessage.remove(); filterMessage = null; }
      if (testFilter && visible.length !== allSamples.length) {
        filterMessage = el('p', { class: 'table-message' },
          `${visible.length} of ${allSamples.length} samples matching`);
        summaryContainer.prepend(filterMessage);
      }

      tableContainer.replaceChildren();
      renderDataTable(tableContainer, {
        columns: [
          { key: 'test', label: 'Test', cellClass: 'col-test',
            render: (s: SampleInfo) => s.test },
          { key: 'value', label: 'Value', cellClass: 'col-num',
            render: (s: SampleInfo) => formatValue(s.metrics[currentMetric] !== undefined ? s.metrics[currentMetric] : null),
            sortValue: (s: SampleInfo) => s.metrics[currentMetric] ?? null },
        ],
        rows: visible,
        sortKey: 'test',
        sortDir: 'asc',
        emptyMessage: testFilter ? 'No samples matching filter.' : 'No samples found.',
      });
    }
  },

  unmount(): void {
    if (activeFetchController) {
      activeFetchController.abort();
      activeFetchController = null;
    }
  },
};
