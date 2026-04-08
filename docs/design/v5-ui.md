# v5 Web UI Redesign — High-Level Plan

## Context

LNT's current web UI is built on v4 Flask/Jinja2 server-rendered pages with jQuery 1.7 and Bootstrap 2. It works but feels dated. The v5 REST API is now complete and a single v5 page already exists (the Compare SPA). This plan designs a complete new UI built exclusively on the v5 API.

The v4 UI stays around as-is. The only integration point is a toggle link in each UI's navbar to switch between v4 and v5.

## Architecture: Single-Page Application

**One SPA with client-side routing**, extending the pattern proven by the existing Compare page.

- **Framework**: Vanilla TypeScript (no React/Vue) — matches the existing Compare SPA
- **Build**: Vite, single IIFE bundle (`v5.js` + `v5.css`)
- **Charts**: Plotly.js (loaded from CDN)
- **Routing**: Simple path-based client-side router using History API. All internal links set their `href` to the real URL and intercept plain clicks for SPA navigation (no full page reload). Modified clicks (Cmd+Click, Ctrl+Click, Shift+Click, middle-click) bypass the SPA router and let the browser handle them natively (e.g. open in a new tab).
- **State**: URL query params for shareable deep-links; localStorage for auth token

**Design consistency**: All pages should share a consistent look and feel, using the v5 Compare page as the reference for UI patterns — comboboxes, metric selectors, table styling, progress/error feedback, color scheme, and layout spacing. Reuse the same components across pages rather than reinventing per-page. Pages with selection controls (dropdowns, filters, aggregation settings) wrap them in a shared controls panel — a lightly shaded box with a border — so the settings area is visually distinct from the page content.

**Authentication**: The v5 API allows unauthenticated reads by default (configurable via `require_auth_for_reads` in `lnt.cfg`). All pages in the current scope are read-only, so no authentication is needed. The SPA navigation bar includes a Settings panel with a Bearer token input (stored in localStorage) for the Admin page and future write-capable pages (regression triage, etc.).

**Why SPA over server-rendered pages:**
- Avoids full-page reloads (and re-downloading Plotly) when navigating
- Shared state (auth token, test suite context) lives naturally in the app
- The Compare page already proves vanilla TS + Vite works well
- All data comes from the v5 REST API — no server-side rendering needed

### Flask Backend: Suite-Agnostic and Suite-Scoped Routes

The v5 API only supports the default DB, so v5 frontend routes do not include `db_<db_name>` prefixes.

Suite-agnostic pages (dashboard, test suites, admin, graph, compare) are served at top-level `/v5/` routes with `data-testsuite=""`, while suite-scoped pages use the catch-all route which passes the test suite name as `data-testsuite`.

```python
# lnt/server/ui/v5/views.py
@v5_frontend.route("/v5/", strict_slashes=False)
@v5_frontend.route("/v5/test-suites", strict_slashes=False)
@v5_frontend.route("/v5/admin", strict_slashes=False)
@v5_frontend.route("/v5/graph", strict_slashes=False)
@v5_frontend.route("/v5/compare", strict_slashes=False)
def v5_global():
    ...renders v5_app.html shell with empty testsuite...

@v5_frontend.route("/v5/<testsuite_name>/")
@v5_frontend.route("/v5/<testsuite_name>/<path:subpath>")
def v5_app(testsuite_name, subpath=None):
    ...renders v5_app.html shell for suite-scoped pages...
```

The existing Compare page route (`v5_compare`) also needs to be updated to remove its `db_<db_name>` variant.

The shell template (`v5_app.html`) is a standalone HTML page (it does NOT extend `layout.html`) and mounts `<div id="v5-app">` with the SPA bundle. This avoids inheriting v4 CSS/JS (Bootstrap 2, jQuery, DataTables) and layout artifacts (fixed-navbar margins, sticky footer).

### v4/v5 Toggle

- In the v4 navbar (`layout.html`): add a "v5 UI" link in the top-right of the nav bar (next to the "System" dropdown, not inside any dropdown menu) pointing to `/v5/{ts}/`
- In the v5 SPA navbar: a "v4 UI" link pointing to the v4 root page (`/`)

---

## Page Hierarchy

```
/v5/                                   Dashboard (landing page — suite-agnostic placeholder)
/v5/test-suites?suite={ts}&tab=...     Test Suites (suite picker + browsing tabs)
/v5/{ts}/                              Suite root (redirects to /v5/test-suites?suite={ts})
/v5/{ts}/machines/{name}               Machine Detail
/v5/{ts}/runs/{uuid}                   Run Detail
/v5/{ts}/orders/{value}                Order Detail
/v5/{ts}/regressions?state=...         Regression List
/v5/{ts}/regressions/{uuid}            Regression Detail
/v5/{ts}/field-changes                 Field Change Triage
/v5/graph?suite={ts}&machine=...       Graph (time series) — suite-agnostic
/v5/compare?suite_a={ts}&...           Compare — suite-agnostic
/v5/admin                              Admin (API keys, schemas — not test-suite specific)
```

### Navigation Bar

```
[LNT] [Test Suites] [Graph] [Compare] [API]  <------------>  [v4 UI] [Admin] [Settings]
```

All navbar links are suite-agnostic. The navbar behavior depends on the page context:

- **Suite-agnostic context** (`/v5/...` without a suite): All navbar links use SPA navigation. API opens in a new tab. v4 UI is external.
- **Suite-scoped context** (`/v5/{ts}/...`): All navbar links use full-page navigation (since they target `/v5/...` which is outside the suite basePath `/v5/{ts}`).

Graph and Compare links append `?suite={ts}` / `?suite_a={ts}` when navigated from suite-scoped context, pre-filling the current suite. The Test Suites link appends `?suite={ts}` to preserve the suite context.

---

## Page Details

### 1. Dashboard — `/v5/`

Suite-agnostic landing page. Currently a placeholder — content to be designed later.

### 2. Test Suites — `/v5/test-suites?suite={ts}&tab=...`

The primary entry point for browsing test suite data. Suite-agnostic page with an internal suite picker and tabbed content.

**Suite picker**: A row of prominent card/button elements, one per test suite (from `data-testsuites`). Clicking a card selects it (highlighted) and shows the tab bar below. When no suite is selected, only the suite picker is visible.

**Tabs**: [Recent Activity] [Machines] [Runs] [Orders]. Default tab is Recent Activity.

**URL state**: `?suite={ts}&tab=machines&search=foo&offset=0` — all state is in query params. On mount, reads params to restore state. On changes, updates URL via `replaceState`.

| Tab | Content | API | Search/Filter |
|-----|---------|-----|---------------|
| Recent Activity | Last 25 runs sorted by time; "Load more" for next page | `GET runs?sort=-start_time&limit=25` | None |
| Machines | Searchable machine list with offset pagination | `GET machines?name_contains=...&limit=25&offset=...` | Name substring |
| Runs | Run list with cursor pagination | `GET runs?machine=...&sort=-start_time&limit=25` | Machine name (exact) |
| Orders | Order list with cursor pagination | `GET orders?tag_prefix=...&limit=25` | Tag prefix |

**Columns per tab:**
- **Recent Activity**: Machine, Order (primary value), Start Time, UUID (truncated, linked)
- **Machines**: Name (linked), Info (key-value summary)
- **Runs**: UUID (truncated, linked), Machine, Order (primary value), Start Time
- **Orders**: Order Value (primary field, linked), Tag

**Detail navigation**: Clicking an item navigates to the full suite-scoped detail page (e.g., `/v5/{ts}/machines/{name}`) via full page navigation. This crosses from suite-agnostic context to suite-scoped context.

**Suite root redirect**: `/v5/{ts}/` redirects to `/v5/test-suites?suite={ts}`.

**Links out**: Machine Detail, Run Detail, Order Detail.

### 3. Machine Detail — `/v5/{ts}/machines/{name}`

Deep dive into a single machine. Machine names are guaranteed unique.

| Section | Shows | API Calls |
|---------|-------|-----------|
| Metadata | Machine info key-value pairs | `GET machines/{name}` |
| Run History | Paginated table of runs (newest first) | `GET machines/{name}/runs?sort=-start_time` |
| Delete | Delete button with confirmation prompt | `DELETE machines/{name}` (requires `manage` scope) |

The delete section appears at the bottom. Clicking "Delete Machine" shows a confirmation prompt requiring the user to type the machine name. Deletion requires a valid API token with `manage` scope (set via the Settings panel in the nav bar). On success, navigates to the machine list. On auth failure (401/403), shows an error message reminding the user to set an API token with sufficient permissions. While the delete is in progress, a message reassures the user that deletion may take a while for machines with many runs.

**Links out**: Run Detail, Order Detail, Graph (with machine pre-filled), Compare (with machine pre-selected).

### 4. Run Detail — `/v5/{ts}/runs/{uuid}`

All data from a single test execution.

| Section | Shows | API Calls |
|---------|-------|-----------|
| Metadata | Machine, order, start/end time, parameters | `GET runs/{uuid}` |
| Metric Selector | Drop-down to choose which metric to display (like Compare page) | `GET test-suites/{ts}` (fields from `schema.metrics`) |
| Test Filter | Text input for substring matching on test names | (client-side) |
| Samples Table | All samples + selected metric value, sorted by test name by default | `GET runs/{uuid}/samples` |
| Delete | Delete button with confirmation prompt | `DELETE runs/{uuid}` (requires `manage` scope) |

The metric selector drop-down controls which metric column is shown in the samples table, consistent with how the Compare page handles metric selection.

Samples are loaded progressively — the table renders immediately with the first page and grows as more pages arrive, with a progress indicator showing the count. Multiple samples for the same test (repetitions) appear as separate rows.

A "Compare with..." button navigates to the Compare page with this run's machine and order pre-selected on side A, leaving side B open for the user to fill in.

The delete section appears at the bottom. Clicking "Delete Run" shows a confirmation prompt requiring the user to type the first 8 characters of the run UUID. Deletion requires a valid API token with `manage` scope. On success, navigates to the machine detail page.

**Links out**: Machine Detail, Order Detail, Graph (test pre-filled), Profile, Compare (side A pre-selected).

### 5. Order Detail — `/v5/{ts}/orders/{value}`

The "what happened at this commit?" page. Key investigation page for developers.

- Order field values displayed prominently
- **Tag display + editing**: Show the order's tag (if set) prominently next to the order field values (e.g., "Tag: release-18.1"). An inline edit button allows setting or clearing the tag. Editing requires an API token with `manage` scope (from Settings); show an auth error if the token is missing or insufficient.
- **Navigation**: Prev/Next buttons (using the API's `previous_order`/`next_order` from the order detail response)
- **Summary**: N runs across M machines
- **Machine filter**: Text input for substring matching on machine names, filters the runs table. The summary updates to reflect filtered counts (e.g., "5 of 12 runs across 2 of 8 machines").
- **Runs table**: Columns: machine (link to Machine Detail), run UUID (link to Run Detail), start time
- API: `GET orders/{value}`, `PATCH orders/{value}` (tag editing), `GET runs?order={value}`
- **Links out**: Run Detail, Machine Detail

### 6. Graph (Time Series) — `/v5/graph?suite={ts}&machine={m}&metric={f}`

The primary performance-over-time visualization. Replaces v4's graph page. This page is suite-agnostic — the suite is a query parameter, not a path segment.

- **Suite selector**: A required dropdown at the top of the page, populated from the `data-testsuites` HTML attribute. All other controls (machine, metric, test filter, aggregation, baselines) are disabled until a suite is selected. Changing the suite clears the machine list, all caches, and the chart. When the page is loaded with `suite=` in the URL, the dropdown is pre-selected.

- **Machine chip input**: The machine selector is a chip-based multi-select input. The user types a machine name (with typeahead suggestions) and presses Enter to add it. Each added machine appears as a chip with an × button to remove it. Multiple machines can be added to overlay their data on the same chart. Removing the last machine clears the chart. The metric selector is shared across all machines — the same metric is plotted for every machine. The full machine list is fetched once when the combobox is created and filtered locally by case-insensitive substring as the user types (instant, no per-keystroke API calls). A "Loading machines..." hint is shown until the initial fetch completes.
- **Input validation**: Machine and order comboboxes show a red halo (`.combobox-invalid` — red border + box-shadow) whenever the suggestion dropdown is empty, meaning no machine or order matches the typed text. Acceptance (Enter key, blur/change) is blocked while the halo is showing. The halo updates in real-time on every keystroke. Clicking a dropdown suggestion always clears the halo and accepts the value. For order comboboxes, acceptance via Enter or blur additionally requires an exact match against available order values — a partial substring match (e.g. typing "789" when the order is "566789") is rejected with the red halo even though suggestions are visible. All comboboxes support ArrowDown/ArrowUp keyboard navigation through suggestions, with Enter to select the focused item.
- **Auto-plot**: No "Plot" button. The chart loads automatically as soon as at least one machine and a metric are selected. The metric selector initially shows a "-- Select metric --" placeholder (no metric pre-selected), consistent with the Compare page. Adding or removing a machine triggers data fetching (or cache hit) and re-renders the chart immediately.
- **Multi-machine trace naming and symbols**: Each trace is named `{test name} - {machine name}` (test name first for natural sorting). Machines are visually distinguished by marker symbols: the first machine uses circles (default), the second triangles, then squares, diamonds, etc. Colors continue to represent test identity (assigned by alphabetical index of all test names across all machines), so the same test on different machines shares the same color but has a different marker shape.
- **Test filter**: A text filter (like the Compare page) that controls which tests are plotted. The filter matches on **test name only** (not machine name), showing/hiding the test across all machines simultaneously. Each matching test×machine combination becomes a separate trace on the chart.
- **X-axis is always order** (not date — orders are not necessarily correlated to dates)
- Plotly line chart: metric value vs order, one trace per matching test
- **Aggregation controls** (consistent with Compare page):
  - Run aggregation: how to combine multiple runs at the same order (median/mean/min/max)
  - Sample aggregation: how to combine multiple samples within a run (median/mean/min/max)
- **Lazy loading with progressive rendering**: Data is fetched newest-first (`sort=-order&limit=10000`) and rendered incrementally. The chart first appears with the full x-axis scaffold (if available) and then progressively fills in data as pages arrive via cursor-based pagination (`fetchOneCursorPage`). This avoids blocking the UI on large datasets.
- **X-axis scaffolding**: To prevent the x-axis from resizing/shifting as lazy-loaded pages arrive, the graph page pre-fetches the complete list of order values for each selected machine via paginated calls to the `GET machines/{name}/runs` endpoint (using `fetchOneCursorPage` with `sort=order`). When multiple machines are selected, the scaffold is the **union** of all machines' order values, so the x-axis spans the full range across all machines. Traces naturally have gaps where their machine has no data at a given order. Each machine's scaffold is fetched and cached independently; the union is recomputed when machines are added or removed. If a scaffold fetch fails for one machine, that machine's orders are simply not included in the union — the chart still works.
- **Client-side caching**: Test names, data points, scaffolds, and baseline data are cached locally. Test names are fetched once per machine/metric combination (all names, no server-side filter) and filtered client-side. Changing the test filter, aggregation mode, or baselines re-renders instantly from cache without any additional API calls. Adding a second machine starts its own fetch pipeline while the first machine's data is already displayed. The cache is preserved across page unmount/remount, so navigating away and pressing browser back renders instantly. All caches are cleared on suite change.
- **Interactive controls**: All settings — metric, test filter, aggregation mode, baselines — are interactive from cache. Changing any of them re-renders without an API refetch. All settings sync to the URL for shareability. The legend table updates synchronously (instant feedback while typing). Chart updates are deferred via `requestAnimationFrame` to keep the UI responsive; a generation counter ensures only the latest update paints.
- **Incremental chart updates**: The chart component exposes a `ChartHandle` API (via `createTimeSeriesChart`) that supports incremental updates through `Plotly.react()` — the chart is updated in-place as new pages of data arrive, rather than being destroyed and re-created.
- **Zoom preservation during progressive loading**: If the user zooms into the chart while data is still loading, the zoom is preserved across incremental updates. The x-axis range is always preserved (it was established by the scaffold or by user zoom). The y-axis range is preserved only when the user has explicitly zoomed; otherwise, it auto-ranges to accommodate new data as it arrives. Double-clicking the chart resets the zoom to the full range as usual.
- **Legend table**: Below the chart, a table lists traces sorted alphabetically by name (not in a scrollable container — the table is part of the page flow, like the Compare page's table). A message line above the table rows always shows a matching count (e.g., "42 of 150 tests matching"); when the 20-cap is active, the cap warning replaces it. Each row represents one trace (`{test name} - {machine name}`), with a colored marker symbol character (●, ▲, ■, etc. in the trace's color) identifying both the test (by color) and the machine (by shape). The test filter matches on test name only — matching test names show all their machine variants; non-matching names are hidden entirely. Tests that are inactive (manually hidden or beyond the 20-cap) are grayed out in place. Clicking a row toggles the test's visibility on the chart. Double-clicking a row is a shortcut for hiding all other visible tests (equivalent to single-clicking every other test one by one) — it populates `manuallyHidden` with all visible tests except the double-clicked one. Double-clicking the same test again when it is the only visible test restores all tests. Subsequent single-clicks work naturally against the `manuallyHidden` set. Plotly's built-in legend is disabled; the table replaces it. Bidirectional hover highlighting: hovering a table row highlights the corresponding chart trace by emphasizing the entire trace line (thicker line, full opacity) while dimming all other traces via `Plotly.restyle()`; hovering a chart trace highlights the table row.
- **Active state and 20-cap**: A trace is active (plotted) when its test name matches the text filter and it has not been manually hidden by clicking its row. A default 20-test cap auto-activates the first 20 alphabetical trace names when there is no text filter and no manual toggles. As soon as the user types a filter or manually toggles any row, the cap is permanently disabled for the rest of the page session. Colors are assigned by alphabetical index of all **test names** (not trace names) using a fixed palette, ensuring the same test on different machines shares the same color.
- **Baselines**: Users can overlay one or more baselines as horizontal dashed lines on the chart. Each baseline is a (suite, machine, order) tuple, allowing cross-suite comparisons. The selector is an expandable panel with cascading dropdowns: Suite (populated from `data-testsuites`) → Machine (populated from the selected suite's machines endpoint) → Order (populated from the selected machine's orders). Added baselines appear as removable chips labeled `{suite}/{machine}/{order} ({tag})`. Baseline data is fetched from the baseline's suite via `POST /api/v5/{suite}/query` with `{machine, metric, order, test}` in the JSON body. Each baseline renders as a horizontal dashed line per test trace, spanning the full chart width, in a distinct color per baseline. The baseline's Y value for each test is computed using the same run aggregation function as the main trace (e.g., median of all runs at that order), so the dashed line aligns exactly with the trace point at that order. Hovering a dashed line shows a tooltip with: the baseline suite, machine, order value, tag (if set), test name, and metric value. Baselines are encoded in the URL query string for shareability (e.g., `&baseline=nts::machine1::abc123&baseline=other_suite::machine2::def456`). Baseline data is fetched asynchronously after the first render, so it does not block initial chart display.
- **Concurrent background fetches**: Each machine×metric fetch uses its own AbortController, so navigating away or removing a machine cancels its in-flight requests cleanly without affecting other machines' fetches.
- **Hover** a data point: tooltip showing test name, machine name, order value, aggregated metric value, run count. Hover distance is reduced (`hoverdistance: 5`, less sticky tooltips) so the tooltip only appears when the cursor is close to a data point. When hovering over an aggregated point that represents multiple runs, the individual pre-aggregation values are shown as a scatter of markers at the same x-position, in the same trace color but faded (opacity 0.3). This scatter is computed lazily via a callback and displayed as a temporary Plotly trace that is added on hover and removed on unhover.
- **"No data to plot" annotation**: When no traces match the current filter/settings, the chart displays a Plotly annotation overlay ("No data to plot") centered on the chart area, preserving the x-axis scaffold so the user can see the order range.
- API: `POST query` with JSON body `{machine, metric, test, sort, limit, cursor}` (one fetch pipeline per machine, targeted to discovered tests via multi-value `test`), `GET tests?machine=...&metric=...&name_contains=...` (test name discovery), `GET machines/{name}/runs?sort=order` (x-axis scaffold, per machine), `GET orders` (tags for baseline suggestions), `GET machines` (machine combobox), `GET test-suites/{ts}` (fields/metrics)
- **URL state**: `?suite={ts}&machine={name}&machine={name2}&metric={name}&test_filter={text}&run_agg={fn}&sample_agg={fn}&baseline={suite}::{machine}::{order}&baseline={suite2}::{machine2}::{order2}` — the `machine` parameter is repeated for each selected machine; the `baseline` parameter is repeated for each baseline.
- **Links out**: Compare

### 7. Compare — `/v5/compare?suite_a={ts}&...`

Side-by-side comparison of two orders (or runs). The existing code in `comparison.ts`, `selection.ts`, `table.ts`, `chart.ts` becomes a page module. The SPA router delegates to it. This page is suite-agnostic — each side can independently select its suite.

#### Selection Panel

Each side (A and B) has independent controls:
- **Suite**: dropdown selector populated from `data-testsuites`. Changing the suite clears the machine, order, and runs for that side and re-populates the machine combobox from the new suite's machines endpoint. Clearing the suite also clears cached fields and orders for that side so stale metrics don't linger.
- **Order**: combobox (searchable dropdown) over order values (primary order field only; multi-field orders use only the primary field). Displays tags alongside values (e.g., "abc123 (release-18)") and filters suggestions to only show orders where the selected machine has runs. The text filter matches against both the order value and the tag. When a machine is pre-selected from URL state, its orders are fetched on creation so the dropdown is correctly filtered from the start. **Disabled until a machine is selected** — shows "Select a machine first" placeholder. Re-disabled if the machine is cleared. Clearing the order also clears the runs for that side.
- **Machine**: combobox over machine names. The full machine list for the selected suite is fetched once and filtered locally by case-insensitive substring as the user types (instant, no per-keystroke API calls). **Disabled until a suite is selected** — shows "Select a suite first" placeholder. Clearing the machine text and blurring resets downstream state (order, runs) and disables the order input.
- **Runs**: checkbox list of runs for the selected order+machine, populated by `GET /api/v5/{ts}/runs?machine=M&order=O`. Empty list shown when no runs exist. All runs are selected by default. The only exception is URL state restoration: if the shared URL specifies a subset of runs, that selection is restored. Each run shows its timestamp and a short UUID linking to the Run Detail page. Before an order is selected, a hint message ("Select an order first") is shown instead.
- **Run aggregation**: strategy for aggregating across selected runs (median/mean/min/max); grayed out when only one run selected

A **Swap sides** button (circular, showing ⇄) sits between the two sides. Clicking it exchanges all of side A's state (order, machine, runs, run aggregation) with side B's, updates the URL, re-renders the selection panel, and triggers auto-compare. This is useful for quickly reversing the baseline/new direction.

Global controls (shared across both sides):
- **Metric**: single-select dropdown; one metric at a time, applies to both table and chart. Shows the **union** of metrics from both sides' suites. Only metrics with `type === 'Real'` are shown (filtered client-side). Before any suite is selected, the metric area shows a "Select a suite to load metrics..." hint instead of an empty dropdown.
- **Sample aggregation**: strategy for aggregating multiple samples within a single run (default: median). When a test appears multiple times in a run's samples, this strategy produces a single value per test per run.
- **Noise threshold**: numeric input defining the minimum |Delta %| to consider significant (default: 1%)
- **Test filter**: text input for substring matching on test names, applied to both table and chart
- **Hide noise**: checkbox that hides noise-status rows from the table and chart

There is no Compare button. The comparison triggers automatically whenever the state becomes valid (both sides have runs and a metric is selected), like the Graph page's auto-plot. Changing the machine, order, metric, or aggregation settings re-triggers the comparison. Previous in-flight fetches are aborted.

#### Comparison Table

| Column   | Description                                              |
|----------|----------------------------------------------------------|
| Test     | Test name                                                |
| Value A  | Aggregated metric value from side A                      |
| Value B  | Aggregated metric value from side B                      |
| Delta    | B - A (absolute difference)                              |
| Delta %  | (B - A) / |A| * 100 (abs ensures sign matches direction of change) |
| Ratio    | B / A (same value plotted on the chart)                  |
| Status   | Improved / Regressed / Unchanged (respects bigger_is_better) |

- **Geomean summary row**: The first row shows a geomean summary. Value A and Value B columns show the geometric mean of absolute values per side (useful for SPEC-like suites where individual values are comparable). Delta and Delta % are computed from these geomeans. The Ratio column shows the geometric mean of per-test ratios (the multiplicative average speedup), which is subtly different from geomean(B)/geomean(A) but is the standard way to report aggregate speedups.
- Sortable by any column (click header)
- Color-coded status: green = improved, red = regressed (direction respects the metric's `bigger_is_better` flag)
- **Noise handling**: rows with |Delta %| below the noise threshold are visually de-emphasized (lighter text, no color). The "Hide noise" checkbox hides them entirely.
- **Missing tests**: tests present in only one side show "—" for the missing side's values. These are grayed out in a separate section at the bottom, excluded from the chart. This includes tests absent due to cross-suite comparison (different suites may have different test sets).
- **Null metrics**: when a test has a sample but no value for the selected metric, display "N/A" in the table and exclude from the chart
- **Zero baseline**: when Value A is 0, display "N/A" for Delta %, Ratio, and Status (raw values are still shown)
- **Interactive rows**: Clicking a row toggles its visibility on the chart. Double-clicking a row isolates it (hides all others), like the Graph page's legend table. Hidden rows are shown grayed out (not removed). The "Hide noise" checkbox is a separate filter applied on top of manual visibility — the two filters are independent: manual toggles persist across hideNoise changes, and changing the noise threshold correctly hides/unhides tests as their status changes.
- **Summary message**: A message above the table rows shows a count, consistent with the Graph page's legend message: "150 tests" when all visible, "120 of 150 tests visible" when some are hidden, or "42 of 150 tests matching" when a text filter or chart zoom is active.

#### Chart

Sorted ratio chart (relative performance chart):
- **X-axis**: tests, sorted by B/A ratio
- **Y-axis**: log₂(ratio) scale — equal multiplicative changes (e.g. 2× faster vs 2× slower) produce symmetric bars. Tick labels show percentage change at "nice" values (±1%, ±5%, ±10%, ±50%, ±100%, etc.), auto-adapting to the data range
- Rendered as a connected line (not discrete bars) for readability at scale

Interactivity:
- **Hover**: tooltip showing test name, exact ratio, and absolute values for both sides
- **Zoom / drag-select**: filters the comparison table to show only the tests in the visible range
- **Noise band**: horizontal reference lines at the +/- noise threshold to visually separate signal from noise
- **Text filter**: the chart applies the text filter from the selection panel; the text filter stacks with the chart zoom filter (intersection)
- **Zoom preservation**: changing noise settings, aggregation functions, text filter, or toggling row visibility preserves the current chart zoom. The user can double-click the chart to reset zoom.
- **Adaptive tick labels on zoom**: tick labels recompute dynamically when the user zooms — zooming into a narrow range shows fine-grained percentage ticks (±1%, ±2%), while the full view shows coarser ticks (±50%, ±100%). Double-click reset restores ticks for the full data range.
- **Empty state**: when there is no data to chart (no comparison triggered yet, or no tests match), the chart area displays "No data to chart." — consistent with the Graph page's empty-state pattern.

#### Bidirectional Chart-Table Sync

The chart and table always represent the same dataset:
- **Chart → Table**: zooming or drag-selecting on the chart filters the table to the matching tests
- **Table → Chart**: the text filter and row toggles update the chart to show only visible, matching tests
- **Hover sync**: hovering on a chart point highlights the table row (scrolls into view); hovering on a table row highlights the chart point

#### Data Flow

1. Page loads: fetch metric metadata via `GET test-suites/{ts}` (fields from `schema.metrics`) and all orders via `GET orders` (cursor-paginated) to populate the order comboboxes.
2. User selects order and machine on each side. On each change, fetch `GET runs?machine=M&order=O` to populate the runs checkbox list. If no runs exist, show an empty list.
3. Once both sides have runs and a metric is selected, comparison triggers automatically. Fetch sample data for each selected run via `GET runs/{uuid}/samples` (cursor-paginated with `limit=500`). Show a progress indicator during fetch.
4. Client-side: aggregate samples (within-run via sample aggregation), aggregate across runs (via run aggregation), join on test name, compute derived columns (delta, ratio, status).
5. Render table and chart.
6. Subsequent filter/sort/zoom operations are client-side (data already loaded).
7. If the user changes selections while data is loading, abort the in-flight requests before starting new ones.

**Per-run sample caching**: Fetched samples are cached per run UUID. Changing the metric, aggregation function, noise threshold, or run selection re-aggregates and re-compares from cache without any API calls. Only selecting a new order or machine (which produces different run UUIDs) triggers new fetches, and only for runs not already in the cache.

#### URL State

All selection state is encoded as query parameters for shareability:
- `suite_a`, `order_a`, `machine_a`, `runs_a` (comma-separated UUIDs), `run_agg_a`
- `suite_b`, `order_b`, `machine_b`, `runs_b`, `run_agg_b`
- `metric`, `sample_agg`, `noise`
- Filter/sort state as applicable

Auth token is stored in `localStorage`, not in URL state (to avoid leaking credentials when sharing URLs). All URL updates use `replaceState` (not `pushState`) so the browser Back button navigates between pages, not between individual setting changes.

#### Known Limitations

- Only single-field orders are supported for the order combobox. Multi-field orders use only the primary field.

**Links out**: Machine Detail, Run Detail, Graph (with machine pre-filled).

### 8. Regression List — `/v5/{ts}/regressions` (STUB)

Placeholder page displaying "Not implemented yet." Will be designed in a later deep dive.

### 9. Regression Detail — `/v5/{ts}/regressions/{uuid}` (STUB)

Placeholder page displaying "Not implemented yet." Will be designed in a later deep dive.

### 10. Field Change Triage — `/v5/{ts}/field-changes` (STUB)

Placeholder page displaying "Not implemented yet." Will be designed in a later deep dive.

### 11. Admin — `/v5/admin`

Not test-suite specific. Served at `/v5/admin` (outside the `{ts}` namespace) with its own Flask route. The SPA shell is served without a testsuite; the admin page reads the list of available test suites from the HTML `data-testsuites` attribute.

| Tab | Shows | API Calls |
|-----|-------|-----------|
| API Keys | List, create, revoke API keys (global to instance) | `GET/POST/DELETE admin/api-keys` |
| Test Suites | Suite selector, schema viewer, delete suite | `GET/DELETE test-suites` |
| Create Suite | Name input + JSON schema definition textarea | `POST test-suites` |

**Test Suites tab details**:
- **Suite selector**: Dropdown to switch between test suites. Selecting a suite loads and displays its schema (metrics, order fields, machine fields, run fields).
- **Delete suite**: A delete button per suite. Clicking it shows an inline confirmation panel explaining that deleting a suite permanently destroys all machines, runs, orders, samples, regressions, and field changes, and is irreversible. The user must type the exact suite name to confirm. Calls `DELETE /api/v5/test-suites/{name}?confirm=true`. Requires `manage` scope.

**Create Suite tab**:
- A name input and a JSON textarea where the user pastes the full suite definition (format_version, name, metrics, run_fields, machine_fields). The JSON format matches the `POST /api/v5/test-suites` API. On success, switches to the Schemas tab with the new suite auto-selected. Requires a token with `manage` scope.

---

## v4 Features NOT Carried Forward

These v4 pages are intentionally omitted from the v5 UI:

| v4 Feature | Rationale |
|------------|-----------|
| Daily Report | Subsumed by Dashboard + Graph. The dashboard shows recent activity; the graph page shows trends. |
| Latest Runs Report | Subsumed by Dashboard (recent submissions section). |
| Summary Report | Low usage, "WIP" in v4. Can be added later if needed. |
| Matrix View | Niche use case. The Graph page with per-test drill-down covers the same need. |
| Global Status | Subsumed by Dashboard (active machines + regression summary). |
| Profile Admin | Operational concern, not a core user workflow. Keep in v4. |
| Submit Run page | Runs are submitted via CLI (`lnt submit`) or API. A form-based UI is rarely used. |
| Rules page | Read-only diagnostic page. Keep in v4 for ops. |

## Frontend Code Structure

```
lnt/server/ui/v5/frontend/src/
├── main.ts                    Entry point, SPA bootstrap
├── router.ts                  Client-side URL routing (History API)
├── api.ts                     Extend existing API client
├── types.ts                   Extend existing types
├── state.ts                   Extend existing URL state management
├── events.ts                  Extend existing custom events
├── utils.ts                   Extend existing utilities (el(), formatValue(), etc.)
├── combobox.ts                Reuse existing combobox widget
├── style.css                  Extend existing styles
├── pages/
│   ├── home.ts                Suite-agnostic dashboard (placeholder)
│   ├── test-suites.ts         Suite-agnostic test suites page (picker + tabs)
│   ├── machine-detail.ts
│   ├── run-detail.ts
│   ├── order-detail.ts
│   ├── graph.ts
│   ├── compare.ts             Compare page module (auto-compare, caching, row toggling)
│   ├── regression-list.ts
│   ├── regression-detail.ts
│   ├── field-change-triage.ts
│   └── admin.ts
└── components/
    ├── nav.ts                 Navigation bar
    ├── data-table.ts          Reusable sortable/filterable table
    ├── time-series-chart.ts   Plotly time-series chart component
    ├── machine-combobox.ts    Standalone machine typeahead selector
    ├── metric-selector.ts     Reusable metric drop-down (supports optional placeholder)
    ├── order-search.ts        Order search with tag-based autocomplete
    └── pagination.ts          Cursor/offset pagination controls
```

### Reuse from Existing Compare Page

| Existing Module | Reuse Strategy |
|----------------|----------------|
| `api.ts` | Extend with new endpoint functions |
| `types.ts` | Extend with new interfaces |
| `combobox.ts` | Reuse for Compare page order/machine selectors (extended with tag display, machine filtering, input validation) |
| `utils.ts` | Reuse `el()`, `formatValue()`, aggregation functions |
| `chart.ts` | Compare page bar chart (extended with text filter, zoom preservation) |
| `table.ts` | Compare page table (extended with row toggling, geomean, summary message) |
| `comparison.ts`, `selection.ts` | Core comparison logic and selection panel, wrapped by `pages/compare.ts` |

### Build Config Change

```typescript
// vite.config.ts — output changes from comparison.js to v5.js
lib: {
  entry: resolve(__dirname, 'src/main.ts'),
  formats: ['iife'],
  name: 'LNTv5',
  fileName: () => 'v5.js',
},
outDir: resolve(__dirname, '../static/v5'),
```

## API Additions Needed

**None are blocking.** All v4 workflows can be served by the existing v5 API.

One optional enhancement for performance:
- `GET /api/v5/{ts}/regressions?include=summary` — enriches list items with `indicator_count`, `earliest_order`, `latest_order` to avoid N+1 fetches on the regression list page. Without this, the frontend can fetch details lazily (regression lists are typically small).

## Implementation Phases

| Phase | Pages | Foundation Work |
|-------|-------|-----------------|
| 1 | (none visible) | SPA shell, router, nav bar, Flask catch-all route, build config |
| 2 | Test Suites (picker + tabs), Machine Detail, Run Detail, Order Detail | Core browsing — data-table component, pagination, suite picker |
| 3 | Graph | Time-series chart component, combobox integration, aggregation controls, field change annotations |
| 4 | Compare | Absorb existing compare page into SPA as page module, add geomean summary |
| 5 | Regression List, Regression Detail, Field Change Triage (stubs) | Stub pages with "Not implemented yet" message |
| 6 | Admin, polish | API key management, error handling, loading states |

## Verification

After each phase, verify by:
1. Running the dev server (`lnt runserver`) and navigating to `http://localhost:8000/v5/{ts}/`
2. Checking that SPA routing works (browser back/forward, direct URL access)
3. Checking that all API calls succeed (browser DevTools Network tab)
4. Running Vitest unit tests: `cd lnt/server/ui/v5/frontend && npm test`
5. Checking that the v4 UI is unaffected (navigate to `/v4/{ts}/recent_activity`)
6. Checking the v4↔v5 toggle links work in both directions
