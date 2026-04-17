// pages/commit-detail.ts — Commit detail with ordinal editing, prev/next, machine filter, runs table.

import type { PageModule, RouteParams } from '../router';
import type { RunInfo, CommitDetail, RegressionListItem } from '../types';
import { getCommit, getRunsByCommit, updateCommit, authErrorMessage, getRegressions } from '../api';
import { el, spaLink, formatTime, truncate, debounce } from '../utils';
import { navigate } from '../router';
import { renderDataTable } from '../components/data-table';
import { renderStateBadge } from '../regression-utils';

let controller: AbortController | null = null;

export const commitDetailPage: PageModule = {
  mount(container: HTMLElement, params: RouteParams): void {
    if (controller) controller.abort();
    controller = new AbortController();
    const { signal } = controller;

    const ts = params.testsuite;
    const commitValue = params.value;

    container.append(el('h2', { class: 'page-header' }, `Commit: ${commitValue}`));

    const fieldsContainer = el('div', { class: 'commit-fields' });
    const ordinalContainer = el('div', { class: 'ordinal-display' });
    const navContainer = el('div', { class: 'commit-nav' });
    const summaryContainer = el('div', {});
    const filterContainer = el('div', { class: 'table-controls' });
    const tableContainer = el('div', {});
    const regressionsContainer = el('div', { class: 'commit-regressions-section' });
    container.append(
      fieldsContainer, ordinalContainer, navContainer,
      regressionsContainer,
      summaryContainer, filterContainer, tableContainer,
    );

    const loading = el('p', { class: 'progress-label' }, 'Loading commit data...');
    container.append(loading);

    let runs: RunInfo[] = [];
    let machineFilter = '';

    Promise.all([
      getCommit(ts, commitValue, signal),
      getRunsByCommit(ts, commitValue, signal),
    ]).then(([commit, commitRuns]) => {
      loading.remove();
      runs = commitRuns;

      // Commit fields
      const dl = el('dl', { class: 'metadata-dl' });
      for (const [k, v] of Object.entries(commit.fields)) {
        dl.append(el('dt', {}, k), el('dd', {}, v || ''));
      }
      fieldsContainer.append(dl);

      // Tag display + edit
      renderOrdinal(ordinalContainer, ts, commitValue, commit);

      // Prev/Next navigation
      if (commit.previous_commit) {
        const prevBtn = el('button', { class: 'pagination-btn' }, '\u2190 Previous');
        prevBtn.addEventListener('click', () => navigate(`/commits/${encodeURIComponent(commit.previous_commit!.commit)}`));
        navContainer.append(prevBtn);
      }
      if (commit.next_commit) {
        const nextBtn = el('button', { class: 'pagination-btn' }, 'Next \u2192');
        nextBtn.addEventListener('click', () => navigate(`/commits/${encodeURIComponent(commit.next_commit!.commit)}`));
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

      // Load matching regressions (non-blocking)
      loadCommitRegressions(ts, commitValue, regressionsContainer, signal);
    }).catch(e => {
      loading.remove();
      container.append(el('p', { class: 'error-banner' }, `Failed to load commit: ${e}`));
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
          { key: 'submitted_at', label: 'Submitted',
            render: (r: RunInfo) => formatTime(r.submitted_at) },
        ],
        rows: visible,
        emptyMessage: machineFilter ? 'No runs matching filter.' : 'No runs at this commit.',
      });
    }
  },

  unmount(): void {
    if (controller) { controller.abort(); controller = null; }
  },
};

function renderOrdinal(
  container: HTMLElement,
  ts: string,
  commitValue: string,
  commit: CommitDetail,
): void {
  container.replaceChildren();

  const label = el('strong', {}, 'Ordinal: ');
  const value = el('span', {}, commit.ordinal != null ? String(commit.ordinal) : '(none)');
  const editBtn = el('button', { class: 'pagination-btn' }, 'Edit');
  container.append(label, value, editBtn);

  editBtn.addEventListener('click', () => {
    container.replaceChildren();
    container.append(el('strong', {}, 'Ordinal: '));

    const input = el('input', {
      type: 'text',
      class: 'ordinal-edit-input combobox-input',
      placeholder: 'Enter ordinal (integer)...',
    }) as HTMLInputElement;
    input.value = commit.ordinal != null ? String(commit.ordinal) : '';
    input.style.width = '200px';

    const saveBtn = el('button', { class: 'compare-btn' }, 'Save') as HTMLButtonElement;
    const cancelBtn = el('button', { class: 'pagination-btn' }, 'Cancel');
    const errorEl = el('span', { class: 'error-banner', style: 'display:inline;margin-left:8px;padding:4px 8px' });

    container.append(input, saveBtn, cancelBtn, errorEl);
    input.focus();

    cancelBtn.addEventListener('click', () => renderOrdinal(container, ts, commitValue, commit));

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      errorEl.textContent = '';
      const raw = input.value.trim();
      const newOrdinal = raw === '' ? null : parseInt(raw, 10);
      if (raw !== '' && (isNaN(newOrdinal!) || !Number.isInteger(newOrdinal))) {
        errorEl.textContent = 'Ordinal must be an integer';
        saveBtn.disabled = false;
        return;
      }
      try {
        const updated = await updateCommit(ts, commitValue, { ordinal: newOrdinal });
        commit.ordinal = updated.ordinal;
        renderOrdinal(container, ts, commitValue, commit);
      } catch (e: unknown) {
        errorEl.textContent = authErrorMessage(e);
        saveBtn.disabled = false;
      }
    });
  });
}

async function loadCommitRegressions(
  ts: string,
  commit: string,
  container: HTMLElement,
  signal: AbortSignal,
): Promise<void> {
  container.append(el('h3', {}, 'Regressions'));

  try {
    const result = await getRegressions(ts, { commit, limit: 25 }, signal);
    const regressions = result.items;

    if (regressions.length === 0) {
      container.append(el('p', { class: 'no-results' },
        'No regressions at this commit.'));
      return;
    }

    renderDataTable(container, {
      columns: [
        {
          key: 'title',
          label: 'Regression',
          render: (r: RegressionListItem) => spaLink(
            truncate(r.title || '(untitled)', 50),
            `/regressions/${encodeURIComponent(r.uuid)}`),
        },
        {
          key: 'state',
          label: 'State',
          render: (r: RegressionListItem) => renderStateBadge(r.state),
        },
        {
          key: 'machine_count',
          label: 'Machines',
          cellClass: 'col-num',
        },
        {
          key: 'test_count',
          label: 'Tests',
          cellClass: 'col-num',
        },
      ],
      rows: regressions,
      emptyMessage: 'No matching regressions.',
    });
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === 'AbortError') return;
    container.append(el('p', { class: 'error-banner' },
      `Failed to load regressions: ${e}`));
  }
}
