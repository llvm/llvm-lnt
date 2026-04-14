// pages/machine-detail.ts — Machine metadata and run history.

import type { PageModule, RouteParams } from '../router';
import type { MachineRunInfo } from '../types';
import { getMachine, getMachineRuns, deleteMachine } from '../api';
import { el, spaLink, agnosticLink, agnosticUrl, formatTime, truncate } from '../utils';
import { renderDataTable } from '../components/data-table';
import { renderPagination } from '../components/pagination';
import { renderDeleteConfirm } from '../components/delete-confirm';

const PAGE_SIZE = 25;

let controller: AbortController | null = null;

export const machineDetailPage: PageModule = {
  mount(container: HTMLElement, params: RouteParams): void {
    if (controller) controller.abort();
    controller = new AbortController();
    const { signal } = controller;

    const ts = params.testsuite;
    const name = params.name;

    container.append(el('h2', { class: 'page-header' }, `Machine: ${name}`));

    const metaContainer = el('div', {});
    const actionsContainer = el('div', { class: 'action-links' });
    const runsContainer = el('div', {});
    const deleteContainer = el('div', { class: 'delete-machine-section' });
    container.append(metaContainer, actionsContainer, runsContainer, deleteContainer);

    // Load metadata
    getMachine(ts, name, signal).then(machine => {
      const entries = Object.entries(machine.info || {});
      if (entries.length > 0) {
        const dl = el('dl', { class: 'metadata-dl' });
        for (const [k, v] of entries) {
          dl.append(el('dt', {}, k), el('dd', {}, v));
        }
        metaContainer.append(dl);
      } else {
        metaContainer.append(el('p', { class: 'no-results' }, 'No metadata available.'));
      }
    }).catch(e => {
      metaContainer.append(el('p', { class: 'error-banner' }, `Failed to load machine: ${e}`));
    });

    // Action links
    const graphLink = agnosticLink('View Graph', `/graph?suite=${encodeURIComponent(ts)}&machine=${encodeURIComponent(name)}`);
    const compareLink = agnosticLink('Compare', `/compare?suite_a=${encodeURIComponent(ts)}&machine_a=${encodeURIComponent(name)}`);
    graphLink.classList.add('action-link');
    compareLink.classList.add('action-link');
    actionsContainer.append(graphLink, compareLink);

    // Load runs with cursor-stack pagination
    const cursorStack: string[] = [];
    let currentCursor: string | undefined;

    async function loadRuns(): Promise<void> {
      runsContainer.replaceChildren();
      runsContainer.append(el('h3', {}, 'Run History'));
      runsContainer.append(el('p', { class: 'progress-label' }, 'Loading runs...'));

      try {
        const result = await getMachineRuns(ts, name, {
          sort: '-submitted_at',
          limit: PAGE_SIZE,
          cursor: currentCursor,
        }, signal);

        runsContainer.replaceChildren();
        runsContainer.append(el('h3', {}, 'Run History'));

        const tableDiv = el('div', {});
        renderDataTable(tableDiv, {
          columns: [
            { key: 'uuid', label: 'Run UUID',
              render: (r: MachineRunInfo) => spaLink(r.uuid.slice(0, 8), `/runs/${encodeURIComponent(r.uuid)}`) },
            { key: 'commit', label: 'Commit',
              render: (r: MachineRunInfo) =>
                spaLink(truncate(r.commit, 12), `/commits/${encodeURIComponent(r.commit)}`) },
            { key: 'submitted_at', label: 'Submitted',
              render: (r: MachineRunInfo) => formatTime(r.submitted_at) },
          ],
          rows: result.items,
          emptyMessage: 'No runs found.',
        });
        runsContainer.append(tableDiv);

        const paginationDiv = el('div', {});
        renderPagination(paginationDiv, {
          hasPrevious: cursorStack.length > 0,
          hasNext: result.cursor.next !== null,
          onPrevious: () => { currentCursor = cursorStack.pop(); loadRuns(); },
          onNext: () => {
            cursorStack.push(currentCursor || '');
            currentCursor = result.cursor.next!;
            loadRuns();
          },
        });
        runsContainer.append(paginationDiv);
      } catch (e: unknown) {
        runsContainer.replaceChildren();
        runsContainer.append(el('h3', {}, 'Run History'));
        runsContainer.append(el('p', { class: 'error-banner' }, `Failed to load runs: ${e}`));
      }
    }

    loadRuns();

    // Delete section
    renderDeleteConfirm(deleteContainer, {
      label: 'Delete Machine',
      prompt: `Type "${name}" to confirm deletion. This will delete all runs and data for this machine.`,
      confirmValue: name,
      placeholder: 'Machine name',
      deletingMessage: 'This may take a while for machines with many runs.',
      onDelete: () => deleteMachine(ts, name),
      onSuccess: () => {
        window.location.assign(agnosticUrl(`/test-suites?suite=${encodeURIComponent(ts)}`));
      },
    });
  },

  unmount(): void {
    if (controller) { controller.abort(); controller = null; }
  },
};
