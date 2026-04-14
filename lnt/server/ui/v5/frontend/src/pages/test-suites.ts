// pages/test-suites.ts — Test Suites page with suite picker and browsing tabs.
// Suite-agnostic — served at /v5/test-suites.

import type { PageModule, RouteParams } from '../router';
import type { MachineInfo, RunInfo, CommitSummary } from '../types';
import type { CursorPageResult } from '../api';
import { getTestsuites } from '../router';
import { getMachines, getRunsPage, getCommitsPage } from '../api';
import type { Column } from '../components/data-table';
import { el, formatTime, truncate, debounce } from '../utils';
import { renderDataTable } from '../components/data-table';
import { renderPagination } from '../components/pagination';

const PAGE_SIZE = 25;

type TabId = 'recent' | 'machines' | 'runs' | 'commits';

let tabController: AbortController | null = null;

/** Build a full href to a suite-scoped detail page (full page navigation). */
function suiteHref(suite: string, path: string): string {
  // lnt_url_base is set as a global by the HTML template
  const base = typeof (globalThis as Record<string, unknown>).lnt_url_base === 'string'
    ? (globalThis as Record<string, unknown>).lnt_url_base as string
    : '';
  return `${base}/v5/${encodeURIComponent(suite)}${path}`;
}

/** Create a plain <a> link for full page navigation (not SPA). */
function detailLink(text: string, suite: string, path: string): HTMLAnchorElement {
  return el('a', { href: suiteHref(suite, path) }, text) as HTMLAnchorElement;
}

export const testSuitesPage: PageModule = {
  mount(container: HTMLElement, _params: RouteParams): void {
    // Abort any previous tab load
    if (tabController) tabController.abort();

    const suites = getTestsuites();

    // Read initial state from URL query params
    const urlParams = new URLSearchParams(window.location.search);
    let selectedSuite = urlParams.get('suite') || '';
    let activeTab: TabId = (urlParams.get('tab') as TabId) || 'recent';
    let currentSearch = urlParams.get('search') || '';

    container.append(el('h2', { class: 'page-header' }, 'Test Suites'));

    // --- Suite picker ---
    const picker = el('div', { class: 'suite-picker' });
    const cardMap = new Map<string, HTMLElement>();

    for (const name of suites) {
      const card = el('button', { class: 'suite-card' }, name);
      if (name === selectedSuite) card.classList.add('suite-card-active');
      card.addEventListener('click', () => {
        if (selectedSuite === name) return;
        selectSuite(name);
      });
      cardMap.set(name, card);
      picker.append(card);
    }

    if (suites.length === 0) {
      picker.append(el('p', {}, 'No test suites available.'));
    }
    container.append(picker);

    // --- Tab bar (hidden until suite selected) ---
    const tabBar = el('div', { class: 'v5-tab-bar', style: selectedSuite ? '' : 'display:none' });
    const tabDefs: Array<{ id: TabId; label: string }> = [
      { id: 'recent', label: 'Recent Activity' },
      { id: 'machines', label: 'Machines' },
      { id: 'runs', label: 'Runs' },
      { id: 'commits', label: 'Commits' },
    ];
    const tabButtons: HTMLElement[] = [];
    for (const tab of tabDefs) {
      const btn = el('button', {
        class: `v5-tab${tab.id === activeTab ? ' v5-tab-active' : ''}`,
        'data-tab': tab.id,
      }, tab.label);
      btn.addEventListener('click', () => {
        if (activeTab === tab.id) return;
        activeTab = tab.id;
        currentSearch = '';
        activateTab(tab.id);
        syncUrl();
        loadTabContent();
      });
      tabButtons.push(btn);
      tabBar.append(btn);
    }
    container.append(tabBar);

    // --- Tab content area ---
    const tabContent = el('div', { class: 'v5-tab-content' });
    container.append(tabContent);

    function activateTab(tabId: TabId): void {
      for (const btn of tabButtons) {
        btn.classList.toggle('v5-tab-active', btn.getAttribute('data-tab') === tabId);
      }
    }

    function selectSuite(name: string): void {
      for (const [n, card] of cardMap) {
        card.classList.toggle('suite-card-active', n === name);
      }
      selectedSuite = name;
      currentSearch = '';
      activeTab = 'recent';
      activateTab('recent');
      tabBar.style.display = '';
      syncUrl();
      loadTabContent();
    }

    function syncUrl(): void {
      const params = new URLSearchParams();
      if (selectedSuite) params.set('suite', selectedSuite);
      if (activeTab && activeTab !== 'recent') params.set('tab', activeTab);
      if (currentSearch) params.set('search', currentSearch);
      const qs = params.toString();
      window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
    }

    function loadTabContent(): void {
      // Abort any previous tab load to prevent race conditions
      if (tabController) tabController.abort();
      tabController = new AbortController();
      const signal = tabController.signal;

      tabContent.replaceChildren();
      if (!selectedSuite) return;

      switch (activeTab) {
        case 'recent':
          renderRecentActivityTab(tabContent, selectedSuite, signal);
          break;
        case 'machines':
          renderMachinesTab(tabContent, selectedSuite, currentSearch, signal,
            (search: string) => { currentSearch = search; syncUrl(); });
          break;
        case 'runs':
          renderCursorPaginatedTab(tabContent, selectedSuite, currentSearch, signal,
            'Filter by machine name...', 'Loading runs...', 'No runs found.',
            'Failed to load runs',
            (s, opts, sig) => getRunsPage(s, {
              machine: opts.search || undefined,
              sort: '-submitted_at',
              limit: opts.limit,
              cursor: opts.cursor,
            }, sig),
            runsColumns(selectedSuite),
            (search: string) => { currentSearch = search; syncUrl(); });
          break;
        case 'commits':
          renderCursorPaginatedTab(tabContent, selectedSuite, currentSearch, signal,
            'Search commits...', 'Loading commits...', 'No commits found.',
            'Failed to load commits',
            (s, opts, sig) => getCommitsPage(s, {
              search: opts.search || undefined,
              limit: opts.limit,
              cursor: opts.cursor,
            }, sig),
            commitsColumns(selectedSuite),
            (search: string) => { currentSearch = search; syncUrl(); });
          break;
      }
    }

    // Load initial content if suite was pre-selected from URL
    if (selectedSuite) {
      loadTabContent();
    }
  },

  unmount(): void {
    if (tabController) { tabController.abort(); tabController = null; }
  },
};

// ---------------------------------------------------------------------------
// Recent Activity Tab
// ---------------------------------------------------------------------------

function renderRecentActivityTab(
  container: HTMLElement,
  suite: string,
  signal: AbortSignal,
): void {
  container.append(el('p', { class: 'progress-label' }, 'Loading recent activity...'));

  // Accumulate all loaded runs for re-rendering via renderDataTable
  const allRuns: RunInfo[] = [];
  let nextCursor: string | null = null;

  const tableContainer = el('div', {});
  const loadMoreContainer = el('div', {});

  async function loadPage(): Promise<void> {
    try {
      const result = await getRunsPage(suite, {
        sort: '-submitted_at',
        limit: PAGE_SIZE,
        cursor: nextCursor || undefined,
      }, signal);

      allRuns.push(...result.items);

      // First load: replace loading message with table + load-more area
      if (container.querySelector('.progress-label')) {
        container.replaceChildren(tableContainer, loadMoreContainer);
      }

      if (allRuns.length === 0) {
        tableContainer.replaceChildren(el('p', { class: 'no-results' }, 'No recent activity.'));
        return;
      }

      tableContainer.replaceChildren();
      renderDataTable(tableContainer, {
        columns: recentActivityColumns(suite),
        rows: allRuns,
        emptyMessage: 'No recent activity.',
      });

      nextCursor = result.nextCursor;
      loadMoreContainer.replaceChildren();
      if (nextCursor) {
        const loadMoreBtn = el('button', { class: 'pagination-btn load-more-btn' }, 'Load more');
        loadMoreBtn.addEventListener('click', () => {
          loadMoreBtn.textContent = 'Loading...';
          loadMoreBtn.setAttribute('disabled', '');
          loadPage();
        });
        loadMoreContainer.append(loadMoreBtn);
      }
    } catch (e: unknown) {
      if (allRuns.length === 0) container.replaceChildren();
      container.append(el('p', { class: 'error-banner' }, `Failed to load recent activity: ${e}`));
    }
  }

  loadPage();
}

function recentActivityColumns(suite: string): Column<RunInfo>[] {
  return [
    { key: 'machine', label: 'Machine',
      render: (r: RunInfo) =>
        detailLink(r.machine, suite, `/machines/${encodeURIComponent(r.machine)}`) },
    { key: 'commit', label: 'Commit',
      render: (r: RunInfo) =>
        detailLink(r.commit, suite, `/commits/${encodeURIComponent(r.commit)}`) },
    { key: 'submitted_at', label: 'Submitted',
      render: (r: RunInfo) => formatTime(r.submitted_at) },
    { key: 'uuid', label: 'Run',
      render: (r: RunInfo) =>
        detailLink(truncate(r.uuid, 8), suite, `/runs/${encodeURIComponent(r.uuid)}`) },
  ];
}

// ---------------------------------------------------------------------------
// Machines Tab
// ---------------------------------------------------------------------------

function renderMachinesTab(
  container: HTMLElement,
  suite: string,
  initialSearch: string,
  signal: AbortSignal,
  onSearchChange: (search: string) => void,
): void {
  const searchRow = el('div', { class: 'table-controls' });
  const searchInput = el('input', {
    type: 'text',
    class: 'test-filter-input',
    placeholder: 'Filter by name...',
  }) as HTMLInputElement;
  searchInput.value = initialSearch;
  searchRow.append(searchInput);
  container.append(searchRow);

  const tableContainer = el('div', {});
  const paginationContainer = el('div', {});
  container.append(tableContainer, paginationContainer);

  let currentOffset = 0;
  let currentSearch = initialSearch;

  async function loadPage(): Promise<void> {
    tableContainer.replaceChildren();
    paginationContainer.replaceChildren();
    tableContainer.append(el('p', { class: 'progress-label' }, 'Loading machines...'));

    try {
      const result = await getMachines(suite, {
        nameContains: currentSearch || undefined,
        limit: PAGE_SIZE,
        offset: currentOffset,
      }, signal);

      tableContainer.replaceChildren();

      renderDataTable(tableContainer, {
        columns: [
          { key: 'name', label: 'Name',
            render: (m: MachineInfo) =>
              detailLink(m.name, suite, `/machines/${encodeURIComponent(m.name)}`) },
          { key: 'info', label: 'Info', sortable: false,
            render: (m: MachineInfo) => formatMachineInfo(m) },
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

  const onInput = debounce(() => {
    currentSearch = searchInput.value.trim();
    currentOffset = 0;
    onSearchChange(currentSearch);
    loadPage();
  }, 300);

  searchInput.addEventListener('input', onInput as EventListener);
  loadPage();
}

function formatMachineInfo(m: MachineInfo): string {
  const entries = Object.entries(m.info || {});
  if (entries.length === 0) return '';
  return entries.slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(', ');
}

// ---------------------------------------------------------------------------
// Cursor-paginated tab (shared by Runs and Commits)
// ---------------------------------------------------------------------------

interface CursorFetchOpts {
  search: string | undefined;
  limit: number;
  cursor: string | undefined;
}

/**
 * Generic cursor-paginated tab with search input, data table, and Previous/Next.
 * Used by the Runs and Commits tabs.
 */
function renderCursorPaginatedTab<T>(
  container: HTMLElement,
  suite: string,
  initialSearch: string,
  signal: AbortSignal,
  placeholder: string,
  loadingMsg: string,
  emptyMsg: string,
  errorPrefix: string,
  fetchPage: (suite: string, opts: CursorFetchOpts, signal: AbortSignal) => Promise<CursorPageResult<T>>,
  columns: Column<T>[],
  onSearchChange: (search: string) => void,
): void {
  const searchRow = el('div', { class: 'table-controls' });
  const searchInput = el('input', {
    type: 'text',
    class: 'test-filter-input',
    placeholder,
  }) as HTMLInputElement;
  searchInput.value = initialSearch;
  searchRow.append(searchInput);
  container.append(searchRow);

  const tableContainer = el('div', {});
  const paginationContainer = el('div', {});
  container.append(tableContainer, paginationContainer);

  let currentSearch = initialSearch;
  const cursorStack: string[] = [];
  let currentCursor: string | undefined;

  async function loadPage(): Promise<void> {
    tableContainer.replaceChildren();
    paginationContainer.replaceChildren();
    tableContainer.append(el('p', { class: 'progress-label' }, loadingMsg));

    try {
      const result = await fetchPage(suite, {
        search: currentSearch || undefined,
        limit: PAGE_SIZE,
        cursor: currentCursor,
      }, signal);

      tableContainer.replaceChildren();

      renderDataTable(tableContainer, {
        columns,
        rows: result.items,
        emptyMessage: emptyMsg,
      });

      if (cursorStack.length > 0 || result.nextCursor) {
        renderPagination(paginationContainer, {
          hasPrevious: cursorStack.length > 0,
          hasNext: !!result.nextCursor,
          onPrevious: () => {
            currentCursor = cursorStack.pop();
            loadPage();
          },
          onNext: () => {
            if (currentCursor !== undefined) cursorStack.push(currentCursor);
            currentCursor = result.nextCursor!;
            loadPage();
          },
        });
      }
    } catch (e: unknown) {
      tableContainer.replaceChildren();
      tableContainer.append(el('p', { class: 'error-banner' }, `${errorPrefix}: ${e}`));
    }
  }

  const onInput = debounce(() => {
    currentSearch = searchInput.value.trim();
    cursorStack.length = 0;
    currentCursor = undefined;
    onSearchChange(currentSearch);
    loadPage();
  }, 300);

  searchInput.addEventListener('input', onInput as EventListener);
  loadPage();
}

function runsColumns(suite: string): Column<RunInfo>[] {
  return [
    { key: 'uuid', label: 'Run',
      render: (r: RunInfo) =>
        detailLink(truncate(r.uuid, 8), suite, `/runs/${encodeURIComponent(r.uuid)}`) },
    { key: 'machine', label: 'Machine',
      render: (r: RunInfo) =>
        detailLink(r.machine, suite, `/machines/${encodeURIComponent(r.machine)}`) },
    { key: 'commit', label: 'Commit',
      render: (r: RunInfo) =>
        detailLink(truncate(r.commit, 12), suite,
          `/commits/${encodeURIComponent(r.commit)}`) },
    { key: 'submitted_at', label: 'Submitted',
      render: (r: RunInfo) => formatTime(r.submitted_at) },
  ];
}

function commitsColumns(suite: string): Column<CommitSummary>[] {
  return [
    { key: 'commit', label: 'Commit',
      render: (o: CommitSummary) =>
        detailLink(o.commit, suite, `/commits/${encodeURIComponent(o.commit)}`) },
    { key: 'ordinal', label: 'Ordinal',
      render: (o: CommitSummary) => o.ordinal != null ? String(o.ordinal) : '\u2014' },
  ];
}
