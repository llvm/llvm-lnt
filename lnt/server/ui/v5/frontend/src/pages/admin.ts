// pages/admin.ts — Admin page with API Keys and Test Suites tabs.
// Not test-suite specific — served at /v5/admin.

import type { PageModule, RouteParams } from '../router';
import type { APIKeyItem, TestSuiteInfo } from '../types';
import { getApiKeys, createApiKey, revokeApiKey, getTestSuiteInfo, createTestSuite, deleteTestSuite, authErrorMessage } from '../api';
import { el, formatTime } from '../utils';

let controller: AbortController | null = null;

export const adminPage: PageModule = {
  mount(container: HTMLElement, params: RouteParams): void {
    if (controller) controller.abort();
    controller = new AbortController();
    const { signal } = controller;

    // Get available test suites from the HTML data attribute
    const root = document.getElementById('v5-app');
    const testsuites: string[] = root
      ? JSON.parse(root.getAttribute('data-testsuites') || '[]')
      : [];

    container.append(el('h2', { class: 'page-header' }, 'Admin'));

    // Tab bar
    const tabBar = el('div', { class: 'v5-tab-bar' });
    const keysTab = el('button', { class: 'v5-tab v5-tab-active' }, 'API Keys');
    const schemasTab = el('button', { class: 'v5-tab' }, 'Test Suites');
    const createSuiteTab = el('button', { class: 'v5-tab' }, 'Create Suite');
    tabBar.append(keysTab, schemasTab, createSuiteTab);
    container.append(tabBar);

    const tabContent = el('div', { class: 'v5-tab-content' });
    container.append(tabContent);

    const allTabs = [keysTab, schemasTab, createSuiteTab];
    function activateTab(active: HTMLElement): void {
      for (const t of allTabs) t.classList.remove('v5-tab-active');
      active.classList.add('v5-tab-active');
    }

    keysTab.addEventListener('click', () => {
      activateTab(keysTab);
      renderApiKeysTab(tabContent, signal);
    });

    schemasTab.addEventListener('click', () => {
      activateTab(schemasTab);
      renderSchemasTab(tabContent, testsuites, signal);
    });

    createSuiteTab.addEventListener('click', () => {
      activateTab(createSuiteTab);
      renderCreateSuiteTab(tabContent, testsuites, signal, () => {
        // On create success: switch to Test Suites tab to see the new suite
        activateTab(schemasTab);
        renderSchemasTab(tabContent, testsuites, signal);
      });
    });

    // Default to API Keys tab
    renderApiKeysTab(tabContent, signal);
  },

  unmount(): void {
    if (controller) { controller.abort(); controller = null; }
  },
};

// ---------------------------------------------------------------------------
// API Keys Tab
// ---------------------------------------------------------------------------

function renderApiKeysTab(container: HTMLElement, signal: AbortSignal): void {
  container.replaceChildren(
    el('span', { class: 'progress-label' }, 'Loading API keys...'),
  );

  getApiKeys(signal)
    .then(keys => {
      container.replaceChildren();
      renderCreateForm(container);
      renderKeysTable(container, keys);
    })
    .catch(err => {
      container.replaceChildren(
        el('p', { class: 'error-banner' }, authErrorMessage(err)),
      );
    });
}

function renderCreateForm(container: HTMLElement): void {
  const form = el('div', { class: 'admin-create-form' });

  const nameInput = el('input', {
    type: 'text',
    class: 'admin-input',
    placeholder: 'Key name...',
  }) as HTMLInputElement;

  const scopeSelect = el('select', { class: 'admin-select' }) as HTMLSelectElement;
  for (const scope of ['read', 'submit', 'triage', 'manage', 'admin']) {
    scopeSelect.append(el('option', { value: scope }, scope));
  }

  const createBtn = el('button', { class: 'admin-btn' }, 'Create Key');
  const feedback = el('div', {});

  createBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) {
      feedback.replaceChildren(
        el('p', { class: 'error-banner' }, 'Key name is required.'),
      );
      return;
    }

    createBtn.setAttribute('disabled', '');
    feedback.replaceChildren(
      el('span', { class: 'progress-label' }, 'Creating...'),
    );

    createApiKey(name, scopeSelect.value)
      .then(result => {
        nameInput.value = '';
        const copyBtn = el('button', { class: 'admin-copy-btn', title: 'Copy to clipboard' }, '\u{1F4CB}');
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(result.key).then(() => {
            copyBtn.textContent = '\u2713';
            setTimeout(() => { copyBtn.textContent = '\u{1F4CB}'; }, 1500);
          });
        });
        const tokenBox = el('div', { class: 'admin-raw-token' },
          el('span', {}, result.key),
          copyBtn,
        );
        feedback.replaceChildren(
          el('div', { class: 'admin-key-created' },
            el('p', {}, 'Key created. Copy the token now — it will not be shown again:'),
            tokenBox,
          ),
        );
        createBtn.removeAttribute('disabled');
        // Refresh the keys table
        const tableContainer = container.querySelector('.admin-keys-table-container');
        if (tableContainer) {
          getApiKeys(signal).then(keys => {
            renderKeysTable(container, keys);
          }).catch(() => { /* keep existing table */ });
        }
      })
      .catch(err => {
        createBtn.removeAttribute('disabled');
        feedback.replaceChildren(
          el('p', { class: 'error-banner' }, authErrorMessage(err)),
        );
      });
  });

  form.append(
    el('label', {}, 'Create API Key'),
    el('div', { class: 'admin-form-row' }, nameInput, scopeSelect, createBtn),
    feedback,
  );
  container.append(form);
}

function renderKeysTable(container: HTMLElement, keys: APIKeyItem[]): void {
  // Remove existing table if present
  const existing = container.querySelector('.admin-keys-table-container');
  if (existing) existing.remove();

  const wrapper = el('div', { class: 'admin-keys-table-container' });

  if (keys.length === 0) {
    wrapper.append(el('p', {}, 'No API keys found.'));
    container.append(wrapper);
    return;
  }

  const table = el('table', { class: 'comparison-table' }) as HTMLTableElement;
  const thead = el('thead');
  const headerRow = el('tr');
  for (const label of ['Prefix', 'Name', 'Scope', 'Created', 'Last Used', 'Active', '']) {
    headerRow.append(el('th', {}, label));
  }
  thead.append(headerRow);
  table.append(thead);

  const tbody = el('tbody');
  for (const key of keys) {
    const tr = el('tr');
    tr.append(
      el('td', {}, key.prefix),
      el('td', {}, key.name),
      el('td', {}, key.scope),
      el('td', {}, formatTime(key.created_at)),
      el('td', {}, formatTime(key.last_used_at)),
      el('td', {}, key.is_active ? 'Yes' : 'No'),
    );

    const actionTd = el('td', {});
    if (key.is_active) {
      const revokeBtn = el('button', { class: 'admin-btn admin-btn-danger' }, 'Revoke');
      revokeBtn.addEventListener('click', () => {
        revokeBtn.setAttribute('disabled', '');
        revokeBtn.textContent = 'Revoking...';
        revokeApiKey(key.prefix)
          .then(() => {
            // Refresh
            getApiKeys(signal).then(updated => {
              renderKeysTable(container, updated);
            }).catch(() => {
              revokeBtn.removeAttribute('disabled');
              revokeBtn.textContent = 'Revoke';
            });
          })
          .catch(err => {
            revokeBtn.removeAttribute('disabled');
            revokeBtn.textContent = 'Revoke';
            // Show error inline in the row
            actionTd.append(el('span', { class: 'error-banner', style: 'display:inline; margin-left:4px; font-size:12px' }, authErrorMessage(err)));
          });
      });
      actionTd.append(revokeBtn);
    }
    tr.append(actionTd);
    tbody.append(tr);
  }
  table.append(tbody);

  wrapper.append(table);
  container.append(wrapper);
}

// ---------------------------------------------------------------------------
// Schemas (Test Suites) Tab
// ---------------------------------------------------------------------------

function renderSchemasTab(container: HTMLElement, _testsuites: string[], signal: AbortSignal): void {
  container.replaceChildren();

  // Always read the current suites from the DOM attribute (single source of truth).
  // The _testsuites parameter is kept for API compatibility but not used.
  const root = document.getElementById('v5-app');
  let suites: string[] = root
    ? JSON.parse(root.getAttribute('data-testsuites') || '[]')
    : [..._testsuites];

  // --- Suite selector + viewer ---
  const selectorRow = el('div', { class: 'admin-form-row', style: 'margin-bottom: 12px' });
  selectorRow.append(el('label', {}, 'Test Suite: '));
  const suiteSelect = el('select', { class: 'admin-select' }) as HTMLSelectElement;
  selectorRow.append(suiteSelect);
  container.append(selectorRow);

  const schemaContent = el('div', {});
  container.append(schemaContent);

  function populateSelect(selectName?: string): void {
    suiteSelect.replaceChildren();
    if (suites.length === 0) {
      suiteSelect.append(el('option', { value: '' }, '(no test suites)'));
      schemaContent.replaceChildren(el('p', {}, 'No test suites available.'));
      return;
    }
    for (const name of suites) {
      suiteSelect.append(el('option', { value: name }, name));
    }
    if (selectName && suites.includes(selectName)) {
      suiteSelect.value = selectName;
    }
    loadSchema();
  }

  function loadSchema(): void {
    const ts = suiteSelect.value;
    if (!ts) return;
    schemaContent.replaceChildren(
      el('span', { class: 'progress-label' }, 'Loading schema...'),
    );
    getTestSuiteInfo(ts, signal)
      .then(info => {
        schemaContent.replaceChildren();
        renderSchemaContent(schemaContent, info);
        renderDeleteSuite(schemaContent, ts, () => reloadSuites());
      })
      .catch(err => {
        schemaContent.replaceChildren(
          el('p', { class: 'error-banner' }, `Failed to load schema: ${err}`),
        );
      });
  }

  function reloadSuites(selectName?: string): void {
    // Re-read from the HTML attribute which is kept in sync on create/delete.
    const root = document.getElementById('v5-app');
    if (root) {
      suites = JSON.parse(root.getAttribute('data-testsuites') || '[]');
    }
    populateSelect(selectName);
  }

  suiteSelect.addEventListener('change', loadSchema);
  populateSelect();
}

function renderCreateSuiteTab(
  container: HTMLElement,
  _suites: string[],
  signal: AbortSignal,
  onCreated: () => void,
): void {
  container.replaceChildren();

  const section = el('div', { class: 'admin-create-form' });
  section.append(el('label', {}, 'Create Test Suite'));

  const nameInput = el('input', {
    type: 'text',
    class: 'admin-input',
    placeholder: 'Suite name (e.g., my_suite)...',
  }) as HTMLInputElement;

  const jsonArea = el('textarea', {
    class: 'admin-textarea',
    placeholder: '{\n  "format_version": "5",\n  "name": "my_suite",\n  "metrics": [\n    {"name": "exec_time", "type": "Real", "bigger_is_better": false}\n  ],\n  "commit_fields": [\n    {"name": "revision"}\n  ],\n  "machine_fields": [\n    {"name": "hostname"}\n  ]\n}',
  }) as HTMLTextAreaElement;
  jsonArea.rows = 10;

  const createBtn = el('button', { class: 'admin-btn' }, 'Create');
  const feedback = el('div', {});

  createBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) {
      feedback.replaceChildren(el('p', { class: 'error-banner' }, 'Suite name is required.'));
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(jsonArea.value);
    } catch {
      feedback.replaceChildren(el('p', { class: 'error-banner' }, 'Invalid JSON.'));
      return;
    }

    // Ensure name in payload matches the name input
    payload['name'] = name;
    if (!payload['format_version']) payload['format_version'] = '5';

    createBtn.setAttribute('disabled', '');
    feedback.replaceChildren(el('span', { class: 'progress-label' }, 'Creating...'));

    createTestSuite(payload, signal)
      .then(() => {
        createBtn.removeAttribute('disabled');
        nameInput.value = '';
        jsonArea.value = '';
        feedback.replaceChildren(
          el('p', { class: 'admin-key-created', style: 'padding: 8px' },
            `Test suite '${name}' created successfully.`),
        );
        // Update the DOM attribute (source of truth) and nav bar so the new suite is selectable.
        // Do NOT mutate the shared `suites` array — rebuild from the DOM attribute instead.
        const root = document.getElementById('v5-app');
        if (root) {
          const current: string[] = JSON.parse(root.getAttribute('data-testsuites') || '[]');
          const updated = [...current, name].sort();
          root.setAttribute('data-testsuites', JSON.stringify(updated));
        }
        onCreated();
      })
      .catch(err => {
        createBtn.removeAttribute('disabled');
        feedback.replaceChildren(el('p', { class: 'error-banner' }, authErrorMessage(err)));
      });
  });

  section.append(
    el('div', { class: 'admin-form-row' }, nameInput),
    jsonArea,
    el('div', { class: 'admin-form-row', style: 'margin-top: 8px' }, createBtn),
    feedback,
  );
  container.append(section);
}

function renderDeleteSuite(
  container: HTMLElement,
  suiteName: string,
  onDeleted: () => void,
): void {
  const section = el('div', { class: 'admin-delete-section' });

  const deleteToggle = el('button', { class: 'admin-btn admin-btn-danger' }, 'Delete This Suite');
  section.append(deleteToggle);

  const confirmPanel = el('div', { class: 'admin-delete-confirm', style: 'display: none' });

  confirmPanel.append(el('p', { class: 'admin-delete-warning' },
    `Deleting test suite '${suiteName}' will permanently destroy all machines, runs, ` +
    'commits, samples, regressions, and field changes associated with it. ' +
    'This cannot be undone.',
  ));

  confirmPanel.append(el('p', {}, `Type "${suiteName}" to confirm:`));

  const confirmInput = el('input', {
    type: 'text',
    class: 'admin-input',
    placeholder: suiteName,
  }) as HTMLInputElement;

  const confirmBtn = el('button', {
    class: 'admin-btn admin-btn-danger',
    disabled: '',
  }, 'Delete permanently') as HTMLButtonElement;

  const feedback = el('div', {});

  confirmInput.addEventListener('input', () => {
    if (confirmInput.value === suiteName) {
      confirmBtn.removeAttribute('disabled');
    } else {
      confirmBtn.setAttribute('disabled', '');
    }
  });

  confirmBtn.addEventListener('click', () => {
    confirmBtn.setAttribute('disabled', '');
    confirmBtn.textContent = 'Deleting...';
    feedback.replaceChildren();

    deleteTestSuite(suiteName)
      .then(() => {
        section.replaceChildren(
          el('p', { class: 'admin-key-created', style: 'padding: 8px' },
            `Test suite '${suiteName}' deleted.`),
        );
        // Remove from the suites list tracked by the parent
        const root = document.getElementById('v5-app');
        if (root) {
          const current: string[] = JSON.parse(root.getAttribute('data-testsuites') || '[]');
          const updated = current.filter(s => s !== suiteName);
          root.setAttribute('data-testsuites', JSON.stringify(updated));
        }
        onDeleted();
      })
      .catch(err => {
        confirmBtn.removeAttribute('disabled');
        confirmBtn.textContent = 'Delete permanently';
        feedback.replaceChildren(el('p', { class: 'error-banner' }, authErrorMessage(err)));
      });
  });

  confirmPanel.append(
    el('div', { class: 'admin-form-row' }, confirmInput, confirmBtn),
    feedback,
  );
  section.append(confirmPanel);

  deleteToggle.addEventListener('click', () => {
    const visible = confirmPanel.style.display !== 'none';
    confirmPanel.style.display = visible ? 'none' : 'block';
    deleteToggle.textContent = visible ? 'Delete This Suite' : 'Cancel';
    deleteToggle.classList.toggle('admin-btn-danger', visible);
    if (visible) {
      confirmInput.value = '';
      confirmBtn.setAttribute('disabled', '');
    }
  });

  container.append(section);
}

function renderSchemaContent(container: HTMLElement, info: TestSuiteInfo): void {

  // Metrics table
  if (info.schema.metrics.length > 0) {
    container.append(el('h4', {}, 'Metrics'));
    const table = el('table', { class: 'comparison-table' }) as HTMLTableElement;
    const thead = el('thead');
    const headerRow = el('tr');
    for (const label of ['Name', 'Type', 'Display Name', 'Unit', 'Bigger is Better']) {
      headerRow.append(el('th', {}, label));
    }
    thead.append(headerRow);
    table.append(thead);

    const tbody = el('tbody');
    for (const f of info.schema.metrics) {
      const tr = el('tr');
      tr.append(
        el('td', {}, f.name),
        el('td', {}, f.type),
        el('td', {}, f.display_name || '\u2014'),
        el('td', {}, f.unit ? `${f.unit} (${f.unit_abbrev || ''})` : '\u2014'),
        el('td', {}, f.bigger_is_better === null ? '\u2014' : f.bigger_is_better ? 'Yes' : 'No'),
      );
      tbody.append(tr);
    }
    table.append(tbody);
    container.append(table);
  }

  // Other schema sections
  for (const [label, fields] of [
    ['Commit Fields', info.schema.commit_fields],
    ['Machine Fields', info.schema.machine_fields],
    ['Run Fields', info.schema.run_fields],
  ] as const) {
    if (fields && fields.length > 0) {
      container.append(el('h4', {}, label));
      const table = el('table', { class: 'comparison-table' }) as HTMLTableElement;
      const thead = el('thead');
      const hr = el('tr');
      hr.append(el('th', {}, 'Name'), el('th', {}, 'Type'));
      thead.append(hr);
      table.append(thead);

      const tbody = el('tbody');
      for (const f of fields) {
        const tr = el('tr');
        tr.append(el('td', {}, f.name), el('td', {}, f.type));
        tbody.append(tr);
      }
      table.append(tbody);
      container.append(table);
    }
  }
}
