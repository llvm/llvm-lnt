# v5 Regression UI — Implementation Plan

This document is a step-by-step implementation plan for the Regression List page, Regression Detail page, and cross-page regression integration in the v5 Web UI. Each phase includes exact file paths, type definitions, function signatures, component structure, CSS class names, and testing strategy. The plan assumes the reader has already read `docs/design/ui/regressions.md` and is familiar with the existing frontend source in `lnt/server/ui/v5/frontend/src/`.

## Prerequisite Reading

Before starting, read:
- `docs/design/ui/regressions.md` — Regression List and Regression Detail page specs
- `lnt/server/api/v5/endpoints/regressions.py` — the full API implementation
- `lnt/server/api/v5/schemas/regressions.py` — request/response schemas and state constants
- All existing frontend components in `lnt/server/ui/v5/frontend/src/components/`
- Existing page implementations (`machine-detail.ts`, `run-detail.ts`, `commit-detail.ts`) for patterns

---

## Phase 1: Types & API Functions

**Goal**: Add TypeScript interfaces for regression and indicator types to `types.ts`, and add API client functions for all 7 regression endpoints to `api.ts`. No UI changes in this phase.

### 1.1 Regression Types

**File**: `lnt/server/ui/v5/frontend/src/types.ts` (extend existing)

Add the following interfaces at the end of the file, after the existing `TestSuiteInfo` interface:

```typescript
// Regression types

export type RegressionState =
  | 'detected'
  | 'active'
  | 'not_to_be_fixed'
  | 'fixed'
  | 'false_positive';

export interface RegressionIndicator {
  uuid: string;
  machine: string;
  test: string;
  metric: string;
}

/** Regression as returned by GET /regressions (list endpoint). */
export interface RegressionListItem {
  uuid: string;
  title: string | null;
  bug: string | null;
  state: RegressionState;
  commit: string | null;
  machine_count: number;
  test_count: number;
}

/** Regression as returned by GET /regressions/{uuid} (detail endpoint). */
export interface RegressionDetail {
  uuid: string;
  title: string | null;
  bug: string | null;
  notes: string | null;
  state: RegressionState;
  commit: string | null;
  indicators: RegressionIndicator[];
}
```

**Implementation notes**:
- `RegressionState` is a union type matching the 5 valid states in `lnt/server/api/v5/schemas/regressions.py` (`STATE_TO_DB` keys).
- `RegressionListItem` matches the shape from `_serialize_regression_list()` in `regressions.py`.
- `RegressionDetail` matches `_serialize_regression_detail()` — includes `notes` and embedded `indicators` array.
- Both `RegressionListItem` and `RegressionDetail` share the base fields from `_serialize_regression_base()`.

### 1.2 Regression API Functions

**File**: `lnt/server/ui/v5/frontend/src/api.ts` (extend existing)

Add the following imports at the top (extend the existing `import type` statement):

```typescript
import type {
  // ... existing imports ...
  RegressionListItem, RegressionDetail, RegressionState,
} from './types';
```

Add the following functions after the existing admin API functions, in a new `// Regressions` section:

```typescript
// ---------------------------------------------------------------------------
// Regressions
// ---------------------------------------------------------------------------

/** Query parameters for listing regressions. */
export interface RegressionListParams {
  state?: RegressionState[];
  machine?: string;
  test?: string;
  metric?: string;
  commit?: string;
  has_commit?: boolean;
  cursor?: string;
  limit?: number;
}

/** Fetch one page of regressions with optional filters. */
export async function getRegressions(
  ts: string,
  opts?: RegressionListParams,
  signal?: AbortSignal,
): Promise<CursorPageResult<RegressionListItem>> {
  const params: Record<string, string | string[]> = {};
  if (opts?.state?.length) params.state = opts.state.join(',');
  if (opts?.machine) params.machine = opts.machine;
  if (opts?.test) params.test = opts.test;
  if (opts?.metric) params.metric = opts.metric;
  if (opts?.commit) params.commit = opts.commit;
  if (opts?.has_commit === true) params.has_commit = 'true';
  if (opts?.has_commit === false) params.has_commit = 'false';
  if (opts?.limit !== undefined) params.limit = String(opts.limit);
  if (opts?.cursor) params.cursor = opts.cursor;
  return fetchOneCursorPage<RegressionListItem>(
    apiUrl(ts, 'regressions'), params, signal);
}

/** Fetch all regressions matching filters (auto-paginate). */
export async function getAllRegressions(
  ts: string,
  opts?: Omit<RegressionListParams, 'cursor' | 'limit'>,
  signal?: AbortSignal,
): Promise<RegressionListItem[]> {
  const params: Record<string, string | string[]> = {};
  if (opts?.state?.length) params.state = opts.state.join(',');
  if (opts?.machine) params.machine = opts.machine;
  if (opts?.test) params.test = opts.test;
  if (opts?.metric) params.metric = opts.metric;
  if (opts?.commit) params.commit = opts.commit;
  if (opts?.has_commit === true) params.has_commit = 'true';
  if (opts?.has_commit === false) params.has_commit = 'false';
  return fetchAllCursorPages<RegressionListItem>(
    apiUrl(ts, 'regressions'), params, signal);
}

/** Create a new regression. */
export async function createRegression(
  ts: string,
  body: {
    title?: string;
    bug?: string;
    notes?: string;
    state?: RegressionState;
    commit?: string;
    indicators?: Array<{ machine: string; test: string; metric: string }>;
  },
  signal?: AbortSignal,
): Promise<RegressionDetail> {
  return fetchJson<RegressionDetail>(
    apiUrl(ts, 'regressions'),
    { method: 'POST', body, signal },
  );
}

/** Fetch a single regression by UUID. */
export async function getRegression(
  ts: string,
  uuid: string,
  signal?: AbortSignal,
): Promise<RegressionDetail> {
  return fetchJson<RegressionDetail>(
    apiUrl(ts, `regressions/${encodeURIComponent(uuid)}`),
    { signal },
  );
}

/** Update regression fields (PATCH — only included fields are changed). */
export async function updateRegression(
  ts: string,
  uuid: string,
  updates: {
    title?: string;
    bug?: string | null;
    notes?: string | null;
    state?: RegressionState;
    commit?: string | null;
  },
  signal?: AbortSignal,
): Promise<RegressionDetail> {
  return fetchJson<RegressionDetail>(
    apiUrl(ts, `regressions/${encodeURIComponent(uuid)}`),
    { method: 'PATCH', body: updates, signal },
  );
}

/** Delete a regression. */
export async function deleteRegression(
  ts: string,
  uuid: string,
  signal?: AbortSignal,
): Promise<void> {
  return fetchVoid(
    apiUrl(ts, `regressions/${encodeURIComponent(uuid)}`),
    { method: 'DELETE', signal },
  );
}

/** Add indicators to a regression (batch). Returns updated detail. */
export async function addRegressionIndicators(
  ts: string,
  regressionUuid: string,
  indicators: Array<{ machine: string; test: string; metric: string }>,
  signal?: AbortSignal,
): Promise<RegressionDetail> {
  return fetchJson<RegressionDetail>(
    apiUrl(ts, `regressions/${encodeURIComponent(regressionUuid)}/indicators`),
    { method: 'POST', body: { indicators }, signal },
  );
}

/** Remove indicators from a regression (batch, by UUID). Returns updated detail. */
export async function removeRegressionIndicators(
  ts: string,
  regressionUuid: string,
  indicatorUuids: string[],
  signal?: AbortSignal,
): Promise<RegressionDetail> {
  return fetchJson<RegressionDetail>(
    apiUrl(ts, `regressions/${encodeURIComponent(regressionUuid)}/indicators`),
    { method: 'DELETE', body: { indicator_uuids: indicatorUuids }, signal },
  );
}
```

**Implementation notes**:
- `getRegressions` uses `fetchOneCursorPage` for manual cursor control (matching the pattern from `getRunsPage`, `getCommitsPage`).
- `getAllRegressions` uses `fetchAllCursorPages` for auto-pagination (useful for cross-page integration where we need all matching regressions).
- `removeRegressionIndicators` uses `fetchJson` (not `fetchVoid`) because the DELETE endpoint returns the updated regression detail (200, not 204). This matches the API behavior in `regressions.py` line 402-420.
- The `state` parameter is serialized as a comma-separated string matching the `DelimitedList` field in `RegressionListQuerySchema`.

### 1.3 State Display Constants

**File**: `lnt/server/ui/v5/frontend/src/pages/regression-list.ts` (will be replaced in Phase 2, but define constants here that Phase 3 also reuses)

Since both the list and detail pages need state display metadata, define a shared module:

**File**: `lnt/server/ui/v5/frontend/src/regression-utils.ts` (new file)

```typescript
// regression-utils.ts — Shared constants and helpers for regression pages.

import type { RegressionState } from './types';

/** Display metadata for each regression state. */
export const STATE_META: Record<RegressionState, {
  label: string;
  cssClass: string;
}> = {
  detected:        { label: 'Detected',        cssClass: 'state-detected' },
  active:          { label: 'Active',           cssClass: 'state-active' },
  not_to_be_fixed: { label: 'Not To Be Fixed', cssClass: 'state-not-to-be-fixed' },
  fixed:           { label: 'Fixed',            cssClass: 'state-fixed' },
  false_positive:  { label: 'False Positive',   cssClass: 'state-false-positive' },
};

/** All valid regression states in display order. */
export const ALL_STATES: RegressionState[] = [
  'detected', 'active', 'not_to_be_fixed', 'fixed', 'false_positive',
];

/** Resolved states (these are considered "closed"). */
export const RESOLVED_STATES: RegressionState[] = [
  'not_to_be_fixed', 'fixed', 'false_positive',
];

/** Non-resolved states (these are "open" / active). */
export const UNRESOLVED_STATES: RegressionState[] = [
  'detected', 'active',
];
```

### 1.4 Phase 1 Testing

**File**: `lnt/server/ui/v5/frontend/src/__tests__/api.test.ts` (extend existing)

Add tests for each of the 7 regression API functions. Follow the existing pattern in `api.test.ts` which uses `vi.stubGlobal('fetch', mockFetch)` and verifies URL construction, HTTP method, request body, and response parsing.

Tests to add:
- `getRegressions` — verifies URL is `{base}/api/v5/{ts}/regressions`, state param is comma-joined, limit/cursor forwarded
- `getRegressions` with empty opts — no query params
- `getAllRegressions` — verifies multi-page fetch (mock two pages)
- `createRegression` — POST method, JSON body with title/state/commit/indicators
- `getRegression` — GET with UUID in path
- `updateRegression` — PATCH method, JSON body, UUID in path
- `deleteRegression` — DELETE method, UUID in path, no response body parsing
- `addRegressionIndicators` — POST to `/indicators` sub-path, body has `indicators` array
- `removeRegressionIndicators` — DELETE to `/indicators` sub-path, body has `indicator_uuids` array, returns `RegressionDetail`

---

## Phase 2: Regression List Page

**Goal**: Replace the stub in `regression-list.ts` with a full implementation: state filter chips, machine/test/metric filters, sortable data table, cursor pagination, create form, and per-row delete.

### 2.1 Regression List Page Module

**File**: `lnt/server/ui/v5/frontend/src/pages/regression-list.ts` (replace stub)

**Structure**: The page follows the standard PageModule pattern with `mount(container, params)` and `unmount()`. An `AbortController` manages all async operations and is aborted on unmount.

```typescript
import type { PageModule, RouteParams } from '../router';
import type { RegressionListItem, RegressionState, FieldInfo } from '../types';
import {
  getRegressions, createRegression, deleteRegression, getFields,
  apiUrl, authErrorMessage, CursorPageResult,
} from '../api';
import { el, spaLink, truncate, debounce } from '../utils';
import { navigate } from '../router';
import { renderDataTable, type Column } from '../components/data-table';
import { renderPagination } from '../components/pagination';
import { renderMachineCombobox } from '../components/machine-combobox';
import { renderMetricSelector, filterMetricFields } from '../components/metric-selector';
import { ALL_STATES, STATE_META } from '../regression-utils';

const PAGE_SIZE = 25;

let controller: AbortController | null = null;
let machineComboCleanup: (() => void) | null = null;

export const regressionListPage: PageModule = {
  mount(container: HTMLElement, params: RouteParams): void { ... },
  unmount(): void {
    controller?.abort();
    machineComboCleanup?.();
  },
};
```

**DOM layout** (created in `mount`):

```
<h2 class="page-header">Regressions</h2>
<div class="regression-filters">           ← Filter control panel
  <div class="state-chips">                ← State filter chips
  <div class="filter-row">                 ← Machine, test, metric, has_commit
  <div class="filter-row">                 ← Title search
</div>
<div class="regression-actions">           ← "New Regression" button
<div class="create-form-container">        ← Collapsible create form
<div class="regression-list-error">        ← Error messages
<div class="regression-table-container">   ← Data table
<div class="regression-pagination">        ← Pagination controls
```

**Auth scope gating**: The "New Regression" button, per-row delete actions, and the create form require `triage` scope. Check whether a token is available via `getToken()` (from `api.ts`). If no token is set, hide mutation controls entirely. If a mutation request returns 401/403, display the error via `authErrorMessage(err)`. This pattern matches the existing admin page which hides controls for unauthenticated users.

### 2.2 State Filter Chips

Render inside `.state-chips` as toggle buttons. Each chip is a `<button>` with class `state-chip` and the appropriate `state-*` class from `STATE_META`. Clicking toggles the state in/out of the active filter set. All chips start deselected (no state filter = show all).

```typescript
function renderStateChips(
  container: HTMLElement,
  activeStates: Set<RegressionState>,
  onChange: (states: Set<RegressionState>) => void,
): void;
```

Each chip uses:
- Class: `state-chip` + `state-chip-active` when selected
- Data attribute: `data-state="{state}"`
- Text content: `STATE_META[state].label`

Clicking a chip toggles `state-chip-active` and calls `onChange` with the updated set.

### 2.3 Machine / Test / Metric / Has-Commit Filters

Render a row of filter controls below the state chips:

- **Machine**: Use existing `renderMachineCombobox` from `components/machine-combobox.ts`. On select, update filter and reload. On clear, remove machine filter.
- **Test**: Use a test combobox with typeahead, following the same pattern as `renderMachineCombobox`. The `getTests(ts)` API provides the test name list. On select, update filter and reload. On clear, remove test filter. **Cleanup**: track the combobox's `destroy()` handle in the module-scoped cleanup (same as machine combobox).
- **Metric**: Use existing `renderMetricSelector` from `components/metric-selector.ts` with `placeholder: true`. Requires fields fetched via `getFields(ts)`. On change, update filter and reload.
- **Has commit**: A `<label>` with a `<input type="checkbox">` and text "Has commit". When checked, filter `has_commit=true`. When unchecked, no `has_commit` filter (show all). This is a two-state control (not tri-state).
- **Title search**: A plain text input (`<input type="text" class="title-search-input" placeholder="Search title...">`). Debounced 300ms. Client-side filter on the loaded page (the API does not support title search, so this filters the current page's items after fetch).

**Implementation note**: The title search is a client-side filter applied after the API response. The API's `RegressionListQuerySchema` does not include a title search parameter. This is acceptable because the page loads one page at a time (PAGE_SIZE=25 items), and client-side filtering on 25 items is instant.

### 2.4 Data Table

Use `renderDataTable` from `components/data-table.ts` with the following column definitions:

```typescript
const columns: Column<RegressionListItem>[] = [
  {
    key: 'title',
    label: 'Title',
    render: (r) => spaLink(
      truncate(r.title || '(untitled)', 60),
      `/regressions/${encodeURIComponent(r.uuid)}`,
    ),
    sortValue: (r) => r.title || '',
  },
  {
    key: 'state',
    label: 'State',
    render: (r) => {
      const meta = STATE_META[r.state] || { label: r.state, cssClass: '' };
      return el('span', { class: `state-badge ${meta.cssClass}` }, meta.label);
    },
    sortValue: (r) => ALL_STATES.indexOf(r.state),
  },
  {
    key: 'commit',
    label: 'Commit',
    render: (r) => r.commit
      ? spaLink(truncate(r.commit, 12), `/commits/${encodeURIComponent(r.commit)}`)
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
      ? el('a', { href: r.bug, target: '_blank', rel: 'noopener' }, 'Link')
      : '\u2014',
    sortable: false,
  },
  {
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
  },
];
```

Row click navigates to regression detail:
```typescript
onRowClick: (r) => navigate(`/regressions/${encodeURIComponent(r.uuid)}`),
```

### 2.5 Pagination

Use cursor-stack pagination following the pattern from `machine-detail.ts`:

```typescript
const cursorStack: string[] = [];
let currentCursor: string | undefined;

async function loadPage(): Promise<void> {
  // Build params from current filter state
  // Call getRegressions(ts, params, signal)
  // Render table and pagination controls
}
```

Use `renderPagination` from `components/pagination.ts`:
```typescript
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
```

When any filter changes, reset `cursorStack` to `[]`, set `currentCursor` to `undefined`, and call `loadPage()`.

### 2.6 Create Regression Form

The "New Regression" button is a `<button class="compare-btn">New Regression</button>` rendered in `.regression-actions`. Clicking it toggles visibility of `.create-form-container`.

The create form contains:
- Title: `<input type="text" class="admin-input" placeholder="Regression title">`
- State: `<select class="metric-select">` with options from `ALL_STATES`, default "detected"
- Bug: `<input type="text" class="admin-input" placeholder="Bug URL (optional)">`
- Commit: Use `renderCommitSearch` from `components/commit-search.ts` with `onSelect` callback
- Buttons: "Create" (`<button class="compare-btn">`) and "Cancel" (`<button class="pagination-btn">`)
- Error area: `<div class="create-form-error">`

On submit:
1. Disable the "Create" button
2. Call `createRegression(ts, { title, state, bug, commit })` — indicators are added later from the detail page
3. On success, navigate to `/regressions/${uuid}` (the newly created regression's detail page)
4. On error, show error in `.create-form-error` using `authErrorMessage(err)`, re-enable button

### 2.7 Per-Row Delete

The `confirmAndDelete(r)` function called from the row action button:

1. Show a `window.confirm()` dialog: `Delete regression "${r.title || r.uuid.slice(0, 8)}"? This cannot be undone.`
2. If confirmed, call `deleteRegression(ts, r.uuid)`
3. On success, call `loadPage()` to refresh the table
4. On error, show error in `.regression-list-error`

**Design decision**: Per-row delete uses `window.confirm()` rather than the `renderDeleteConfirm` component. The type-to-confirm pattern is appropriate for destructive actions on large entities (machines, runs) but is too heavy for individual regression rows in a triage list. A simple browser confirm dialog provides sufficient protection.

### 2.8 Phase 2 Testing

**File**: `lnt/server/ui/v5/frontend/src/__tests__/pages/regression-list.test.ts` (new file)

Follow the testing pattern from `__tests__/pages/machine-detail.test.ts`:

```typescript
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock API module
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    getRegressions: vi.fn(),
    createRegression: vi.fn(),
    deleteRegression: vi.fn(),
    getFields: vi.fn(),
  };
});

// Mock router
vi.mock('../../router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../router')>();
  return {
    ...actual,
    navigate: vi.fn(),
    getBasePath: vi.fn(() => '/v5/nts'),
    getUrlBase: vi.fn(() => ''),
  };
});
```

**Test cases**:
- Renders page header "Regressions"
- Renders state filter chips for all 5 states
- Calls `getRegressions` with correct testsuite on mount
- Renders data table with columns: Title, State, Commit, Machines, Tests, Bug
- Title column renders as SPA link to detail page
- State column renders badge with correct CSS class
- Commit column renders as SPA link to commit detail
- Bug column renders as external link
- Row click calls `navigate` to regression detail
- "New Regression" button toggles create form visibility
- Create form submission calls `createRegression` with form values
- Successful creation navigates to the new regression's detail page
- Create form shows error on API failure
- Per-row delete button calls `deleteRegression` after confirmation
- Pagination: Previous disabled on first page, Next enabled when cursor exists
- Filter changes reset pagination cursor
- State chip toggle triggers reload with state filter
- Unmount aborts in-flight requests without error
- Empty state shows "No regressions found."

---

## Phase 3: Regression Detail Page

**Goal**: Replace the stub in `regression-detail.ts` with a full implementation: editable header fields (title, state, bug, commit, notes), indicators table with batch remove, add indicators panel, and delete regression.

### 3.1 Regression Detail Page Module

**File**: `lnt/server/ui/v5/frontend/src/pages/regression-detail.ts` (replace stub)

**Structure**:

```typescript
import type { PageModule, RouteParams } from '../router';
import type { RegressionDetail, RegressionIndicator, RegressionState, FieldInfo } from '../types';
import {
  getRegression, updateRegression, deleteRegression,
  addRegressionIndicators, removeRegressionIndicators,
  getFields, getTests, authErrorMessage, apiUrl,
} from '../api';
import { el, spaLink, agnosticLink, agnosticUrl, truncate } from '../utils';
import { navigate } from '../router';
import { renderDataTable, type Column } from '../components/data-table';
import { renderDeleteConfirm } from '../components/delete-confirm';
import { renderMachineCombobox } from '../components/machine-combobox';
import { renderMetricSelector, filterMetricFields } from '../components/metric-selector';
import { renderCommitSearch } from '../components/commit-search';
import { ALL_STATES, STATE_META } from '../regression-utils';

let controller: AbortController | null = null;
/** Track component cleanup handles to prevent resource leaks on unmount. */
let cleanupFns: (() => void)[] = [];

export const regressionDetailPage: PageModule = {
  mount(container: HTMLElement, params: RouteParams): void { ... },
  unmount(): void {
    controller?.abort();
    cleanupFns.forEach(fn => fn());
    cleanupFns = [];
  },
};
```

**DOM layout**:

```
<h2 class="page-header">Regression: {uuid_short}</h2>
<div class="regression-header">               ← Editable header fields
  <div class="field-row">                     ← Title (inline-editable)
  <div class="field-row">                     ← State dropdown
  <div class="field-row">                     ← Bug URL
  <div class="field-row">                     ← Commit combobox
  <div class="field-row regression-notes">    ← Notes textarea
</div>
<div class="regression-header-error">         ← Error messages for header edits
<h3>Indicators</h3>
<div class="indicator-actions">               ← Batch remove button
<div class="indicator-table-container">       ← Indicators table
<h3>Add Indicators</h3>
<div class="add-indicators-panel">            ← Three selectors + preview + add button
<div class="add-indicators-error">            ← Error for add operation
<div class="delete-regression-section">       ← Delete with confirmation
```

### 3.2 Data Loading

On mount, fetch the regression detail and field definitions in parallel:

```typescript
Promise.all([
  getRegression(ts, uuid, signal),
  getFields(ts, signal),
]).then(([regression, fields]) => {
  renderHeader(regression, fields);
  renderIndicatorsSection(regression);
  renderAddIndicatorsPanel(regression, fields);
  renderDeleteSection(regression);
}).catch(e => {
  container.append(el('p', { class: 'error-banner' },
    `Failed to load regression: ${e}`));
});
```

The `regression` variable is kept as module-scoped mutable state. Each successful PATCH/POST/DELETE to the indicators refreshes this variable with the returned `RegressionDetail` and re-renders the affected sections.

### 3.3 Editable Header Fields

Each field row in the header section follows this pattern: a display view with an "Edit" button (or the field is always in edit mode for dropdowns). Saving is immediate — each field change triggers an independent PATCH request.

#### Title (inline-editable text)

Display mode: `<span class="editable-value">{title}</span>` + `<button class="edit-btn">Edit</button>`

Edit mode: `<input type="text" class="admin-input" value="{title}">` + `<button class="compare-btn">Save</button>` + `<button class="pagination-btn">Cancel</button>`

On save:
```typescript
updateRegression(ts, uuid, { title: inputValue }, signal)
  .then(updated => { regression = updated; rerenderTitle(); })
  .catch(err => showError(authErrorMessage(err)));
```

#### State (always-visible dropdown)

Rendered as a `<select class="metric-select">` with options from `ALL_STATES`. On change:
```typescript
updateRegression(ts, uuid, { state: newState as RegressionState }, signal)
  .then(updated => { regression = updated; })
  .catch(err => { select.value = regression.state; showError(authErrorMessage(err)); });
```

No edit/save buttons — the dropdown is always interactive.

#### Bug (inline-editable URL)

Display mode: If bug is set, show `<a href="{bug}" target="_blank" rel="noopener">{truncated_bug}</a>` + `<button class="edit-btn">Edit</button>`. If null, show "(none)" + "Edit" button.

Edit mode: `<input type="url" class="admin-input" placeholder="Bug URL" value="{bug || ''}">` + Save/Cancel buttons.

On save: `updateRegression(ts, uuid, { bug: inputValue || null })` — empty string maps to `null` (clear).

#### Commit (combobox, nullable)

Display mode: If commit is set, show `spaLink(commit, '/commits/...')` + `<button class="edit-btn">Change</button>` + `<button class="edit-btn">Clear</button>`. If null, show "(none)" + "Set" button.

Edit mode: Use `renderCommitSearch` from `components/commit-search.ts` with `onSelect` callback. The `onSelect` callback calls `updateRegression(ts, uuid, { commit: value })`. **Cleanup**: `renderCommitSearch` returns `{ destroy, setSuggestions }` — push `destroy` into `cleanupFns` so it is called on unmount (prevents document-level click listener leaks).

Clear button calls `updateRegression(ts, uuid, { commit: null })`.

#### Notes (expandable textarea)

Always visible as a `<textarea class="regression-notes-input" rows="3">`. Content auto-saved on blur (if changed) with debounce:

```typescript
let savedNotes = regression.notes || '';
textarea.value = savedNotes;

textarea.addEventListener('blur', () => {
  const current = textarea.value;
  if (current !== savedNotes) {
    updateRegression(ts, uuid, { notes: current || null })
      .then(updated => { regression = updated; savedNotes = current; })
      .catch(err => showError(authErrorMessage(err)));
  }
});
```

### 3.4 Indicators Table

Render using `renderDataTable` from `components/data-table.ts`.

Columns:
```typescript
const indicatorColumns: Column<RegressionIndicator>[] = [
  {
    key: 'select',
    label: '',
    sortable: false,
    render: (ind) => {
      const cb = el('input', { type: 'checkbox', 'data-uuid': ind.uuid }) as HTMLInputElement;
      cb.addEventListener('change', () => updateBatchSelection());
      return cb;
    },
  },
  {
    key: 'machine',
    label: 'Machine',
    render: (ind) => spaLink(ind.machine, `/machines/${encodeURIComponent(ind.machine)}`),
  },
  {
    key: 'test',
    label: 'Test',
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
  {
    key: 'remove',
    label: '',
    sortable: false,
    render: (ind) => {
      const btn = el('button', { class: 'row-delete-btn', title: 'Remove indicator' }, '\u00d7');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeSingleIndicator(ind.uuid);
      });
      return btn;
    },
  },
];
```

#### Batch Remove

Above the table, render a "Remove selected" button that is disabled when no checkboxes are checked:

```typescript
const batchRemoveBtn = el('button', {
  class: 'compare-btn',
  disabled: '',
}, 'Remove selected') as HTMLButtonElement;

function updateBatchSelection(): void {
  const checked = tableContainer.querySelectorAll(
    'input[type="checkbox"][data-uuid]:checked');
  batchRemoveBtn.disabled = checked.length === 0;
}

batchRemoveBtn.addEventListener('click', () => {
  const uuids = Array.from(
    tableContainer.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"][data-uuid]:checked'))
    .map(cb => cb.getAttribute('data-uuid')!);
  if (uuids.length === 0) return;
  removeIndicators(uuids);
});
```

#### Single / Batch Remove Implementation

```typescript
async function removeIndicators(uuids: string[]): Promise<void> {
  try {
    const updated = await removeRegressionIndicators(ts, uuid, uuids, signal);
    regression = updated;
    rerenderIndicators();
  } catch (err) {
    showIndicatorError(authErrorMessage(err));
  }
}

function removeSingleIndicator(indicatorUuid: string): void {
  removeIndicators([indicatorUuid]);
}
```

### 3.5 Add Indicators Panel

The panel has three multi-select comboboxes and an "Add" button:

```
<div class="add-indicators-panel">
  <div class="add-indicator-selectors">
    <div class="control-group">
      <label>Metric</label>
      <select class="metric-select">...</select>        ← renderMetricSelector
    </div>
    <div class="control-group">
      <label>Machine</label>
      <div>...</div>                                     ← renderMachineCombobox
    </div>
    <div class="control-group">
      <label>Test</label>
      <input type="text" class="combobox-input"          ← Test name filter input
             placeholder="Search tests...">
      <ul class="test-dropdown">                         ← Filterable test list
    </div>
  </div>
  <div class="add-indicator-preview">
    <span>This will add N indicators</span>
  </div>
  <div class="add-indicator-actions">
    <button class="compare-btn" disabled>Add</button>
  </div>
</div>
```

**Test list filtering**: When both metric and at least one machine are selected, fetch matching tests via `getTests(ts, { machine, metric })` from `api.ts`. Show a dropdown list of matching tests. The user can select/deselect individual tests (checkboxes). Selected tests are tracked in a `Set<string>`.

**Preview**: Compute the Cartesian product of selected machines x selected tests x selected metric(s). Display: "This will add N indicators" where N = |machines| x |tests| x |metrics|. If N = 0, the Add button stays disabled.

**Add button**: On click:
1. Build the indicator array: `Array<{ machine, test, metric }>` from the Cartesian product
2. Call `addRegressionIndicators(ts, uuid, indicators, signal)`
3. On success, update `regression` with the returned detail, re-render indicators table, clear the add panel selections
4. On error, show in `.add-indicators-error`

**Implementation note**: The design calls for multi-select machines and metrics in the add panel. For the initial implementation, simplify to single-select for both (one machine combobox, one metric dropdown). This still generates the full test x 1-machine x 1-metric product. Multi-select can be added as a follow-up enhancement. The test selector allows multi-select from the start (checkbox list).

**Cleanup**: `renderMachineCombobox` returns a handle with `destroy()`. Push it into `cleanupFns` so it is called on unmount (same pattern as the commit search combobox in Section 3.3).

**Auth scope gating**: The entire add-indicators panel and the delete section (Section 3.6) require `triage` scope. Apply the same gating as the list page (Section 2.1): hide mutation controls when no token is set. The state dropdown, edit buttons, and batch-remove button should also be gated.

### 3.6 Delete Regression Section

Use `renderDeleteConfirm` from `components/delete-confirm.ts`, following the pattern from `machine-detail.ts`:

```typescript
renderDeleteConfirm(deleteContainer, {
  label: 'Delete Regression',
  prompt: `Type "${uuid.slice(0, 8)}" to confirm deletion. This will delete the regression and all its indicators.`,
  confirmValue: uuid.slice(0, 8),
  placeholder: 'Regression UUID prefix',
  onDelete: () => deleteRegression(ts, uuid),
  onSuccess: () => navigate('/regressions'),
});
```

### 3.7 Phase 3 Testing

**File**: `lnt/server/ui/v5/frontend/src/__tests__/pages/regression-detail.test.ts` (new file)

Follow the same mock setup pattern as `machine-detail.test.ts`.

Mock API functions:
```typescript
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    getRegression: vi.fn(),
    updateRegression: vi.fn(),
    deleteRegression: vi.fn(),
    addRegressionIndicators: vi.fn(),
    removeRegressionIndicators: vi.fn(),
    getFields: vi.fn(),
    getTests: vi.fn(),
  };
});
```

Mock data:
```typescript
const mockRegression: RegressionDetail = {
  uuid: 'aaaaaaaa-1111-2222-3333-444444444444',
  title: 'Performance drop in sort benchmarks',
  bug: 'https://github.com/llvm/llvm-project/issues/12345',
  notes: 'Investigating root cause.',
  state: 'active',
  commit: 'abc123',
  indicators: [
    { uuid: 'ind-1', machine: 'clang-x86', test: 'sort.bench', metric: 'compile_time' },
    { uuid: 'ind-2', machine: 'clang-arm', test: 'sort.bench', metric: 'compile_time' },
  ],
};
```

**Test cases**:
- Renders page header with truncated UUID
- Calls `getRegression` and `getFields` on mount
- Shows error banner when `getRegression` fails
- Renders title in display mode with current value
- Title edit: clicking "Edit" shows input, "Save" calls `updateRegression` with new title
- Renders state dropdown with correct current selection
- State change calls `updateRegression` with new state
- State reverts to previous on PATCH failure
- Renders bug as external link when set, "(none)" when null
- Bug edit: saving empty string sends `null` to API
- Renders commit as SPA link when set, "(none)" when null
- Commit clear calls `updateRegression` with `commit: null`
- Renders notes textarea with current value
- Notes auto-save on blur when content changed
- Notes not saved on blur when content unchanged
- Indicators table renders columns: Machine, Test, Metric, View on graph, Remove
- "View on graph" link includes correct query parameters
- Remove button on indicator calls `removeRegressionIndicators` with that indicator's UUID
- Batch remove: checking multiple checkboxes enables "Remove selected" button
- Batch remove sends all checked UUIDs to `removeRegressionIndicators`
- Indicators table re-renders after successful remove
- Add indicators panel: metric and machine selection
- Add button disabled when no tests selected
- Add button calls `addRegressionIndicators` with computed indicator list
- Delete regression section renders with correct confirm value
- Successful deletion navigates to `/regressions`
- Unmount aborts without error

---

## Phase 4: Cross-Page Integration

**Goal**: Add regression-related sections to existing pages: Machine Detail (active regressions), Run Detail (matching regressions), Commit Detail (matching regressions), Graph page (regression annotations), and Compare page ("Add to regression" panel).

### 4.1 Machine Detail — Active Regressions Section

**File**: `lnt/server/ui/v5/frontend/src/pages/machine-detail.ts` (extend)

**Goal**: Below the run history table and above the delete section, show a section listing non-resolved regressions that have at least one indicator on this machine.

**Implementation**:

After the `loadRuns()` call and before the `renderDeleteConfirm()` call, add:

```typescript
// Active regressions on this machine
const regressionsContainer = el('div', { class: 'machine-regressions-section' });
container.insertBefore(regressionsContainer, deleteContainer);

loadMachineRegressions(ts, name, regressionsContainer, signal);
```

New helper function (within the module or as a local function):

```typescript
async function loadMachineRegressions(
  ts: string,
  machineName: string,
  container: HTMLElement,
  signal: AbortSignal,
): Promise<void> {
  container.append(el('h3', {}, 'Active Regressions'));

  try {
    const regressions = await getAllRegressions(ts, {
      machine: machineName,
      state: ['detected', 'active'],
    }, signal);

    if (regressions.length === 0) {
      container.append(el('p', { class: 'no-results' },
        'No active regressions on this machine.'));
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
          render: (r: RegressionListItem) => {
            const meta = STATE_META[r.state];
            return el('span', { class: `state-badge ${meta?.cssClass || ''}` },
              meta?.label || r.state);
          },
        },
        {
          key: 'test_count',
          label: 'Tests',
          cellClass: 'col-num',
        },
      ],
      rows: regressions,
      emptyMessage: 'No active regressions.',
    });
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === 'AbortError') return;
    container.append(el('p', { class: 'error-banner' },
      `Failed to load regressions: ${e}`));
  }
}
```

**New imports** added to machine-detail.ts:
```typescript
import { getAllRegressions } from '../api';
import type { RegressionListItem } from '../types';
import { STATE_META } from '../regression-utils';
// Note: `truncate` is already imported in machine-detail.ts — do not add a duplicate import.
// Merge into the existing import statement from '../utils'.
```

### 4.2 Run Detail — Matching Regressions Section

**File**: `lnt/server/ui/v5/frontend/src/pages/run-detail.ts` (extend)

**Goal**: Below the samples table and above the delete section, show regressions where the regression's commit matches the run's commit AND at least one indicator's machine matches the run's machine.

**Implementation**:

After the `run` and `samples` data is loaded, add:

```typescript
const regressionsContainer = el('div', { class: 'run-regressions-section' });
container.insertBefore(regressionsContainer, deleteContainer);

loadRunRegressions(ts, run.commit, run.machine, regressionsContainer, signal);
```

Helper function:

```typescript
async function loadRunRegressions(
  ts: string,
  commit: string,
  machine: string,
  container: HTMLElement,
  signal: AbortSignal,
): Promise<void> {
  container.append(el('h3', {}, 'Regressions'));

  try {
    // Fetch regressions matching this commit AND this machine
    const regressions = await getAllRegressions(ts, {
      commit,
      machine,
    }, signal);

    if (regressions.length === 0) {
      container.append(el('p', { class: 'no-results' },
        'No regressions at this commit and machine.'));
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
          render: (r: RegressionListItem) => {
            const meta = STATE_META[r.state];
            return el('span', { class: `state-badge ${meta?.cssClass || ''}` },
              meta?.label || r.state);
          },
        },
      ],
      rows: regressions,
      emptyMessage: 'No matching regressions.',
    });
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === 'AbortError') return;
    // Non-fatal: log but don't block the page
    container.append(el('p', { class: 'error-banner' },
      `Failed to load regressions: ${e}`));
  }
}
```

**New imports** added to run-detail.ts:
```typescript
import { getAllRegressions } from '../api';
import type { RegressionListItem } from '../types';
import { STATE_META } from '../regression-utils';
import { truncate } from '../utils';
```

### 4.3 Commit Detail — Matching Regressions Section

**File**: `lnt/server/ui/v5/frontend/src/pages/commit-detail.ts` (extend)

**Goal**: Below the runs table, show regressions whose commit matches this commit value.

**Implementation**:

After the runs table is rendered, add:

```typescript
const regressionsContainer = el('div', { class: 'commit-regressions-section' });
container.append(regressionsContainer);

loadCommitRegressions(ts, commitValue, regressionsContainer, signal);
```

Helper function:

```typescript
async function loadCommitRegressions(
  ts: string,
  commit: string,
  container: HTMLElement,
  signal: AbortSignal,
): Promise<void> {
  container.append(el('h3', {}, 'Regressions'));

  try {
    const regressions = await getAllRegressions(ts, { commit }, signal);

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
          render: (r: RegressionListItem) => {
            const meta = STATE_META[r.state];
            return el('span', { class: `state-badge ${meta?.cssClass || ''}` },
              meta?.label || r.state);
          },
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
```

**New imports** added to commit-detail.ts:
```typescript
import { getAllRegressions } from '../api';
import type { RegressionListItem } from '../types';
import { STATE_META } from '../regression-utils';
import { truncate } from '../utils';
```

### 4.4 Graph Page — Regression Annotations

**File**: `lnt/server/ui/v5/frontend/src/pages/graph.ts` (extend)

**Goal**: Add a dropdown to control regression annotation visibility. When enabled, overlay vertical dashed lines on the chart at commits associated with regressions, color-coded by state. Hover shows regression title and affected tests; click navigates to the regression detail page.

**Implementation approach**: This feature integrates with the Plotly chart managed by `createTimeSeriesChart` in `components/time-series-chart.ts`. The cleanest integration path is to add regression annotations as Plotly layout shapes and annotations.

#### 4.4.1 Annotation Dropdown

Add a control to the graph page's control panel (near the existing metric/machine/aggregation controls):

```typescript
const regressionModeSelect = el('select', { class: 'metric-select' }) as HTMLSelectElement;
regressionModeSelect.append(
  el('option', { value: 'off' }, 'Regressions: Off'),
  el('option', { value: 'active' }, 'Regressions: Active'),
  el('option', { value: 'all' }, 'Regressions: All'),
);
```

The dropdown state is stored in a module-scoped variable (e.g., `let regressionMode: 'off' | 'active' | 'all' = 'off'`). On change, fetch regressions and update the chart.

#### 4.4.2 Regression Data Fetching

When the mode changes to 'active' or 'all', fetch regressions for the current suite:

```typescript
async function fetchRegressionAnnotations(
  suite: string,
  mode: 'active' | 'all',
  signal: AbortSignal,
): Promise<RegressionListItem[]> {
  const opts: { state?: RegressionState[] } = {};
  if (mode === 'active') {
    opts.state = ['detected', 'active'];
  }
  return getAllRegressions(suite, opts, signal);
}
```

Cache the results in a module-scoped variable. Re-fetch when mode changes or suite changes. When mode is 'off', clear the cache and remove annotations.

#### 4.4.3 Chart Annotation Rendering

After fetching regressions, compute Plotly shapes and annotations:

```typescript
interface RegressionAnnotation {
  commit: string;
  title: string;
  state: RegressionState;
  uuid: string;
}

function buildRegressionShapes(
  annotations: RegressionAnnotation[],
): { shapes: unknown[]; annotations: unknown[] } {
  const shapes: unknown[] = [];
  const plotlyAnnotations: unknown[] = [];

  for (const ann of annotations) {
    const color = ann.state === 'active' ? '#d62728'     // red
                : ann.state === 'detected' ? '#ff7f0e'   // yellow/orange
                : '#999';                                 // gray (resolved)

    shapes.push({
      type: 'line',
      x0: ann.commit,
      x1: ann.commit,
      y0: 0,
      y1: 1,
      yref: 'paper',
      line: { color, width: 1.5, dash: 'dash' },
    });

    plotlyAnnotations.push({
      x: ann.commit,
      y: 1,
      yref: 'paper',
      text: ann.title || 'Regression',
      showarrow: false,
      font: { size: 10, color },
      yanchor: 'bottom',
      captureevents: true,  // Required for annotation click handling
    });
  }

  return { shapes, annotations: plotlyAnnotations };
}
```

**Integration with `ChartHandle`**: The existing `ChartHandle` interface in `components/time-series-chart.ts` exposes `update()`, `hoverTrace()`, and `destroy()` but no way to apply additional layout properties. Rather than exposing the raw Plotly div (which breaks encapsulation), extend `ChartHandle.update()` to accept an optional `overlays` parameter:

```typescript
interface ChartOverlays {
  shapes?: unknown[];
  annotations?: unknown[];
}

// In time-series-chart.ts, extend the update() signature:
update(traces: unknown[], layout?: Partial<Layout>, overlays?: ChartOverlays): void;
```

The `update()` implementation merges `overlays.shapes` and `overlays.annotations` into the layout before calling `Plotly.react()`. This preserves any pre-existing layout properties (unlike `Plotly.relayout` which overwrites).

Apply to chart:
```typescript
function updateChartAnnotations(regressions: RegressionListItem[]): void {
  if (!chartHandle) return;
  const annotations = regressions
    .filter(r => r.commit !== null)
    .map(r => ({
      commit: r.commit!,
      title: r.title || '(untitled)',
      state: r.state,
      uuid: r.uuid,
    }));
  const { shapes, annotations: plotlyAnnotations } = buildRegressionShapes(annotations);
  chartHandle.update(currentTraces, currentLayout, { shapes, annotations: plotlyAnnotations });
}
```

**X-axis compatibility**: The graph page's x-axis uses commit strings as categorical values (`xaxis.categoryorder = 'array'`, `xaxis.categoryarray = [commit, ...]`). The shape `x0: ann.commit` positions the line at the matching categorical value, which works correctly as long as the regression's commit is present in the chart's commit array. Regressions whose commit is not in the visible range will simply not appear.

#### 4.4.4 Click-to-Navigate

Use Plotly's `plotly_clickannotation` event (fired when annotations have `captureevents: true`) rather than trying to match `plotly_click` x-positions to shape locations:

```typescript
plotDiv.on('plotly_clickannotation', (event: any) => {
  const text = event.annotation?.text;
  if (!text) return;
  // Find matching regression by title
  const match = cachedRegressions.find(r => (r.title || 'Regression') === text);
  if (match) {
    window.location.assign(
      `${urlBase}/v5/${encodeURIComponent(currentSuite)}/regressions/${encodeURIComponent(match.uuid)}`
    );
  }
});
```

**Note**: `plotly_clickannotation` is more reliable than matching `plotly_click` to shape x-positions. However, if multiple regressions share the same title, the match may be ambiguous. To disambiguate, store the regression UUID in the annotation's `customdata` field (if supported by the Plotly version) or encode it in the text as a hidden suffix.

### 4.5 Compare Page — "Add to Regression" Panel

**File**: `lnt/server/ui/v5/frontend/src/pages/compare.ts` (extend)

**Goal**: Add a collapsible "Add to regression" panel below the comparison table. Users can either create a new regression pre-filled from the comparison, or add the comparison's indicators to an existing regression.

**Implementation**:

Add a collapsible section after the comparison results:

```
<details class="add-to-regression-panel">
  <summary>Add to Regression</summary>
  <div class="add-to-regression-content">
    <div class="regression-mode-tabs">
      <button class="tab-btn tab-btn-active">Create New</button>
      <button class="tab-btn">Add to Existing</button>
    </div>
    <div class="tab-content">
      <!-- Create New mode -->
      <div class="create-new-tab">
        <input type="text" class="admin-input" placeholder="Title">
        <p>Pre-filled: commit={commit_b}, machine={machine_a}, {N} tests</p>
        <button class="compare-btn">Create Regression</button>
      </div>
      <!-- Add to Existing mode -->
      <div class="add-existing-tab" style="display:none">
        <div><!-- Regression search combobox --></div>
        <p>Will add {N} indicators to selected regression</p>
        <button class="compare-btn">Add Indicators</button>
      </div>
    </div>
  </div>
</details>
```

#### Create New Mode

Pre-fills from the comparison context:
- **commit**: Side B's commit value (`sideB.commit`)
- **machine**: Side A's machine (or Side B's, whichever is set)
- **metric**: The currently selected metric
- **tests**: All tests shown in the comparison table (or filtered subset)

On "Create Regression":
1. Call `createRegression(ts, { title, commit, state: 'detected', indicators })` where `indicators` is the Cartesian product of [machine] x [visible tests] x [metric]
2. On success, show a success message with a link to the new regression

#### Add to Existing Mode

Regression search combobox: A text input that searches regressions by title. Use a debounced API call to `getRegressions(ts, { ... })` (the API does not support title search, so fetch a page and filter client-side, or simply list recent regressions and let the user scroll).

**Simplified implementation**: Fetch the first page of regressions (e.g., 50 items) and filter client-side by title substring match. This is pragmatic for initial implementation — most LNT instances have a manageable number of active regressions.

On "Add Indicators":
1. Build indicator list from comparison context (same as Create New)
2. Call `addRegressionIndicators(ts, selectedRegressionUuid, indicators)`
3. On success, show confirmation message

**New imports** added to compare.ts:
```typescript
import { createRegression, addRegressionIndicators, getRegressions } from '../api';
import type { RegressionListItem, RegressionDetail } from '../types';
```

**Implementation note**: The Compare page is suite-agnostic (`/v5/compare`), but regression API calls require a testsuite parameter. Use Side A's suite (or Side B's) as the testsuite for the regression API call. Both sides must be from the same suite for the "Add to regression" feature to work. If suites differ, the panel should show a message: "Regressions can only be created within a single test suite." and disable the controls. If neither side has a suite selected yet, hide the panel entirely.

### 4.6 Phase 4 Testing

**File**: `lnt/server/ui/v5/frontend/src/__tests__/pages/machine-detail.test.ts` (extend)

Add tests:
- Renders "Active Regressions" section after run history
- Shows "No active regressions" when API returns empty list
- Renders regression links as SPA links to detail page
- Shows state badges with correct CSS classes
- Regression section handles API errors gracefully (shows error banner, rest of page unaffected)
- Unmount aborts regression fetch

**File**: `lnt/server/ui/v5/frontend/src/__tests__/pages/run-detail.test.ts` (extend)

Add tests:
- Renders "Regressions" section below samples
- Shows "No regressions at this commit and machine." when empty
- Renders regression links
- API called with correct commit and machine params

**File**: `lnt/server/ui/v5/frontend/src/__tests__/pages/commit-detail.test.ts` (extend)

Add tests:
- Renders "Regressions" section below runs table
- Shows "No regressions at this commit." when empty
- Renders regression links with state and counts
- API called with correct commit param

**File**: `lnt/server/ui/v5/frontend/src/__tests__/pages/graph.test.ts` (extend)

Add tests:
- Regression mode dropdown renders with Off/Active/All options
- Default mode is "Off" — no regression API calls on mount
- Changing to "Active" triggers `getAllRegressions` with `state: ['detected', 'active']`
- Changing to "All" triggers `getAllRegressions` without state filter
- Changing back to "Off" clears annotations
- `buildRegressionShapes` returns correct Plotly shapes for each state color

**File**: `lnt/server/ui/v5/frontend/src/__tests__/pages/compare.test.ts` (extend)

Add tests:
- "Add to Regression" panel renders as collapsed `<details>` element
- Create New tab is shown by default
- Create New calls `createRegression` with pre-filled commit, machine, and indicators
- Add to Existing tab switches visibility on tab click
- Add to Existing calls `addRegressionIndicators` with selected regression UUID
- Panel disabled/hidden when suites differ between sides
- Error messages displayed on API failure

---

## Phase 5: Styles & Testing

**Goal**: Add CSS for all regression UI elements and ensure comprehensive test coverage.

**Interleaving note**: While the CSS is collected here in one section for reference, in practice the CSS classes should be added to `style.css` incrementally as each phase is implemented. State badge styles are needed in Phase 2 (list page), header/notes/indicator styles in Phase 3 (detail page), and cross-page section styles in Phase 4. Add each group of styles when implementing the phase that uses them so the UI is visually testable throughout development.

### 5.1 CSS Additions

**File**: `lnt/server/ui/v5/frontend/src/style.css` (append)

```css
/* ============================================================
   Regression Pages
   ============================================================ */

/* State badges — used on regression list and detail pages */
.state-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 12px;
  font-weight: 600;
  text-transform: capitalize;
}

.state-detected {
  background: #fff3cd;
  color: #856404;
}

.state-active {
  background: #f8d7da;
  color: #721c24;
}

.state-not-to-be-fixed {
  background: #e2e3e5;
  color: #383d41;
}

.state-fixed {
  background: #d4edda;
  color: #155724;
}

.state-false-positive {
  background: #d1ecf1;
  color: #0c5460;
}

/* State filter chips — regression list page */
.state-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.state-chip {
  padding: 4px 12px;
  border: 1px solid #ccc;
  border-radius: 16px;
  background: #fff;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  transition: background 0.15s, border-color 0.15s;
}

.state-chip:hover {
  background: #f0f0f0;
}

.state-chip-active {
  border-color: #0d6efd;
  background: #e7f1ff;
  color: #0d6efd;
}

/* Regression filter panel */
.regression-filters {
  margin-bottom: 15px;
  padding: 12px;
  border: 1px solid #dee2e6;
  border-radius: 4px;
  background: #f8f9fa;
}

.filter-row {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.filter-row:last-child {
  margin-bottom: 0;
}

.title-search-input {
  flex: 1;
  min-width: 200px;
}

/* Regression actions bar */
.regression-actions {
  margin-bottom: 12px;
}

/* Create form */
.create-form-container {
  margin-bottom: 15px;
  padding: 12px;
  border: 1px solid #dee2e6;
  border-radius: 4px;
  background: #fff;
}

.create-form-container .admin-input {
  width: 100%;
  margin-bottom: 8px;
}

.create-form-error {
  margin-top: 8px;
}

/* Row delete button (inline in table row) */
.row-delete-btn {
  background: none;
  border: none;
  color: #999;
  cursor: pointer;
  font-size: 16px;
  padding: 2px 6px;
  border-radius: 3px;
  line-height: 1;
}

.row-delete-btn:hover {
  color: #d62728;
  background: #fff5f5;
}

/* Regression detail — header fields */
.regression-header {
  margin-bottom: 20px;
}

.field-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 13px;
}

.field-row label {
  font-weight: 600;
  color: #666;
  min-width: 70px;
}

.editable-value {
  font-size: 14px;
}

.edit-btn {
  background: none;
  border: 1px solid #ccc;
  border-radius: 3px;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 12px;
  color: #666;
}

.edit-btn:hover {
  background: #f0f0f0;
  color: #333;
}

/* Notes textarea */
.regression-notes-input {
  width: 100%;
  min-height: 60px;
  padding: 6px 8px;
  border: 1px solid #ccc;
  border-radius: 3px;
  font-family: inherit;
  font-size: 13px;
  resize: vertical;
}

/* Indicator actions (batch remove) */
.indicator-actions {
  margin-bottom: 8px;
}

/* Add indicators panel */
.add-indicators-panel {
  margin-top: 15px;
  padding: 12px;
  border: 1px solid #dee2e6;
  border-radius: 4px;
  background: #f8f9fa;
}

.add-indicator-selectors {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.add-indicator-selectors .control-group {
  min-width: 180px;
}

.add-indicator-preview {
  margin-bottom: 8px;
  font-size: 13px;
  color: #666;
}

.add-indicator-actions {
  margin-top: 8px;
}

/* Cross-page regression sections */
.machine-regressions-section,
.run-regressions-section,
.commit-regressions-section {
  margin-top: 20px;
  margin-bottom: 20px;
}

/* Compare page — Add to Regression panel */
.add-to-regression-panel {
  margin-top: 20px;
  border: 1px solid #dee2e6;
  border-radius: 4px;
}

.add-to-regression-panel > summary {
  padding: 10px 12px;
  cursor: pointer;
  font-weight: 600;
  font-size: 14px;
  background: #f8f9fa;
  border-radius: 4px;
}

.add-to-regression-panel[open] > summary {
  border-bottom: 1px solid #dee2e6;
  border-radius: 4px 4px 0 0;
}

.add-to-regression-content {
  padding: 12px;
}

.regression-mode-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
}

.tab-btn {
  padding: 4px 12px;
  border: 1px solid #ccc;
  border-radius: 3px;
  background: #fff;
  cursor: pointer;
  font-size: 13px;
}

.tab-btn:hover {
  background: #f0f0f0;
}

.tab-btn-active {
  background: #0d6efd;
  color: #fff;
  border-color: #0d6efd;
}
```

### 5.2 Test Coverage Summary

All tests use Vitest with jsdom environment. The test files and their primary coverage areas:

| Test File | Covers |
|-----------|--------|
| `__tests__/api.test.ts` (extend) | All 7 regression API functions: URL construction, HTTP method, params, body, response parsing |
| `__tests__/pages/regression-list.test.ts` (new) | Full regression list page: rendering, filters, table, pagination, create form, delete |
| `__tests__/pages/regression-detail.test.ts` (new) | Full regression detail page: header edits, indicators table, batch remove, add panel, delete |
| `__tests__/pages/machine-detail.test.ts` (extend) | Active regressions section on machine detail |
| `__tests__/pages/run-detail.test.ts` (extend) | Matching regressions section on run detail |
| `__tests__/pages/commit-detail.test.ts` (extend) | Matching regressions section on commit detail |
| `__tests__/pages/graph.test.ts` (extend) | Regression annotation mode dropdown, shape building |
| `__tests__/pages/compare.test.ts` (extend) | "Add to regression" panel, create/add-to-existing modes |

### 5.3 Test Execution

Run all tests:
```bash
cd lnt/server/ui/v5/frontend && npx vitest run
```

Run only regression-related tests:
```bash
cd lnt/server/ui/v5/frontend && npx vitest run --reporter=verbose regression
```

### 5.4 Manual Verification Checklist

1. **Regression List** (`/v5/{ts}/regressions`):
   - Page loads with all regressions shown
   - State filter chips toggle correctly; table reloads on chip toggle
   - Machine/test/metric filters narrow results
   - Title search filters visible rows
   - Pagination Previous/Next work
   - "New Regression" button shows/hides create form
   - Create form submits and navigates to detail page
   - Per-row delete button shows confirmation, deletes on confirm
   - Row click navigates to detail page

2. **Regression Detail** (`/v5/{ts}/regressions/{uuid}`):
   - Title displays and edits inline
   - State dropdown changes immediately save
   - Bug displays as link, edits inline
   - Commit displays as link, can change or clear
   - Notes textarea auto-saves on blur
   - Indicators table shows all indicators
   - "View on graph" opens graph page with correct params
   - Single indicator remove works
   - Batch checkbox select + "Remove selected" works
   - Add indicators panel: select metric, machine, then tests; preview shows count; "Add" button works
   - Delete regression navigates back to list

3. **Machine Detail**: "Active Regressions" section appears below run history with linked entries

4. **Run Detail**: "Regressions" section appears matching run's commit and machine

5. **Commit Detail**: "Regressions" section appears matching commit value

6. **Graph page**: Regression dropdown Off/Active/All; annotations appear as dashed vertical lines, color-coded by state

7. **Compare page**: "Add to Regression" collapsible; Create New pre-fills from comparison; Add to Existing searches and adds indicators

---

## File Change Summary

### New Files
| File | Phase | Description |
|------|-------|-------------|
| `src/regression-utils.ts` | 1 | Shared state constants and helpers |
| `src/__tests__/pages/regression-list.test.ts` | 2 | Regression list page tests |
| `src/__tests__/pages/regression-detail.test.ts` | 3 | Regression detail page tests |

All paths relative to `lnt/server/ui/v5/frontend/`.

### Modified Files
| File | Phase | Changes |
|------|-------|---------|
| `src/types.ts` | 1 | Add `RegressionState`, `RegressionIndicator`, `RegressionListItem`, `RegressionDetail` |
| `src/api.ts` | 1 | Add 7 regression API functions + `RegressionListParams` interface |
| `src/__tests__/api.test.ts` | 1 | Add tests for regression API functions |
| `src/pages/regression-list.ts` | 2 | Replace stub with full implementation |
| `src/pages/regression-detail.ts` | 3 | Replace stub with full implementation |
| `src/pages/machine-detail.ts` | 4 | Add active regressions section |
| `src/pages/run-detail.ts` | 4 | Add matching regressions section |
| `src/pages/commit-detail.ts` | 4 | Add matching regressions section |
| `src/pages/graph.ts` | 4 | Add regression annotation dropdown and chart overlays |
| `src/components/time-series-chart.ts` | 4 | Add `getPlotDiv()` to `ChartHandle` |
| `src/pages/compare.ts` | 4 | Add "Add to regression" collapsible panel |
| `src/__tests__/pages/machine-detail.test.ts` | 4 | Add regression section tests |
| `src/__tests__/pages/run-detail.test.ts` | 4 | Add regression section tests |
| `src/__tests__/pages/commit-detail.test.ts` | 4 | Add regression section tests |
| `src/__tests__/pages/graph.test.ts` | 4 | Add annotation tests |
| `src/__tests__/pages/compare.test.ts` | 4 | Add "Add to regression" tests |
| `src/style.css` | 5 | Add all regression CSS classes |

### Unchanged Files
- `src/router.ts` — routes already registered
- `src/main.ts` — imports already present
- `src/utils.ts` — no new utilities needed
- `src/combobox.ts` — reused as-is
- All existing components — reused as-is
