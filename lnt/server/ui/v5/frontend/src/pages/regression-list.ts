// pages/regression-list.ts — Regression tab renderer with filters, sortable
// table, cursor pagination, create form, and per-row delete.
// Called by test-suites.ts to render the Regressions tab content.

import type { RegressionListItem, RegressionState } from '../types';
import {
  getRegressions, createRegression, deleteRegression, getFields,
  getToken, authErrorMessage, getTestSuiteInfoCached,
} from '../api';
import type { CursorPageResult } from '../api';
import { el, truncate, debounce, ensureProtocol, resolveDisplayMap } from '../utils';
import { renderDataTable, type Column } from '../components/data-table';
import { renderPagination } from '../components/pagination';
import { renderMachineCombobox } from '../components/machine-combobox';
import { renderMetricSelector, filterMetricFields } from '../components/metric-selector';
import { renderCommitSearch } from '../components/commit-search';
import { ALL_STATES, STATE_META, renderStateBadge } from '../regression-utils';

const PAGE_SIZE = 25;

export interface RegressionTabOptions {
  container: HTMLElement;
  testsuite: string;
  signal: AbortSignal;
  trackCleanup: (fn: () => void) => void;
  /** Build a link to a suite-scoped detail page. */
  detailLink: (text: string, path: string) => HTMLAnchorElement;
  /** Navigate to a regression detail page by UUID. */
  navigateToDetail: (uuid: string) => void;
}

export function renderRegressionTab(opts: RegressionTabOptions): void {
  const { container, signal } = opts;
  const ts = opts.testsuite;
  const hasToken = !!getToken();
  const commitFields: Array<{ name: string; display?: boolean }> = [];

  // Pre-fetch schema for commit display resolution (non-blocking)
  getTestSuiteInfoCached(ts, signal).then(info => {
    commitFields.push(...info.schema.commit_fields);
  }).catch(() => {});

  // --- Filter panel ---
  const filtersDiv = el('div', { class: 'regression-filters' });
  const stateChipsDiv = el('div', { class: 'state-chips' });
  const filterRow1 = el('div', { class: 'filter-row' });
  const filterRow2 = el('div', { class: 'filter-row' });
  filtersDiv.append(stateChipsDiv, filterRow1, filterRow2);

  // --- Actions bar ---
  const actionsDiv = el('div', { class: 'regression-actions' });

  // --- Create form (initially hidden) ---
  const createFormContainer = el('div', { class: 'create-form-container' });
  createFormContainer.style.display = 'none';

  // --- Error area ---
  const errorDiv = el('div', { class: 'regression-list-error' });

  // --- Table and pagination ---
  const tableContainer = el('div', { class: 'regression-table-container' });
  const paginationDiv = el('div', { class: 'regression-pagination' });

  container.append(
    filtersDiv, actionsDiv, createFormContainer,
    errorDiv, tableContainer, paginationDiv,
  );

  // --- Filter state ---
  const activeStates = new Set<RegressionState>();
  let machineFilter = '';
  let metricFilter = '';
  let hasCommitFilter: boolean | undefined;
  let titleSearch = '';
  const cursorStack: string[] = [];
  let currentCursor: string | undefined;

  // --- State chips ---
  function renderStateChips(): void {
    stateChipsDiv.replaceChildren();
    for (const state of ALL_STATES) {
      const meta = STATE_META[state];
      const active = activeStates.has(state);
      const chip = el('button', {
        class: `state-chip${active ? ' state-chip-active' : ''}`,
        'data-state': state,
      }, meta.label);
      chip.addEventListener('click', () => {
        if (activeStates.has(state)) {
          activeStates.delete(state);
        } else {
          activeStates.add(state);
        }
        resetAndLoad();
        renderStateChips();
      });
      stateChipsDiv.append(chip);
    }
  }
  renderStateChips();

  // --- Machine filter ---
  const machineGroup = el('div', { class: 'control-group' });
  machineGroup.append(el('label', {}, 'Machine'));
  const machineInputContainer = el('div', {});
  machineGroup.append(machineInputContainer);
  const machineHandle = renderMachineCombobox(machineInputContainer, {
    testsuite: ts,
    onSelect: (name) => {
      machineFilter = name;
      resetAndLoad();
    },
    onClear: () => {
      machineFilter = '';
      resetAndLoad();
    },
  });
  opts.trackCleanup(machineHandle.destroy);
  filterRow1.append(machineGroup);

  // --- Metric filter ---
  const metricGroup = el('div', {});
  filterRow1.append(metricGroup);

  getFields(ts, signal).then(fields => {
    renderMetricSelector(metricGroup, filterMetricFields(fields), (m) => {
      metricFilter = m;
      resetAndLoad();
    }, undefined, { placeholder: true });
  }).catch(() => {
    metricGroup.append(el('span', { class: 'progress-label' }, 'Failed to load metrics'));
  });

  // --- Has commit checkbox ---
  const hasCommitLabel = el('label', { class: 'control-group control-group-checkbox' });
  const hasCommitCb = el('input', { type: 'checkbox' }) as HTMLInputElement;
  hasCommitLabel.append(hasCommitCb, ' Has commit');
  hasCommitCb.addEventListener('change', () => {
    hasCommitFilter = hasCommitCb.checked ? true : undefined;
    resetAndLoad();
  });
  filterRow1.append(hasCommitLabel);

  // --- Title search (client-side) ---
  const titleInput = el('input', {
    type: 'text',
    class: 'title-search-input admin-input',
    placeholder: 'Search title...',
  }) as HTMLInputElement;
  const doTitleFilter = debounce(() => {
    titleSearch = titleInput.value.toLowerCase();
    renderTable(lastResult, lastDisplayMap);
  }, 300);
  titleInput.addEventListener('input', () => doTitleFilter());
  filterRow2.append(titleInput);

  // --- "New Regression" button (auth-gated) ---
  if (hasToken) {
    const newBtn = el('button', { class: 'compare-btn' }, 'New Regression');
    newBtn.addEventListener('click', () => {
      createFormContainer.style.display =
        createFormContainer.style.display === 'none' ? '' : 'none';
    });
    actionsDiv.append(newBtn);

    // --- Create form ---
    renderCreateForm(createFormContainer, ts, signal, (fn) => opts.trackCleanup(fn), opts.navigateToDetail, commitFields);
  }

  // --- Load page ---
  let lastResult: CursorPageResult<RegressionListItem> = { items: [], nextCursor: null };
  let lastDisplayMap = new Map<string, string>();

  function resetAndLoad(): void {
    cursorStack.length = 0;
    currentCursor = undefined;
    loadPage();
  }

  async function loadPage(): Promise<void> {
    tableContainer.replaceChildren(
      el('p', { class: 'progress-label' }, 'Loading regressions...'),
    );
    paginationDiv.replaceChildren();
    errorDiv.replaceChildren();

    try {
      const result = await getRegressions(ts, {
        state: activeStates.size > 0 ? [...activeStates] : undefined,
        machine: machineFilter || undefined,
        metric: metricFilter || undefined,
        has_commit: hasCommitFilter,
        limit: PAGE_SIZE,
        cursor: currentCursor,
      }, signal);

      lastResult = result;

      // Resolve commit display values before rendering
      const commitStrings = result.items
        .map(r => r.commit).filter((c): c is string => c !== null);
      const displayMap = await resolveDisplayMap(ts, commitStrings, signal);
      lastDisplayMap = displayMap;

      renderTable(result, displayMap);

      renderPagination(paginationDiv, {
        hasPrevious: cursorStack.length > 0,
        hasNext: result.nextCursor !== null,
        onPrevious: () => { currentCursor = cursorStack.pop(); loadPage(); },
        onNext: () => {
          cursorStack.push(currentCursor || '');
          currentCursor = result.nextCursor!;
          loadPage();
        },
      });
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      tableContainer.replaceChildren();
      errorDiv.replaceChildren(
        el('p', { class: 'error-banner' }, `Failed to load regressions: ${e}`),
      );
    }
  }

  function renderTable(result: CursorPageResult<RegressionListItem>, displayMap: Map<string, string>): void {
    let rows = result.items;
    if (titleSearch) {
      rows = rows.filter(r =>
        (r.title || '').toLowerCase().includes(titleSearch));
    }

    tableContainer.replaceChildren();

    const columns: Column<RegressionListItem>[] = [
      {
        key: 'title',
        label: 'Title',
        render: (r) => opts.detailLink(
          truncate(r.title || '(untitled)', 60),
          `/regressions/${encodeURIComponent(r.uuid)}`,
        ),
        sortValue: (r) => r.title || '',
      },
      {
        key: 'state',
        label: 'State',
        render: (r) => renderStateBadge(r.state),
        sortValue: (r) => ALL_STATES.indexOf(r.state),
      },
      {
        key: 'commit',
        label: 'Commit',
        render: (r) => r.commit
          ? opts.detailLink(truncate(displayMap.get(r.commit) ?? r.commit, 12), `/commits/${encodeURIComponent(r.commit)}`)
          : '\u2014',
        sortValue: (r) => r.commit || '',
      },
      {
        key: 'machine_count',
        label: 'Machines',
        cellClass: 'col-num',
        sortValue: (r) => r.machine_count,
      },
      {
        key: 'test_count',
        label: 'Tests',
        cellClass: 'col-num',
        sortValue: (r) => r.test_count,
      },
      {
        key: 'bug',
        label: 'Bug',
        render: (r) => r.bug
          ? el('a', { href: ensureProtocol(r.bug), target: '_blank', rel: 'noopener' }, 'Link')
          : '\u2014',
        sortable: false,
      },
    ];

    // Add delete column if auth'd
    if (hasToken) {
      columns.push({
        key: 'actions',
        label: '',
        sortable: false,
        render: (r) => {
          const btn = el('button', {
            class: 'row-delete-btn',
            title: 'Delete regression',
          }, '\u00d7');
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            confirmAndDelete(r);
          });
          return btn;
        },
      });
    }

    renderDataTable(tableContainer, {
      columns,
      rows,
      onRowClick: (r) => opts.navigateToDetail(r.uuid),
      emptyMessage: 'No regressions found.',
    });
  }

  async function confirmAndDelete(r: RegressionListItem): Promise<void> {
    const label = r.title || r.uuid.slice(0, 8);
    if (!window.confirm(`Delete regression "${label}"? This cannot be undone.`)) return;
    try {
      await deleteRegression(ts, r.uuid, signal);
      loadPage();
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      errorDiv.replaceChildren(
        el('p', { class: 'error-banner' }, authErrorMessage(err)),
      );
    }
  }

  // Start loading
  loadPage();
}

// ---------------------------------------------------------------------------
// Create Regression Form
// ---------------------------------------------------------------------------

function renderCreateForm(
  container: HTMLElement,
  ts: string,
  signal: AbortSignal,
  trackCleanup: (fn: () => void) => void,
  navigateToDetail: (uuid: string) => void,
  commitFields: Array<{ name: string; display?: boolean }>,
): void {
  const titleInput = el('input', {
    type: 'text',
    class: 'admin-input',
    placeholder: 'Regression title',
  }) as HTMLInputElement;

  const stateSelect = el('select', { class: 'metric-select' }) as HTMLSelectElement;
  for (const state of ALL_STATES) {
    const opt = el('option', { value: state }, STATE_META[state].label);
    if (state === 'detected') (opt as HTMLOptionElement).selected = true;
    stateSelect.append(opt);
  }

  const bugInput = el('input', {
    type: 'text',
    class: 'admin-input',
    placeholder: 'Bug URL (optional)',
  }) as HTMLInputElement;

  let selectedCommit = '';
  const commitGroup = el('div', { class: 'control-group' });
  commitGroup.append(el('label', {}, 'Commit'));
  const commitContainer = el('div', {});
  commitGroup.append(commitContainer);
  const commitHandle = renderCommitSearch(commitContainer, {
    testsuite: ts,
    placeholder: 'Search commit...',
    commitFields,
    onSelect: (value) => { selectedCommit = value; },
  });
  trackCleanup(commitHandle.destroy);

  const createBtn = el('button', { class: 'compare-btn' }, 'Create') as HTMLButtonElement;
  const cancelBtn = el('button', { class: 'pagination-btn' }, 'Cancel');
  const errorArea = el('div', { class: 'create-form-error' });

  cancelBtn.addEventListener('click', () => {
    container.style.display = 'none';
    titleInput.value = '';
    bugInput.value = '';
    selectedCommit = '';
    commitHandle.clear();
    errorArea.replaceChildren();
  });

  createBtn.addEventListener('click', async () => {
    createBtn.disabled = true;
    errorArea.replaceChildren();

    const body: Record<string, unknown> = {};
    const title = titleInput.value.trim();
    if (title) body.title = title;
    body.state = stateSelect.value;
    const bug = bugInput.value.trim();
    if (bug) body.bug = bug;
    if (selectedCommit) body.commit = selectedCommit;

    try {
      const created = await createRegression(ts, body, signal);
      navigateToDetail(created.uuid);
    } catch (err: unknown) {
      createBtn.disabled = false;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      errorArea.replaceChildren(
        el('p', { class: 'error-banner' }, authErrorMessage(err)),
      );
    }
  });

  container.append(
    el('div', { class: 'admin-form-row' },
      el('label', {}, 'Title:'), titleInput),
    el('div', { class: 'admin-form-row' },
      el('label', {}, 'State:'), stateSelect),
    el('div', { class: 'admin-form-row' },
      el('label', {}, 'Bug:'), bugInput),
    commitGroup,
    el('div', { class: 'admin-form-row' }, createBtn, cancelBtn),
    errorArea,
  );
}
