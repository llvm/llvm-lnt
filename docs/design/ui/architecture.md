# v5 Web UI: Architecture

This document covers the SPA architecture, client-side routing, Flask backend
routes, navigation bar, v4/v5 toggle, frontend code structure, and
implementation phases.

For individual page specifications, see the other documents in this directory:
[Dashboard](dashboard.md), [Browsing Pages](browsing.md), [Graph](graph.md),
[Compare](compare.md), [Profiles](profiles.md), [Admin](admin.md).


## Context

LNT's current web UI is built on v4 Flask/Jinja2 server-rendered pages with
jQuery 1.7 and Bootstrap 2. It works but feels dated. The v5 REST API is now
complete and a single v5 page already exists (the Compare SPA). This plan
designs a complete new UI built exclusively on the v5 API.


## Single-Page Application

**One SPA with client-side routing**, extending the pattern proven by the
existing Compare page.

- **Framework**: Vanilla TypeScript (no React/Vue) -- matches the existing Compare SPA
- **Build**: Vite, single IIFE bundle (`v5.js` + `v5.css`)
- **Charts**: Plotly.js (loaded from CDN)
- **Routing**: Simple path-based client-side router using History API. All internal links set their `href` to the real URL and intercept plain clicks for SPA navigation (no full page reload). Modified clicks (Cmd+Click, Ctrl+Click, Shift+Click, middle-click) bypass the SPA router and let the browser handle them natively (e.g. open in a new tab).
- **State**: URL query params for shareable deep-links; localStorage for auth token

**Design consistency**: All pages should share a consistent look and feel, using the v5 Compare page as the reference for UI patterns -- comboboxes, metric selectors, table styling, progress/error feedback, color scheme, and layout spacing. Reuse the same components across pages rather than reinventing per-page. Pages with selection controls (dropdowns, filters, aggregation settings) wrap them in a shared controls panel -- a lightly shaded box with a border -- so the settings area is visually distinct from the page content.

**Authentication**: The v5 API allows unauthenticated reads by default (configurable via `require_auth_for_reads` in `lnt.cfg`). All pages in the current scope are read-only, so no authentication is needed. The SPA navigation bar includes a Settings panel with a Bearer token input (stored in localStorage) for the Admin page and future write-capable pages (regression triage, etc.).

**Why SPA over server-rendered pages:**
- Avoids full-page reloads (and re-downloading Plotly) when navigating
- Shared state (auth token, test suite context) lives naturally in the app
- The Compare page already proves vanilla TS + Vite works well
- All data comes from the v5 REST API -- no server-side rendering needed


## Flask Backend: Suite-Agnostic and Suite-Scoped Routes

The v5 API only supports the default DB, so v5 frontend routes do not include
`db_<db_name>` prefixes.

Suite-agnostic pages (dashboard, test suites, admin, graph, compare) are served
at top-level `/v5/` routes with `data-testsuite=""`, while suite-scoped pages
use the catch-all route which passes the test suite name as `data-testsuite`.

```python
# lnt/server/ui/v5/views.py
@v5_frontend.route("/v5/", strict_slashes=False)
@v5_frontend.route("/v5/test-suites", strict_slashes=False)
@v5_frontend.route("/v5/admin", strict_slashes=False)
@v5_frontend.route("/v5/graph", strict_slashes=False)
@v5_frontend.route("/v5/compare", strict_slashes=False)
@v5_frontend.route("/v5/profiles", strict_slashes=False)
def v5_global():
    ...renders v5_app.html shell with empty testsuite...

@v5_frontend.route("/v5/<testsuite_name>/")
@v5_frontend.route("/v5/<testsuite_name>/<path:subpath>")
def v5_app(testsuite_name, subpath=None):
    ...renders v5_app.html shell for suite-scoped pages...
```

The existing Compare page route (`v5_compare`) also needs to be updated to
remove its `db_<db_name>` variant.

The shell template (`v5_app.html`) is a standalone HTML page (it does NOT
extend `layout.html`) and mounts `<div id="v5-app">` with the SPA bundle. This
avoids inheriting v4 CSS/JS (Bootstrap 2, jQuery, DataTables) and layout
artifacts (fixed-navbar margins, sticky footer).


## Page Hierarchy

```
/v5/                                   Dashboard (landing page -- sparkline trend overview)
/v5/test-suites?suite={ts}&tab=...     Test Suites (suite picker + browsing tabs)
/v5/{ts}/                              Suite root (redirects to /v5/test-suites?suite={ts})
/v5/{ts}/machines/{name}               Machine Detail
/v5/{ts}/runs/{uuid}                   Run Detail
/v5/{ts}/commits/{value}               Commit Detail
/v5/{ts}/regressions/{uuid}            Regression Detail
/v5/graph?suite={ts}&machine=...       Graph (time series) -- suite-agnostic
/v5/compare?suite_a={ts}&...           Compare -- suite-agnostic
/v5/profiles?suite_a={ts}&...           Profiles (A/B profile viewer) -- suite-agnostic
/v5/admin                              Admin (API keys, schemas -- not test-suite specific)
```


## Navigation Bar

```
[LNT] [Test Suites] [Graph] [Compare] [Profiles] [API]  <---->  [Admin] [Settings]
```

All navbar links are suite-agnostic. The navbar behavior depends on the page context:

- **Suite-agnostic context** (`/v5/...` without a suite): All navbar links use SPA navigation. API opens in a new tab.
- **Suite-scoped context** (`/v5/{ts}/...`): All navbar links use full-page navigation (since they target `/v5/...` which is outside the suite basePath `/v5/{ts}`).

Graph, Compare, and Profiles links append `?suite={ts}` / `?suite_a={ts}` when
navigated from suite-scoped context, pre-filling the current suite. The Test
Suites link appends `?suite={ts}` to preserve the suite context.


## v4/v5 Toggle

v4 and v5 are fully disjoint: in v4 mode no v5 code is registered, and in
v5 mode no v4 code is registered. There are no cross-links between the two
UIs.


## Frontend Code Structure

```
lnt/server/ui/v5/frontend/src/
+-- main.ts                    Entry point, SPA bootstrap
+-- router.ts                  Client-side URL routing (History API)
+-- api.ts                     Extend existing API client
+-- types.ts                   Extend existing types
+-- state.ts                   Extend existing URL state management
+-- events.ts                  Extend existing custom events
+-- utils.ts                   Extend existing utilities (el(), formatValue(), etc.)
+-- combobox.ts                Reuse existing combobox widget
+-- style.css                  Extend existing styles
+-- pages/
|   +-- home.ts                Suite-agnostic dashboard (sparkline trend overview)
|   +-- test-suites.ts         Suite-agnostic test suites page (picker + tabs)
|   +-- machine-detail.ts
|   +-- run-detail.ts
|   +-- commit-detail.ts
|   +-- graph.ts
|   +-- compare.ts             Compare page module (auto-compare, caching, row toggling)
|   +-- regression-list.ts     Regression tab renderer (called by test-suites.ts)
|   +-- regression-detail.ts
|   +-- admin.ts
|   +-- profiles.ts             Profile viewer page (A/B comparison)
+-- components/
    +-- nav.ts                 Navigation bar
    +-- data-table.ts          Reusable sortable/filterable table
    +-- sparkline-card.ts      Lightweight Plotly sparkline for Dashboard
    +-- time-series-chart.ts   Plotly time-series chart component
    +-- machine-combobox.ts    Standalone machine typeahead selector
    +-- metric-selector.ts     Reusable metric drop-down (supports optional placeholder)
    +-- commit-search.ts       Commit search with tag-based autocomplete
    +-- pagination.ts          Cursor/offset pagination controls
    +-- profile-viewer.ts      Profile disassembly renderer (straight-line + CFG)
    +-- profile-cfg.ts         Control-flow graph renderer (D3-based)
    +-- profile-stats.ts       Top-level counter comparison bar
```

### Reuse from Existing Compare Page

| Existing Module | Reuse Strategy |
|----------------|----------------|
| `api.ts` | Extend with new endpoint functions |
| `types.ts` | Extend with new interfaces |
| `combobox.ts` | Reuse for Compare page commit/machine selectors (extended with tag display, machine filtering, input validation) |
| `utils.ts` | Reuse `el()`, `formatValue()`, aggregation functions |
| `chart.ts` | Compare page bar chart (extended with text filter, zoom preservation) |
| `table.ts` | Compare page table (extended with row toggling, geomean, summary message) |
| `comparison.ts`, `selection.ts` | Core comparison logic and selection panel, wrapped by `pages/compare.ts` |


### Build Config Change

```typescript
// vite.config.ts -- output changes from comparison.js to v5.js
lib: {
  entry: resolve(__dirname, 'src/main.ts'),
  formats: ['iife'],
  name: 'LNTv5',
  fileName: () => 'v5.js',
},
outDir: resolve(__dirname, '../static/v5'),
```


## API Additions Needed

The Profiles page (Phase 7) requires new API endpoints: profile listing per
run, profile metadata/functions/detail by UUID. These are specified in
[endpoints.md](../api/endpoints.md). All other workflows can be served by
the existing v5 API.


## Implementation Phases

| Phase | Pages | Foundation Work |
|-------|-------|-----------------|
| 1 | (none visible) | SPA shell, router, nav bar, Flask catch-all route, build config |
| 2 | Test Suites (picker + tabs), Machine Detail, Run Detail, Commit Detail | Core browsing -- data-table component, pagination, suite picker |
| 3 | Graph | Time-series chart component, combobox integration, aggregation controls, regression annotations |
| 4 | Compare | Absorb existing compare page into SPA as page module, add geomean summary |
| 5 | Regression Detail | Full regression management page, cross-page integration |
| 6 | Admin, polish | API key management, error handling, loading states |
| 7 | Profiles | DB model, binary format parser, API endpoints, Profiles page (A/B picker, stats bar, straight-line + CFG view), Compare/Run Detail integration |


## Verification

After each phase, verify by:
1. Running the dev server (`lnt runserver`) and navigating to `http://localhost:8000/v5/{ts}/`
2. Checking that SPA routing works (browser back/forward, direct URL access)
3. Checking that all API calls succeed (browser DevTools Network tab)
4. Running Vitest unit tests: `cd lnt/server/ui/v5/frontend && npm test`
