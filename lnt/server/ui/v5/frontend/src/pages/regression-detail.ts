// pages/regression-detail.ts — Regression detail page with editable fields,
// indicators table, add indicators panel, and delete section.

import type { PageModule, RouteParams } from '../router';
import type { RegressionDetail as RegressionDetailType, RegressionIndicator, RegressionState, FieldInfo } from '../types';
import {
  getRegression, updateRegression, deleteRegression,
  addRegressionIndicators, removeRegressionIndicators,
  getFields, getMachines, getTests, getToken, authErrorMessage,
  getTestSuiteInfoCached,
  getCommit,
} from '../api';
import { el, spaLink, agnosticLink, agnosticUrl, truncate, ensureProtocol, commitDisplayValue } from '../utils';
import { renderDataTable, type Column } from '../components/data-table';
import { renderDeleteConfirm } from '../components/delete-confirm';
import { renderMetricSelector, filterMetricFields } from '../components/metric-selector';
import { renderCommitSearch } from '../components/commit-search';
import { setupCheckboxRange } from '../components/checkbox-range';
import { ALL_STATES, STATE_META, renderStateBadge } from '../regression-utils';

let controller: AbortController | null = null;
/** Track component cleanup handles to prevent resource leaks on unmount. */
let cleanupFns: (() => void)[] = [];
/** Track the current commit-search cleanup handle separately. */
let commitSearchCleanup: (() => void) | null = null;
/** Track checkbox range selection cleanup. */
let checkboxRangeCleanup: (() => void) | null = null;
/** AbortController for in-flight test fetches in Add Indicators. */
let refreshAbort: AbortController | null = null;

export const regressionDetailPage: PageModule = {
  mount(container: HTMLElement, params: RouteParams): void {
    if (controller) controller.abort();
    controller = new AbortController();
    const { signal } = controller;

    const ts = params.testsuite;
    const uuid = params.uuid;
    const hasToken = !!getToken();

    container.append(el('h2', { class: 'page-header' }, `Regression: ${uuid.slice(0, 8)}\u2026`));

    const loading = el('p', { class: 'progress-label' }, 'Loading regression...');
    container.append(loading);

    let regression: RegressionDetailType;
    let fields: FieldInfo[] = [];
    const commitFields: Array<{ name: string; display?: boolean }> = [];
    const commitDisplayMap = new Map<string, string>();

    // --- Main layout containers (created lazily after data loads) ---
    const headerDiv = el('div', { class: 'regression-header' });
    const headerErrorDiv = el('div', { class: 'regression-header-error' });
    const indicatorsHeading = el('h3', {}, 'Indicators');
    const indicatorActionsDiv = el('div', { class: 'indicator-actions' });
    const indicatorTableDiv = el('div', { class: 'indicator-table-container' });
    const addHeading = el('h3', {}, 'Add Indicators');
    const addPanelDiv = el('div', { class: 'add-indicators-panel' });
    const addErrorDiv = el('div', { class: 'add-indicators-error' });
    const deleteDiv = el('div', { class: 'delete-section' });

    function showError(msg: string): void {
      headerErrorDiv.replaceChildren(el('p', { class: 'error-banner' }, msg));
    }

    function updatePageTitle(): void {
      const headerEl = container.querySelector('.page-header');
      if (headerEl) {
        headerEl.textContent = regression.title
          ? `Regression: ${regression.title}`
          : `Regression: ${uuid.slice(0, 8)}\u2026`;
      }
    }

    const fetchPromises: [Promise<RegressionDetailType>, Promise<FieldInfo[] | null>] = [
      getRegression(ts, uuid, signal),
      hasToken ? getFields(ts, signal) : Promise.resolve(null),
    ];
    // Fetch schema in parallel for commit display resolution
    const schemaPromise = getTestSuiteInfoCached(ts, signal).then(info => {
      commitFields.push(...info.schema.commit_fields);
    }).catch(() => {});
    Promise.all([...fetchPromises, schemaPromise]).then(async ([reg, f]) => {
      loading.remove();
      regression = reg;
      fields = f ?? [];

      // Resolve commit display value if the regression has a commit
      if (regression.commit && commitFields.length > 0) {
        try {
          const detail = await getCommit(ts, regression.commit, signal);
          const display = commitDisplayValue(regression.commit, detail.fields, commitFields);
          commitDisplayMap.set(regression.commit, display);
        } catch { /* graceful degradation */ }
      }

      updatePageTitle();

      container.append(headerDiv, headerErrorDiv);

      if (hasToken) {
        container.append(deleteDiv, addHeading, addPanelDiv, addErrorDiv);
      }

      container.append(
        indicatorsHeading, indicatorActionsDiv, indicatorTableDiv,
      );

      renderHeader();
      renderIndicators();
      if (hasToken) {
        renderAddPanel();
        renderDeleteSection();
      }
    }).catch(e => {
      loading.remove();
      if (e instanceof DOMException && e.name === 'AbortError') return;
      container.append(el('p', { class: 'error-banner' },
        `Failed to load regression: ${e}`));
    });

    // ---------------------------------------------------------------
    // Header fields
    // ---------------------------------------------------------------

    function renderHeader(): void {
      headerDiv.replaceChildren();

      const titleRow = el('div', { class: 'field-row' });
      titleRow.append(el('label', {}, 'Title'));
      const titleDisplay = el('span', { class: 'editable-value' },
        regression.title || '(untitled)');
      titleRow.append(titleDisplay);
      if (hasToken) {
        const editBtn = el('button', { class: 'edit-btn' }, 'Edit');
        editBtn.addEventListener('click', () => renderTitleEdit(titleRow));
        titleRow.append(editBtn);
      }
      headerDiv.append(titleRow);

      const stateRow = el('div', { class: 'field-row' });
      stateRow.append(el('label', {}, 'State'));
      if (hasToken) {
        const stateSelect = el('select', { class: 'metric-select' }) as HTMLSelectElement;
        for (const s of ALL_STATES) {
          const opt = el('option', { value: s }, STATE_META[s].label);
          if (s === regression.state) (opt as HTMLOptionElement).selected = true;
          stateSelect.append(opt);
        }
        stateSelect.addEventListener('change', async () => {
          const prev = regression.state;
          try {
            const updated = await updateRegression(ts, uuid,
              { state: stateSelect.value as RegressionState }, signal);
            regression = updated;
          } catch (err: unknown) {
            stateSelect.value = prev;
            if (err instanceof DOMException && err.name === 'AbortError') return;
            showError(authErrorMessage(err));
          }
        });
        stateRow.append(stateSelect);
      } else {
        stateRow.append(renderStateBadge(regression.state));
      }
      headerDiv.append(stateRow);

      const bugRow = el('div', { class: 'field-row' });
      bugRow.append(el('label', {}, 'Bug'));
      renderBugDisplay(bugRow);
      headerDiv.append(bugRow);

      const commitRow = el('div', { class: 'field-row' });
      commitRow.append(el('label', {}, 'Commit'));
      renderCommitDisplay(commitRow);
      headerDiv.append(commitRow);

      const notesRow = el('div', { class: 'field-row regression-notes' });
      notesRow.append(el('label', {}, 'Notes'));
      renderNotesDisplay(notesRow);
      headerDiv.append(notesRow);
    }

    function renderTitleEdit(row: HTMLElement): void {
      const label = row.querySelector('label')!;
      row.replaceChildren();
      row.append(label);

      const input = el('input', {
        type: 'text',
        class: 'admin-input',
      }) as HTMLInputElement;
      input.value = regression.title || '';
      input.style.flex = '1';

      const saveBtn = el('button', { class: 'compare-btn' }, 'Save') as HTMLButtonElement;
      const cancelBtn = el('button', { class: 'pagination-btn' }, 'Cancel');

      cancelBtn.addEventListener('click', () => renderHeader());

      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
          const updated = await updateRegression(ts, uuid,
            { title: input.value.trim() }, signal);
          regression = updated;
          renderHeader();
          updatePageTitle();
        } catch (err: unknown) {
          saveBtn.disabled = false;
          if (err instanceof DOMException && err.name === 'AbortError') return;
          showError(authErrorMessage(err));
        }
      });

      row.append(input, saveBtn, cancelBtn);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveBtn.click(); });
      input.focus();
    }

    function renderBugDisplay(row: HTMLElement): void {
      // Keep the label
      const label = row.querySelector('label');
      row.replaceChildren();
      if (label) row.append(label);
      else row.append(el('label', {}, 'Bug'));

      if (regression.bug) {
        const bugUrl = ensureProtocol(regression.bug);
        row.append(
          el('a', { href: bugUrl, target: '_blank', rel: 'noopener' },
            truncate(regression.bug, 50)),
        );
      } else {
        row.append(el('span', {}, '(none)'));
      }

      if (hasToken) {
        const editBtn = el('button', { class: 'edit-btn' }, 'Edit');
        editBtn.addEventListener('click', () => renderBugEdit(row));
        row.append(editBtn);
      }
    }

    function renderBugEdit(row: HTMLElement): void {
      const label = row.querySelector('label')!;
      row.replaceChildren();
      row.append(label);

      const input = el('input', {
        type: 'url',
        class: 'admin-input',
        placeholder: 'Bug URL',
      }) as HTMLInputElement;
      input.value = regression.bug || '';

      const saveBtn = el('button', { class: 'compare-btn' }, 'Save') as HTMLButtonElement;
      const cancelBtn = el('button', { class: 'pagination-btn' }, 'Cancel');

      cancelBtn.addEventListener('click', () => renderBugDisplay(row));

      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
          const updated = await updateRegression(ts, uuid,
            { bug: input.value.trim() || null }, signal);
          regression = updated;
          renderBugDisplay(row);
        } catch (err: unknown) {
          saveBtn.disabled = false;
          if (err instanceof DOMException && err.name === 'AbortError') return;
          showError(authErrorMessage(err));
        }
      });

      row.append(input, saveBtn, cancelBtn);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveBtn.click(); });
      input.focus();
    }

    function renderNotesDisplay(row: HTMLElement): void {
      const label = row.querySelector('label');
      row.replaceChildren();
      if (label) row.append(label);
      else row.append(el('label', {}, 'Notes'));

      const span = el('span', { class: 'notes-display' },
        regression.notes || '(none)');
      row.append(span);

      if (hasToken) {
        const editBtn = el('button', { class: 'edit-btn' }, 'Edit');
        editBtn.addEventListener('click', () => renderNotesEdit(row));
        row.append(editBtn);
      }
    }

    function renderNotesEdit(row: HTMLElement): void {
      const label = row.querySelector('label')!;
      row.replaceChildren();
      row.append(label);

      const textarea = el('textarea', {
        class: 'regression-notes-input',
      }) as HTMLTextAreaElement;
      textarea.rows = 3;
      textarea.value = regression.notes || '';

      const saveBtn = el('button', { class: 'compare-btn' }, 'Save') as HTMLButtonElement;
      const cancelBtn = el('button', { class: 'pagination-btn' }, 'Cancel');

      cancelBtn.addEventListener('click', () => renderNotesDisplay(row));

      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
          const updated = await updateRegression(ts, uuid,
            { notes: textarea.value || null }, signal);
          regression = updated;
          renderNotesDisplay(row);
        } catch (err: unknown) {
          saveBtn.disabled = false;
          if (err instanceof DOMException && err.name === 'AbortError') return;
          showError(authErrorMessage(err));
        }
      });

      row.append(textarea, saveBtn, cancelBtn);
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveBtn.click();
      });
      textarea.focus();
    }

    function renderCommitDisplay(row: HTMLElement): void {
      const label = row.querySelector('label');
      row.replaceChildren();
      if (label) row.append(label);
      else row.append(el('label', {}, 'Commit'));

      if (regression.commit) {
        const display = commitDisplayMap.get(regression.commit) ?? regression.commit;
        row.append(spaLink(display, `/commits/${encodeURIComponent(regression.commit)}`));
        if (hasToken) {
          const changeBtn = el('button', { class: 'edit-btn' }, 'Change');
          changeBtn.addEventListener('click', () => renderCommitEdit(row));
          const clearBtn = el('button', { class: 'edit-btn' }, 'Clear');
          clearBtn.addEventListener('click', async () => {
            try {
              const updated = await updateRegression(ts, uuid, { commit: null }, signal);
              regression = updated;
              renderCommitDisplay(row);
            } catch (err: unknown) {
              if (err instanceof DOMException && err.name === 'AbortError') return;
              showError(authErrorMessage(err));
            }
          });
          row.append(changeBtn, clearBtn);
        }
      } else {
        row.append(el('span', {}, '(none)'));
        if (hasToken) {
          const setBtn = el('button', { class: 'edit-btn' }, 'Set');
          setBtn.addEventListener('click', () => renderCommitEdit(row));
          row.append(setBtn);
        }
      }
    }

    function renderCommitEdit(row: HTMLElement): void {
      // Destroy previous commit-search instance if any
      if (commitSearchCleanup) { commitSearchCleanup(); commitSearchCleanup = null; }

      const label = row.querySelector('label')!;
      row.replaceChildren();
      row.append(label);

      const commitDiv = el('div', {});
      const handle = renderCommitSearch(commitDiv, {
        testsuite: ts,
        placeholder: 'Search commit...',
        commitFields,
        onSelect: async (value) => {
          try {
            const updated = await updateRegression(ts, uuid, { commit: value }, signal);
            regression = updated;
            renderCommitDisplay(row);
          } catch (err: unknown) {
            if (err instanceof DOMException && err.name === 'AbortError') return;
            showError(authErrorMessage(err));
          }
        },
      });
      commitSearchCleanup = handle.destroy;

      const cancelBtn = el('button', { class: 'pagination-btn' }, 'Cancel');
      cancelBtn.addEventListener('click', () => {
        if (commitSearchCleanup) { commitSearchCleanup(); commitSearchCleanup = null; }
        renderCommitDisplay(row);
      });

      row.append(commitDiv, cancelBtn);
    }

    // ---------------------------------------------------------------
    // Indicators table
    // ---------------------------------------------------------------

    function renderIndicators(): void {
      indicatorActionsDiv.replaceChildren();
      indicatorTableDiv.replaceChildren();

      if (regression.indicators.length === 0) {
        indicatorTableDiv.append(el('p', { class: 'no-results' }, 'No indicators.'));
        return;
      }

      // Batch remove button
      let batchRemoveBtn: HTMLButtonElement | null = null;
      if (hasToken) {
        batchRemoveBtn = el('button', {
          class: 'compare-btn',
          disabled: '',
        }, 'Remove selected') as HTMLButtonElement;

        batchRemoveBtn.addEventListener('click', () => {
          const uuids = Array.from(
            indicatorTableDiv.querySelectorAll<HTMLInputElement>(
              'input[type="checkbox"][data-uuid]:checked'))
            .map(cb => cb.getAttribute('data-uuid')!);
          if (uuids.length === 0) return;
          doRemoveIndicators(uuids);
        });
        indicatorActionsDiv.append(batchRemoveBtn);
      }

      function updateBatchSelection(): void {
        if (!batchRemoveBtn) return;
        const all = indicatorTableDiv.querySelectorAll<HTMLInputElement>(
          'input[type="checkbox"][data-uuid]');
        const checked = indicatorTableDiv.querySelectorAll<HTMLInputElement>(
          'input[type="checkbox"][data-uuid]:checked');
        batchRemoveBtn.disabled = checked.length === 0;
        if (selectAllCb) {
          selectAllCb.checked = checked.length === all.length && all.length > 0;
          selectAllCb.indeterminate = checked.length > 0 && checked.length < all.length;
        }
      }

      let selectAllCb: HTMLInputElement | null = null;
      const columns: Column<RegressionIndicator>[] = [];

      if (hasToken) {
        columns.push({
          key: 'select',
          label: '',
          sortable: false,
          headerRender: () => {
            selectAllCb = el('input', { type: 'checkbox' }) as HTMLInputElement;
            selectAllCb.addEventListener('change', () => {
              const boxes = indicatorTableDiv.querySelectorAll<HTMLInputElement>(
                'input[type="checkbox"][data-uuid]');
              boxes.forEach(box => { box.checked = selectAllCb!.checked; });
              updateBatchSelection();
            });
            return selectAllCb;
          },
          render: (ind) => {
            const cb = el('input', { type: 'checkbox', 'data-uuid': ind.uuid }) as HTMLInputElement;
            cb.addEventListener('change', () => updateBatchSelection());
            return cb;
          },
        });
      }

      columns.push(
        {
          key: 'machine',
          label: 'Machine',
          render: (ind) => ind.machine
            ? spaLink(ind.machine, `/machines/${encodeURIComponent(ind.machine)}`)
            : el('span', { class: 'no-results' }, '(deleted)'),
        },
        {
          key: 'test',
          label: 'Test',
          render: (ind) => ind.test ?? '(deleted)',
        },
        {
          key: 'metric',
          label: 'Metric',
        },
        {
          key: 'graph',
          label: '',
          sortable: false,
          render: (ind) => {
            if (!ind.machine || !ind.test) return el('span', {});
            const qs = new URLSearchParams({
              suite: ts,
              machine: ind.machine,
              metric: ind.metric,
              test_filter: ind.test,
            });
            if (regression.commit) {
              qs.set('commit', regression.commit);
            }
            return agnosticLink('View on graph', `/graph?${qs.toString()}`);
          },
        },
      );

      if (hasToken) {
        columns.push({
          key: 'remove',
          label: '',
          sortable: false,
          render: (ind) => {
            const btn = el('button', { class: 'row-delete-btn', title: 'Remove indicator' }, '\u00d7');
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              doRemoveIndicators([ind.uuid]);
            });
            return btn;
          },
        });
      }

      renderDataTable(indicatorTableDiv, {
        columns,
        rows: regression.indicators,
        emptyMessage: 'No indicators.',
      });

      if (hasToken) {
        if (checkboxRangeCleanup) { checkboxRangeCleanup(); checkboxRangeCleanup = null; }
        const handle = setupCheckboxRange(
          indicatorTableDiv,
          'input[type="checkbox"][data-uuid]',
          () => updateBatchSelection(),
        );
        checkboxRangeCleanup = handle.destroy;
      }
    }

    async function doRemoveIndicators(uuids: string[]): Promise<void> {
      try {
        const updated = await removeRegressionIndicators(ts, uuid, uuids, signal);
        regression = updated;
        renderIndicators();
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        showError(authErrorMessage(err));
      }
    }

    // ---------------------------------------------------------------
    // Add indicators panel
    // ---------------------------------------------------------------

    function renderAddPanel(): void {
      addPanelDiv.replaceChildren();

      const selectorsDiv = el('div', { class: 'add-indicator-selectors' });

      // Metric selector
      let selectedMetric = '';
      const metricContainer = el('div', {});
      renderMetricSelector(metricContainer, filterMetricFields(fields), (m) => {
        selectedMetric = m;
        refreshTests();
        updatePreview();
      }, undefined, { placeholder: true });
      selectorsDiv.append(metricContainer);

      // --- Shared checkbox filter list helper ---
      function renderCheckboxFilterList(opts: {
        container: HTMLElement;
        filterInput: HTMLInputElement;
        allItems: () => string[];
        selected: Set<string>;
        dataAttr: string;
        emptyHint: string;
        onChange: () => void;
      }): { rerender: () => void; destroy: () => void } {
        let rangeHandle: { destroy: () => void } | null = null;
        const selector = `input[type="checkbox"][${opts.dataAttr}]`;

        function render(): void {
          if (rangeHandle) { rangeHandle.destroy(); rangeHandle = null; }
          const filter = opts.filterInput.value.toLowerCase();
          const items = opts.allItems();
          const filtered = filter
            ? items.filter(m => m.toLowerCase().includes(filter))
            : items;

          opts.container.replaceChildren();
          if (filtered.length === 0) {
            opts.container.append(el('span', { class: 'test-list-hint' },
              items.length === 0 ? opts.emptyHint : 'No matches'));
            return;
          }

          for (const name of filtered) {
            const row = el('div', { class: 'test-list-row' });
            const cb = el('input', { type: 'checkbox', [opts.dataAttr]: name }) as HTMLInputElement;
            cb.checked = opts.selected.has(name);
            cb.addEventListener('change', () => {
              if (cb.checked) opts.selected.add(name);
              else opts.selected.delete(name);
              opts.onChange();
            });
            row.append(cb, name);
            opts.container.append(row);
          }

          rangeHandle = setupCheckboxRange(opts.container, selector, () => {
            opts.container.querySelectorAll<HTMLInputElement>(selector).forEach(box => {
              const n = box.getAttribute(opts.dataAttr)!;
              if (box.checked) opts.selected.add(n);
              else opts.selected.delete(n);
            });
            opts.onChange();
          });
        }

        opts.filterInput.addEventListener('input', () => render());

        return {
          rerender: render,
          destroy() { if (rangeHandle) { rangeHandle.destroy(); rangeHandle = null; } },
        };
      }

      // Machine selector (checkbox list with filter)
      const selectedMachines = new Set<string>();
      let allMachines: string[] = [];
      const machineGroupAdd = el('div', { class: 'control-group' });
      machineGroupAdd.append(el('label', {}, 'Machines'));
      const machineFilterInput = el('input', {
        type: 'text',
        class: 'combobox-input',
        placeholder: 'Search machines...',
      }) as HTMLInputElement;
      const machineListDiv = el('div', { class: 'checkbox-list-container' });
      machineGroupAdd.append(machineFilterInput, machineListDiv);
      selectorsDiv.append(machineGroupAdd);

      const machineList = renderCheckboxFilterList({
        container: machineListDiv,
        filterInput: machineFilterInput,
        allItems: () => allMachines,
        selected: selectedMachines,
        dataAttr: 'data-machine',
        emptyHint: 'Loading machines...',
        onChange: () => { refreshTests(); updatePreview(); },
      });
      cleanupFns.push(machineList.destroy);

      getMachines(ts, { limit: 500 }, signal).then(result => {
        allMachines = result.items.map(m => m.name);
        machineList.rerender();
      }).catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        machineListDiv.replaceChildren(el('span', { class: 'error-banner' }, `Failed: ${e}`));
      });

      // Test selector (checkbox list with filter)
      const selectedTests = new Set<string>();
      let allTests: string[] = [];
      const testGroup = el('div', { class: 'control-group' });
      testGroup.append(el('label', {}, 'Tests'));
      const testFilterInput = el('input', {
        type: 'text',
        class: 'combobox-input',
        placeholder: 'Search tests...',
      }) as HTMLInputElement;
      const testListDiv = el('div', { class: 'checkbox-list-container' });
      testGroup.append(testFilterInput, testListDiv);
      selectorsDiv.append(testGroup);

      const testList = renderCheckboxFilterList({
        container: testListDiv,
        filterInput: testFilterInput,
        allItems: () => allTests,
        selected: selectedTests,
        dataAttr: 'data-test',
        emptyHint: 'No tests found',
        onChange: () => updatePreview(),
      });
      cleanupFns.push(testList.destroy);

      async function refreshTests(): Promise<void> {
        allTests = [];
        testListDiv.replaceChildren();
        if (!selectedMetric || selectedMachines.size === 0) {
          selectedTests.clear();
          testListDiv.append(el('span', { class: 'test-list-hint' },
            'Select metric and machines first'));
          updatePreview();
          return;
        }
        if (refreshAbort) refreshAbort.abort();
        refreshAbort = new AbortController();
        const fetchSignal = refreshAbort.signal;

        testListDiv.replaceChildren(el('span', { class: 'test-list-hint' }, 'Loading tests...'));
        try {
          const results = await Promise.all(
            [...selectedMachines].map(machine =>
              getTests(ts, { machine, metric: selectedMetric, limit: 500 }, fetchSignal)
                .then(r => r.items.map(t => t.name))
                .catch((e: unknown) => {
                  if (e instanceof DOMException && e.name === 'AbortError') throw e;
                  return [] as string[];
                }),
            ),
          );
          allTests = [...new Set(results.flat())].sort();
          // Prune selections no longer available
          for (const t of selectedTests) {
            if (!allTests.includes(t)) selectedTests.delete(t);
          }
          testList.rerender();
        } catch (e: unknown) {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          testListDiv.replaceChildren(el('span', { class: 'error-banner' }, `Failed: ${e}`));
        }
      }

      addPanelDiv.append(selectorsDiv);

      const previewDiv = el('div', { class: 'add-indicator-preview' });
      const previewSpan = el('span', {}, 'Select metric, machine, and tests to add indicators');
      previewDiv.append(previewSpan);
      addPanelDiv.append(previewDiv);

      const addActionsDiv = el('div', { class: 'add-indicator-actions' });
      const addBtn = el('button', { class: 'compare-btn', disabled: '' }, 'Add') as HTMLButtonElement;
      addActionsDiv.append(addBtn);
      addPanelDiv.append(addActionsDiv);

      function updatePreview(): void {
        const count = selectedMachines.size * selectedTests.size;
        if (!selectedMetric || selectedMachines.size === 0 || selectedTests.size === 0) {
          previewSpan.textContent = 'Select metric, machines, and tests to add indicators';
          addBtn.disabled = true;
        } else {
          previewSpan.textContent = `This will add ${count} indicator${count !== 1 ? 's' : ''}`;
          addBtn.disabled = false;
        }
      }

      addBtn.addEventListener('click', async () => {
        if (!selectedMetric || selectedMachines.size === 0 || selectedTests.size === 0) return;
        addBtn.disabled = true;
        addErrorDiv.replaceChildren();

        const indicators = [...selectedMachines].flatMap(machine =>
          [...selectedTests].map(test => ({
            machine,
            test,
            metric: selectedMetric,
          })),
        );

        try {
          const updated = await addRegressionIndicators(ts, uuid, indicators, signal);
          regression = updated;
          renderIndicators();
          // Reset panel to clean state
          selectedMachines.clear();
          machineList.rerender();
          selectedMetric = '';
          const metricSelect = metricContainer.querySelector('select') as HTMLSelectElement | null;
          if (metricSelect) metricSelect.value = '';
          refreshTests();
        } catch (err: unknown) {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          addErrorDiv.replaceChildren(
            el('p', { class: 'error-banner' }, authErrorMessage(err)),
          );
        } finally {
          addBtn.disabled = false;
        }
      });
    }

    // ---------------------------------------------------------------
    // Delete regression section
    // ---------------------------------------------------------------

    function renderDeleteSection(): void {
      renderDeleteConfirm(deleteDiv, {
        label: 'Delete Regression',
        prompt: `Type "${uuid.slice(0, 8)}" to confirm deletion. This will delete the regression and all its indicators.`,
        confirmValue: uuid.slice(0, 8),
        placeholder: 'Regression UUID prefix',
        onDelete: () => deleteRegression(ts, uuid, signal),
        onSuccess: () => {
          window.location.assign(
            agnosticUrl(`/test-suites?suite=${encodeURIComponent(ts)}&tab=regressions`));
        },
      });
    }
  },

  unmount(): void {
    controller?.abort();
    controller = null;
    if (commitSearchCleanup) { commitSearchCleanup(); commitSearchCleanup = null; }
    if (checkboxRangeCleanup) { checkboxRangeCleanup(); checkboxRangeCleanup = null; }
    if (refreshAbort) { refreshAbort.abort(); refreshAbort = null; }
    cleanupFns.forEach(fn => fn());
    cleanupFns = [];
  },
};
