# v5 Web UI Redesign — Implementation Plan

This document is a step-by-step implementation plan for the v5 Web UI redesign described in `docs/design/v5-ui.md`. Each phase includes the exact file changes, new modules, API function signatures, type definitions, and testing strategy needed for a developer to execute independently.

## Prerequisite Reading

Before starting, read:
- `docs/design/v5-ui.md` — the high-level design
- All existing frontend source in `lnt/server/ui/v5/frontend/src/`
- The v5 API endpoints in `lnt/server/api/v5/endpoints/`

---

## Phase 1: SPA Scaffolding

**Goal**: Transform the existing Compare-only page into an SPA shell with client-side routing, a navigation bar, and a catch-all Flask route. The Compare page must keep working throughout.

### 1.1 Build Config Changes

**File**: `lnt/server/ui/v5/frontend/vite.config.ts`

Change the output from `comparison.js` / `comparison.css` to `v5.js` / `v5.css`, with a new output directory:

```typescript
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: resolve(__dirname, '../static/v5'),
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, 'src/main.ts'),
      formats: ['iife'],
      name: 'LNTv5',
      fileName: () => 'v5.js',
    },
    rollupOptions: {
      external: ['plotly.js-dist'],
      output: {
        globals: {
          'plotly.js-dist': 'Plotly',
        },
        assetFileNames: 'v5[extname]',
      },
    },
  },
});
```

**Migration note**: The old `static/comparison/` directory should be kept temporarily until all templates are updated. After Phase 1 is complete and verified, delete `static/comparison/`.

**Packaging note**: When the build output path changes, `pyproject.toml` `[tool.setuptools.package-data]` and `MANIFEST.in` must be updated to match. The package-data globs for `lnt.server.ui.v5` must include `static/v5/*.js`, `static/v5/*.css`, and `static/v5/*.map`. Without this, the static assets are silently excluded from the installed package (editable installs work because they serve from the source tree, but `pip install` in Docker does not).

### 1.2 Package.json

**File**: `lnt/server/ui/v5/frontend/package.json`

No dependency changes needed. The existing `vite`, `vitest`, `typescript`, and `jsdom` are sufficient. The `build` and `test` scripts remain the same.

### 1.3 New SPA Shell Template

**File**: `lnt/server/ui/v5/templates/v5_app.html` (new file)

This is a standalone HTML page (does NOT extend `layout.html`). The v5 SPA renders its own navigation bar, CSS, and JS — inheriting the v4 layout would pull in Bootstrap 2, jQuery, DataTables, and layout artifacts (97px fixed-navbar margin, sticky footer) that conflict with the SPA.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>{{ old_config.name }} : {{ g.testsuite_name }} - v5 UI</title>
  <link rel="icon" type="image/png" href="{{ url_for('lnt.static', filename='favicon.ico') }}"/>
  <script>var lnt_url_base="{{ url_for('lnt.index', _external=False) }}".replace(/\/$/, "");</script>
  <link rel="stylesheet" href="{{ url_for('lnt_v5.static', filename='v5/v5.css') }}"/>
  <script src="https://cdn.plot.ly/plotly-3.4.0.min.js" integrity="sha384-pFOQ7loGBChmUyS4Tszy+he8OWeYkwTFjc2xii4aJUWWiGwf2u2OEc04T5iDRpMp" crossorigin="anonymous"></script>
</head>
<body>
<div id="v5-app"
     data-testsuite="{{ g.testsuite_name }}"
     data-testsuites="{{ testsuites | tojson | forceescape }}"
     data-v4-url="{{ v4_url_for('lnt.v4_recent_activity') }}">
</div>
<script src="{{ url_for('lnt_v5.static', filename='v5/v5.js') }}"></script>
</body>
</html>
```

The `data-testsuites` attribute provides the list of available test suite names (for the suite selector in the nav bar). The `data-v4-url` attribute provides the v4 URL for the toggle link.

**Note on `| tojson | forceescape`**: Flask's `tojson` returns a `Markup` object (marked HTML-safe), so Jinja2's `| e` filter is a no-op on it. Using `| forceescape` ensures the JSON double-quotes are escaped to `&quot;` inside the HTML attribute. Without this, the raw `"` in the JSON would terminate the attribute and break `JSON.parse()` at runtime.

### 1.4 Flask Backend Changes

**File**: `lnt/server/ui/v5/views.py`

Add a catch-all route for the SPA and update the existing compare route. The v5 UI does not include `db_<db_name>` in its URL namespace.

```python
from flask import render_template, request

from . import v5_frontend, _setup_testsuite
from lnt.server.ui.views import ts_data


@v5_frontend.route("/v5/<testsuite_name>/")
@v5_frontend.route("/v5/<testsuite_name>/<path:subpath>")
def v5_app(testsuite_name, subpath=None):
    """Catch-all route for the v5 SPA.

    All client-side routes (dashboard, machines, graph, compare, etc.)
    hit this single endpoint, which serves the SPA shell. The TypeScript
    router handles the rest.
    """
    _setup_testsuite(testsuite_name)
    try:
        ts = request.get_testsuite()
        data = ts_data(ts)
        # Add test suite names for the suite selector
        db = request.get_db()
        data['testsuites'] = sorted(db.testsuite.keys())
        return render_template("v5_app.html", **data)
    finally:
        request.session.close()


# Keep the old compare route for backward compatibility during transition.
# Once Phase 4 absorbs Compare into the SPA, this route can be removed.
@v5_frontend.route("/v5/<testsuite_name>/compare")
@v5_frontend.route("/db_<db_name>/v5/<testsuite_name>/compare")
def v5_compare(testsuite_name, db_name=None):
    _setup_testsuite(testsuite_name, db_name)
    try:
        ts = request.get_testsuite()
        return render_template("v5_compare.html", **ts_data(ts))
    finally:
        request.session.close()
```

**Important**: The catch-all route `<path:subpath>` will also match `/compare`. During Phases 1-3, the old `v5_compare` route (registered first, more specific) takes priority and serves the standalone Compare page via `v5_compare.html`. In Phase 4, the old route is deleted and the catch-all serves the SPA shell for all paths including `/compare`.

The simplest approach: remove the `db_<db_name>` variant of `v5_compare` immediately (it was never the intended v5 pattern), and keep the non-prefixed `v5_compare` route as a temporary bridge until Phase 4.

### 1.5 Client-Side Router

**File**: `lnt/server/ui/v5/frontend/src/router.ts` (new file)

A minimal path-based router using the History API. Each route maps a URL pattern to a page module that has `mount(container, params)` and `unmount()` functions.

```typescript
// router.ts — Client-side URL routing

export interface PageModule {
  /** Render the page into the container. Called on navigation. */
  mount(container: HTMLElement, params: RouteParams): void | Promise<void>;
  /** Clean up when navigating away. Optional. */
  unmount?(): void;
}

export interface RouteParams {
  testsuite: string;
  /** Named captures from the route pattern, e.g. { name: "machine-1" } */
  [key: string]: string;
}

interface RouteEntry {
  /** Regex compiled from the route pattern */
  regex: RegExp;
  /** Named group keys in order */
  keys: string[];
  /** The page module to mount */
  module: PageModule;
}

const routes: RouteEntry[] = [];
let currentModule: PageModule | null = null;
let appContainer: HTMLElement | null = null;
let basePath = ''; // e.g. "/v5/nts"

/**
 * Register a route. Pattern uses Express-style `:param` syntax.
 * Example: "/machines/:name" matches "/machines/clang-x86"
 */
export function addRoute(pattern: string, module: PageModule): void {
  const keys: string[] = [];
  // Convert ":param" to named regex groups
  const regexStr = pattern
    .replace(/:([a-zA-Z_]+)/g, (_match, key) => {
      keys.push(key);
      return '([^/]+)';
    });
  routes.push({
    regex: new RegExp('^' + regexStr + '$'),
    keys,
    module,
  });
}

/**
 * Initialize the router.
 * @param container The DOM element to render pages into
 * @param tsBasePath The base path, e.g. "/v5/nts"
 */
export function initRouter(container: HTMLElement, tsBasePath: string): void {
  appContainer = container;
  basePath = tsBasePath;

  window.addEventListener('popstate', () => {
    resolve();
  });

  // Initial route resolution
  resolve();
}

/**
 * Navigate to a path (relative to the testsuite base).
 * Example: navigate("/machines/clang-x86")
 */
export function navigate(path: string): void {
  const fullPath = basePath + path;
  window.history.pushState(null, '', fullPath + window.location.search);
  resolve();
}

/**
 * Navigate to a path with query string.
 */
export function navigateWithQuery(path: string, query: string): void {
  const fullPath = basePath + path;
  const qs = query ? '?' + query : '';
  window.history.pushState(null, '', fullPath + qs);
  resolve();
}

/**
 * Resolve the current URL to a route and mount the corresponding page.
 */
function resolve(): void {
  if (!appContainer) return;

  const pathname = window.location.pathname;
  // Strip basePath prefix to get the route portion
  let routePath = pathname;
  if (pathname.startsWith(basePath)) {
    routePath = pathname.slice(basePath.length);
  }
  // Ensure it starts with /
  if (!routePath.startsWith('/')) {
    routePath = '/' + routePath;
  }
  // Normalize: strip trailing slash (except for root "/")
  if (routePath.length > 1 && routePath.endsWith('/')) {
    routePath = routePath.slice(0, -1);
  }

  // Root path "/" maps to the dashboard
  if (routePath === '' || routePath === '/') {
    routePath = '/';
  }

  for (const route of routes) {
    const match = routePath.match(route.regex);
    if (match) {
      const params: RouteParams = {
        testsuite: basePath.split('/').pop() || '',
      };
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(match[i + 1]);
      });

      // Unmount previous page
      if (currentModule?.unmount) {
        currentModule.unmount();
      }

      // Clear container
      appContainer.replaceChildren();

      // Mount new page
      currentModule = route.module;
      currentModule.mount(appContainer, params);
      return;
    }
  }

  // No route matched — show 404
  if (currentModule?.unmount) {
    currentModule.unmount();
  }
  currentModule = null;
  appContainer.replaceChildren();
  const msg = document.createElement('div');
  msg.style.padding = '40px';
  msg.style.textAlign = 'center';
  msg.style.color = '#666';
  msg.innerHTML = '<h2>Page Not Found</h2><p>The URL does not match any v5 page.</p>';
  appContainer.appendChild(msg);
}
```

**Route table** (registered in `main.ts`):

| Pattern | Page Module |
|---------|-------------|
| `/` | `pages/dashboard` |
| `/machines` | `pages/machine-list` |
| `/machines/:name` | `pages/machine-detail` |
| `/runs/:uuid` | `pages/run-detail` |
| `/orders/:value` | `pages/order-detail` |
| `/graph` | `pages/graph` |
| `/compare` | `pages/compare` |
| `/regressions` | `pages/regression-list` |
| `/regressions/:uuid` | `pages/regression-detail` |
| `/field-changes` | `pages/field-change-triage` |
| `/admin` | `pages/admin` |

### 1.6 Navigation Bar Component

**File**: `lnt/server/ui/v5/frontend/src/components/nav.ts` (new file)

Renders a persistent navigation bar above the page content. The nav bar is rendered once by `main.ts` and is not re-rendered on route changes; instead, the active link is updated.

```typescript
// components/nav.ts — Navigation bar

import { el } from '../utils';
import { navigate } from '../router';

export interface NavConfig {
  testsuite: string;
  testsuites: string[];
  v4Url: string;
  urlBase: string; // lnt_url_base
}

let activeLink: HTMLElement | null = null;

/**
 * Render the navigation bar.
 * Returns the nav element to prepend to the app root.
 */
export function renderNav(config: NavConfig): HTMLElement {
  const nav = el('nav', { class: 'v5-nav' });

  // Brand
  const brand = el('a', { class: 'v5-nav-brand', href: '#' }, 'LNT');
  brand.addEventListener('click', (e) => {
    e.preventDefault();
    navigate('/');
  });
  nav.append(brand);

  // Test suite selector
  const suiteSelect = el('select', { class: 'v5-nav-suite-select' }) as HTMLSelectElement;
  for (const name of config.testsuites) {
    const opt = el('option', { value: name }, name);
    if (name === config.testsuite) {
      (opt as HTMLOptionElement).selected = true;
    }
    suiteSelect.append(opt);
  }
  suiteSelect.addEventListener('change', () => {
    // Navigate to the dashboard of the selected test suite
    const newSuite = suiteSelect.value;
    window.location.href = `${config.urlBase}/v5/${encodeURIComponent(newSuite)}/`;
  });
  const suiteGroup = el('div', { class: 'v5-nav-suite' });
  suiteGroup.append(el('span', {}, 'Suite: '), suiteSelect);
  nav.append(suiteGroup);

  // Navigation links
  const links: { label: string; path: string }[] = [
    { label: 'Dashboard', path: '/' },
    { label: 'Graph', path: '/graph' },
    { label: 'Compare', path: '/compare' },
    { label: 'Regressions', path: '/regressions' },
    { label: 'Machines', path: '/machines' },
    { label: 'Admin', path: '/admin' },
  ];

  const linksContainer = el('div', { class: 'v5-nav-links' });
  for (const link of links) {
    const a = el('a', {
      class: 'v5-nav-link',
      href: '#',
      'data-path': link.path,
    }, link.label);
    a.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(link.path);
    });
    linksContainer.append(a);
  }
  nav.append(linksContainer);

  // Right side: v4 toggle + Settings
  const rightGroup = el('div', { class: 'v5-nav-right' });

  const v4Link = el('a', { class: 'v5-nav-link', href: config.v4Url }, 'v4 UI');
  rightGroup.append(v4Link);

  const settingsLink = el('a', {
    class: 'v5-nav-link',
    href: '#',
  }, 'Settings');
  settingsLink.addEventListener('click', (e) => {
    e.preventDefault();
    toggleSettings();
  });
  rightGroup.append(settingsLink);
  nav.append(rightGroup);

  return nav;
}

/**
 * Update the active link in the nav bar based on the current route.
 * Call this after each route resolution.
 */
export function updateActiveNavLink(currentPath: string): void {
  if (activeLink) {
    activeLink.classList.remove('v5-nav-link-active');
  }

  const links = document.querySelectorAll<HTMLElement>('.v5-nav-link[data-path]');
  for (const link of links) {
    const path = link.getAttribute('data-path');
    if (!path) continue;

    // Exact match for "/" (dashboard), prefix match for others
    if (path === '/') {
      if (currentPath === '/' || currentPath === '') {
        link.classList.add('v5-nav-link-active');
        activeLink = link;
      }
    } else if (currentPath.startsWith(path)) {
      link.classList.add('v5-nav-link-active');
      activeLink = link;
    }
  }
}

/** Settings panel toggle (token input). Reuses the existing pattern. */
function toggleSettings(): void {
  let panel = document.getElementById('v5-settings-panel');
  if (panel) {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    return;
  }

  // Create settings panel
  panel = el('div', { id: 'v5-settings-panel', class: 'settings-panel' });
  panel.append(el('label', {}, 'Auth Token'));
  const tokenInput = el('input', {
    type: 'password',
    class: 'token-input',
    placeholder: 'Paste v5 API token...',
  }) as HTMLInputElement;
  tokenInput.value = localStorage.getItem('lnt_v5_token') || '';
  tokenInput.addEventListener('change', () => {
    const val = tokenInput.value.trim();
    if (val) localStorage.setItem('lnt_v5_token', val);
    else localStorage.removeItem('lnt_v5_token');
  });
  panel.append(tokenInput);

  // Insert after the nav
  const nav = document.querySelector('.v5-nav');
  if (nav && nav.parentElement) {
    nav.parentElement.insertBefore(panel, nav.nextSibling);
  }
}
```

### 1.7 Refactor main.ts

**File**: `lnt/server/ui/v5/frontend/src/main.ts`

The entry point changes from Compare-only to SPA bootstrap. The existing compare logic moves to `pages/compare.ts` (Phase 4), but during Phase 1 we set up the skeleton with a placeholder compare page that delegates to the existing modules.

```typescript
// main.ts — SPA entry point

import { setApiBase } from './api';
import { addRoute, initRouter } from './router';
import { renderNav, updateActiveNavLink } from './components/nav';
import { el } from './utils';
import './style.css';

// Page modules (added incrementally across phases)
import { dashboardPage } from './pages/dashboard';
import { machineListPage } from './pages/machine-list';
import { machineDetailPage } from './pages/machine-detail';
import { runDetailPage } from './pages/run-detail';
import { orderDetailPage } from './pages/order-detail';
import { graphPage } from './pages/graph';
import { comparePage } from './pages/compare';
import { regressionListPage } from './pages/regression-list';
import { regressionDetailPage } from './pages/regression-detail';
import { fieldChangeTriagePage } from './pages/field-change-triage';
import { adminPage } from './pages/admin';

declare const lnt_url_base: string;

function init(): void {
  const root = document.getElementById('v5-app');
  if (!root) return;

  const testsuite = root.getAttribute('data-testsuite') || '';
  if (!testsuite) {
    root.textContent = 'Error: no testsuite specified.';
    return;
  }

  const testsuites: string[] = JSON.parse(
    root.getAttribute('data-testsuites') || '[]'
  );
  const v4Url = root.getAttribute('data-v4-url') || '#';

  // Set API base from global set in v5_app.html
  const urlBase = typeof lnt_url_base !== 'undefined' ? lnt_url_base : '';
  setApiBase(urlBase);

  // Render nav bar (persistent across route changes)
  const nav = renderNav({ testsuite, testsuites, v4Url, urlBase });
  root.append(nav);

  // Page content container
  const pageContainer = el('div', { id: 'v5-page' });
  root.append(pageContainer);

  // Register routes
  addRoute('/', dashboardPage);
  addRoute('/machines', machineListPage);
  addRoute('/machines/:name', machineDetailPage);
  addRoute('/runs/:uuid', runDetailPage);
  addRoute('/orders/:value', orderDetailPage);
  addRoute('/graph', graphPage);
  addRoute('/compare', comparePage);
  addRoute('/regressions', regressionListPage);
  addRoute('/regressions/:uuid', regressionDetailPage);
  addRoute('/field-changes', fieldChangeTriagePage);
  addRoute('/admin', adminPage);

  // Initialize router (resolves current URL)
  const basePath = `${urlBase}/v5/${encodeURIComponent(testsuite)}`;
  initRouter(pageContainer, basePath);
}

// Start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
```

**During Phase 1**, most page modules will be stubs (see section 1.8). Only the router, nav, and skeleton need to work.

### 1.8 SPA Link Utility

**File**: `lnt/server/ui/v5/frontend/src/utils.ts` (extend)

Add a `spaLink` helper that all page modules use for internal navigation. This ensures links use the SPA router instead of triggering full page reloads.

```typescript
import { navigate } from './router';

/**
 * Create an anchor element that navigates via the SPA router.
 * All internal links across all pages should use this helper.
 */
export function spaLink(text: string, path: string): HTMLElement {
  const a = el('a', { href: '#', class: 'spa-link' }, text);
  a.addEventListener('click', (e) => {
    e.preventDefault();
    navigate(path);
  });
  return a;
}
```

### 1.9 Stub Page Modules for Phase 1

During Phase 1, create minimal stub modules for every page. Each follows the `PageModule` interface.

**File pattern**: `lnt/server/ui/v5/frontend/src/pages/<name>.ts`

Example stub (`pages/dashboard.ts`):

```typescript
import type { PageModule, RouteParams } from '../router';
import { el } from '../utils';

export const dashboardPage: PageModule = {
  mount(container: HTMLElement, params: RouteParams): void {
    container.append(
      el('div', { class: 'page-placeholder' },
        el('h2', {}, 'Dashboard'),
        el('p', {}, 'Coming soon in Phase 2.'),
      )
    );
  },
};
```

Create identical stubs for all pages: `machine-list.ts`, `machine-detail.ts`, `run-detail.ts`, `order-detail.ts`, `graph.ts`, `compare.ts`, `regression-list.ts`, `regression-detail.ts`, `field-change-triage.ts`, `admin.ts`.

For `compare.ts`, the stub should initially say "Coming soon" but will be replaced in Phase 4 with the full compare integration.

### 1.10 Nav Bar CSS

**File**: `lnt/server/ui/v5/frontend/src/style.css` (append to existing)

Add styles for the nav bar and page container. These extend the existing styles without modifying them.

```css
/* ============================================================
   v5 SPA Navigation Bar
   ============================================================ */

.v5-nav {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 15px;
  background: #343a40;
  border-radius: 4px;
  margin-bottom: 15px;
  flex-wrap: wrap;
}

.v5-nav-brand {
  color: #fff;
  font-weight: 700;
  font-size: 16px;
  text-decoration: none;
  margin-right: 8px;
}

.v5-nav-brand:hover {
  color: #ddd;
}

.v5-nav-suite {
  display: flex;
  align-items: center;
  gap: 4px;
  color: #adb5bd;
  font-size: 13px;
}

.v5-nav-suite-select {
  padding: 2px 6px;
  border: 1px solid #555;
  border-radius: 3px;
  background: #495057;
  color: #fff;
  font-size: 12px;
}

.v5-nav-links {
  display: flex;
  gap: 4px;
  flex: 1;
}

.v5-nav-link {
  color: #adb5bd;
  text-decoration: none;
  font-size: 13px;
  padding: 4px 10px;
  border-radius: 3px;
}

.v5-nav-link:hover {
  color: #fff;
  background: #495057;
}

.v5-nav-link-active {
  color: #fff;
  background: #0d6efd;
}

.v5-nav-right {
  display: flex;
  gap: 4px;
  margin-left: auto;
}

/* Page container */
#v5-page {
  min-height: 300px;
}

.page-placeholder {
  padding: 40px;
  text-align: center;
  color: #666;
}

.page-placeholder h2 {
  margin-bottom: 10px;
}
```

### 1.11 Phase 1 Testing

**Unit tests for `router.ts`** (`__tests__/router.test.ts`):
- Route matching: exact paths, parameterized paths, no match yields 404
- `navigate()` calls `pushState` and mounts the correct module
- `popstate` event triggers re-resolution
- `basePath` stripping works correctly
- Trailing slash normalization

**Unit tests for `components/nav.ts`** (`__tests__/nav.test.ts`):
- Renders all expected links
- Suite selector contains all test suites with correct selected value
- Click on nav link calls `navigate()`
- Active link highlight updates correctly
- Settings toggle creates/shows/hides the token panel

**Manual verification**:
1. Run `cd lnt/server/ui/v5/frontend && npm run build`
2. Start dev server: `lnt runserver`
3. Navigate to `http://localhost:8000/v5/nts/` — should see nav bar + Dashboard stub
4. Click each nav link — URL changes, stub content updates, no full page reload
5. Browser back/forward works
6. Direct URL access (e.g., `/v5/nts/machines`) works (Flask catch-all serves SPA shell)
7. Test suite selector changes URL and reloads
8. v4 UI link navigates to v4 page
9. Old Compare URL (`/v5/nts/compare`) still works (either via old route or catch-all)

---

## Phase 2: Core Browsing Pages

**Goal**: Implement the five read-only browsing pages: Dashboard, Machine List, Machine Detail, Run Detail, and Order Detail.

### 2.1 New API Functions

**File**: `lnt/server/ui/v5/frontend/src/api.ts` (extend existing)

Add the following functions. Signatures are based on the actual v5 API endpoint parameters and responses.

```typescript
// --- New types needed (add to types.ts) ---

export interface OrderDetail {
  fields: Record<string, string>;
  tag: string | null;
  previous_order: OrderNeighbor | null;
  next_order: OrderNeighbor | null;
}

export interface OrderNeighbor {
  fields: Record<string, string>;
  link: string;
}

export interface RunDetail {
  uuid: string;
  machine: string;
  order: Record<string, string>;
  start_time: string | null;
  end_time: string | null;
  parameters: Record<string, string>;
}

export interface TestInfo {
  name: string;
}

export interface QueryDataPoint {
  test: string;
  machine: string;
  metric: string;
  value: number;
  order: Record<string, string>;
  run_uuid: string;
  timestamp: string | null;
}

export interface FieldChangeInfo {
  uuid: string;
  test: string | null;
  machine: string | null;
  metric: string | null;
  old_value: number;
  new_value: number;
  start_order: string | null;
  end_order: string | null;
  run_uuid: string | null;
}

export interface SchemaInfo {
  schema: Record<string, unknown>;
}

export interface APIKeyInfo {
  prefix: string;
  name: string;
  scope: string;
  created_at: string;
  last_used_at: string | null;
  is_active: boolean;
}

// --- New API functions (add to api.ts) ---

/** Get a single machine by name. */
export async function getMachine(
  ts: string,
  name: string,
  signal?: AbortSignal,
): Promise<MachineInfo> {
  return fetchJson<MachineInfo>(
    apiUrl(ts, `machines/${encodeURIComponent(name)}`),
    undefined,
    signal,
  );
}

/** Get runs for a machine (cursor-paginated).
 *  sort: e.g. "-start_time" for newest first. */
export async function getMachineRuns(
  ts: string,
  machineName: string,
  opts?: { sort?: string; limit?: number; cursor?: string },
  signal?: AbortSignal,
): Promise<CursorPaginated<RunInfo>> {
  const params: Record<string, string> = {};
  if (opts?.sort) params.sort = opts.sort;
  if (opts?.limit) params.limit = String(opts.limit);
  if (opts?.cursor) params.cursor = opts.cursor;
  return fetchJson<CursorPaginated<RunInfo>>(
    apiUrl(ts, `machines/${encodeURIComponent(machineName)}/runs`),
    params,
    signal,
  );
}

/** Get a single run by UUID. */
export async function getRun(
  ts: string,
  uuid: string,
  signal?: AbortSignal,
): Promise<RunDetail> {
  return fetchJson<RunDetail>(
    apiUrl(ts, `runs/${encodeURIComponent(uuid)}`),
    undefined,
    signal,
  );
}

/** Get order detail by primary field value (includes prev/next). */
export async function getOrder(
  ts: string,
  value: string,
  signal?: AbortSignal,
): Promise<OrderDetail> {
  return fetchJson<OrderDetail>(
    apiUrl(ts, `orders/${encodeURIComponent(value)}`),
    undefined,
    signal,
  );
}

/** List runs filtered by order value. */
export async function getRunsByOrder(
  ts: string,
  orderValue: string,
  signal?: AbortSignal,
): Promise<RunInfo[]> {
  return fetchAllCursorPages<RunInfo>(
    apiUrl(ts, 'runs'),
    { order: orderValue },
    signal,
  );
}

/** List tests (cursor-paginated, filterable). */
export async function getTests(
  ts: string,
  opts?: { nameContains?: string; limit?: number; cursor?: string },
  signal?: AbortSignal,
): Promise<CursorPaginated<TestInfo>> {
  const params: Record<string, string> = {};
  if (opts?.nameContains) params.name_contains = opts.nameContains;
  if (opts?.limit) params.limit = String(opts.limit);
  if (opts?.cursor) params.cursor = opts.cursor;
  return fetchJson<CursorPaginated<TestInfo>>(
    apiUrl(ts, 'tests'),
    params,
    signal,
  );
}

/** Query data points (the main query endpoint).
 *  Auto-paginates and returns all matching data points. */
export async function queryDataPoints(
  ts: string,
  opts: {
    machine?: string;
    test?: string;
    metric?: string;
    afterOrder?: string;
    beforeOrder?: string;
    sort?: string;
  },
  signal?: AbortSignal,
  onProgress?: (loaded: number) => void,
): Promise<QueryDataPoint[]> {
  const params: Record<string, string> = {};
  if (opts.machine) params.machine = opts.machine;
  if (opts.test) params.test = opts.test;
  if (opts.metric) params.metric = opts.metric;
  if (opts.afterOrder) params.after_order = opts.afterOrder;
  if (opts.beforeOrder) params.before_order = opts.beforeOrder;
  if (opts.sort) params.sort = opts.sort;
  return fetchAllCursorPages<QueryDataPoint>(
    apiUrl(ts, 'query'),
    params,
    signal,
    onProgress,
  );
}

/** List field changes (unassigned, cursor-paginated). */
export async function getFieldChanges(
  ts: string,
  opts?: { limit?: number; cursor?: string },
  signal?: AbortSignal,
): Promise<CursorPaginated<FieldChangeInfo>> {
  const params: Record<string, string> = {};
  if (opts?.limit) params.limit = String(opts.limit);
  if (opts?.cursor) params.cursor = opts.cursor;
  return fetchJson<CursorPaginated<FieldChangeInfo>>(
    apiUrl(ts, 'field-changes'),
    params,
    signal,
  );
}

/** Get schema for a test suite. */
export async function getSchema(
  ts: string,
  signal?: AbortSignal,
): Promise<SchemaInfo> {
  return fetchJson<SchemaInfo>(
    apiUrl(ts, 'schema'),
    undefined,
    signal,
  );
}

/** List API keys (admin endpoint, no testsuite prefix). */
export async function getApiKeys(
  signal?: AbortSignal,
): Promise<{ items: APIKeyInfo[] }> {
  return fetchJson<{ items: APIKeyInfo[] }>(
    `${apiBase}/api/v5/admin/api-keys`,
    undefined,
    signal,
  );
}

/** Search orders by tag prefix (for order search autocomplete). */
export async function searchOrdersByTag(
  ts: string,
  tagPrefix: string,
  opts?: { limit?: number },
  signal?: AbortSignal,
): Promise<CursorPaginated<OrderSummary>> {
  const params: Record<string, string> = { tag_prefix: tagPrefix };
  if (opts?.limit) params.limit = String(opts.limit);
  return fetchJson<CursorPaginated<OrderSummary>>(
    apiUrl(ts, 'orders'),
    params,
    signal,
  );
}

/** Update the tag on an order. Requires `manage` scope token. */
export async function updateOrderTag(
  ts: string,
  orderValue: string,
  tag: string | null,
  signal?: AbortSignal,
): Promise<OrderDetail> {
  return fetchJson<OrderDetail>(
    apiUrl(ts, `orders/${encodeURIComponent(orderValue)}`),
    { method: 'PATCH', body: { tag }, signal },
  );
}
```

**Note**: `fetchJson` and `apiUrl` are existing internal functions in `api.ts`. The new functions above call them directly. `fetchAllCursorPages` is also already available for functions that need to auto-paginate.

For `getMachineRuns` and other paginated endpoints where we want to show pagination controls (not auto-fetch all pages), we return `CursorPaginated<T>` directly instead of using `fetchAllCursorPages`.

**Note on `getFields`**: The pre-existing `getFields(ts)` function (from the Compare page) fetches field/metric metadata via `GET /api/v5/test-suites/{ts}` and extracts `schema.metrics` from the response. There is no dedicated `/fields` endpoint — metric definitions are part of the test suite schema.

### 2.2 Shared Components

#### 2.2.1 Data Table Component

**File**: `lnt/server/ui/v5/frontend/src/components/data-table.ts` (new file)

A reusable sortable, filterable table component. Generalizes the patterns from the existing `table.ts` (comparison table) into a configurable component.

```typescript
// components/data-table.ts

import { el } from '../utils';

export interface Column<T> {
  key: string;
  label: string;
  /** Extract the display value from a row. Defaults to row[key]. */
  render?: (row: T) => string | Node;
  /** Extract a sortable value. Defaults to row[key]. */
  sortValue?: (row: T) => string | number | null;
  /** CSS class for the cell. */
  cellClass?: string;
  /** Whether this column is sortable (default true). */
  sortable?: boolean;
}

export interface DataTableOptions<T> {
  columns: Column<T>[];
  rows: T[];
  /** Initial sort column key. */
  sortKey?: string;
  /** Initial sort direction. */
  sortDir?: 'asc' | 'desc';
  /** Callback when a row is clicked. */
  onRowClick?: (row: T) => void;
  /** CSS class for rows (return a class string per row). */
  rowClass?: (row: T) => string;
  /** Empty state message. */
  emptyMessage?: string;
}

/**
 * Render a data table into the given container.
 * Returns a handle to update the data without full re-render.
 */
export function renderDataTable<T>(
  container: HTMLElement,
  options: DataTableOptions<T>,
): void {
  // Implementation: build <table> with sortable headers,
  // re-sort on header click, call onRowClick on row click.
  // Follows the same styling patterns as .comparison-table.
  // ...
}
```

The full implementation builds a `<table>` with:
- Sortable column headers (click to toggle asc/desc, indicator arrows)
- Row click handler for navigation
- Optional row CSS classes
- Empty state message
- Uses existing CSS classes (`.comparison-table`, `.col-num`, `.sortable`, etc.) for consistency

#### 2.2.2 Pagination Component

**File**: `lnt/server/ui/v5/frontend/src/components/pagination.ts` (new file)

```typescript
// components/pagination.ts

import { el } from '../utils';

export interface PaginationOptions {
  /** Whether there is a previous page (cursor-based). */
  hasPrevious: boolean;
  /** Whether there is a next page. */
  hasNext: boolean;
  /** Callback when Previous is clicked. */
  onPrevious: () => void;
  /** Callback when Next is clicked. */
  onNext: () => void;
  /** Optional: current item range for display, e.g. "1-25 of 150". */
  rangeText?: string;
}

/**
 * Render pagination controls (Previous / Next buttons + range text).
 */
export function renderPagination(
  container: HTMLElement,
  options: PaginationOptions,
): void {
  const row = el('div', { class: 'pagination-controls' });

  const prevBtn = el('button', {
    class: 'pagination-btn',
    disabled: options.hasPrevious ? false : true,
  }, 'Previous') as HTMLButtonElement;
  prevBtn.addEventListener('click', options.onPrevious);

  const nextBtn = el('button', {
    class: 'pagination-btn',
    disabled: options.hasNext ? false : true,
  }, 'Next') as HTMLButtonElement;
  nextBtn.addEventListener('click', options.onNext);

  if (options.rangeText) {
    row.append(el('span', { class: 'pagination-range' }, options.rangeText));
  }

  row.append(prevBtn, nextBtn);
  container.append(row);
}
```

#### 2.2.3 Order Search Component

**File**: `lnt/server/ui/v5/frontend/src/components/order-search.ts` (new file)

A search input for navigating to an order by value or tag. Used by Order Detail (for jumping to an arbitrary order) and later by Graph (for adding pinned orders).

```typescript
// components/order-search.ts

import { el, debounce } from '../utils';
import { searchOrdersByTag } from '../api';
import { navigate } from '../router';

export interface OrderSuggestion {
  orderValue: string;
  tag: string | null;
}

export interface OrderSearchOptions {
  /** Test suite name. */
  testsuite: string;
  /** Placeholder text for the input. */
  placeholder?: string;
  /** Callback when an order is selected. If not provided, navigates to Order Detail. */
  onSelect?: (orderValue: string) => void;
  /**
   * Pre-populated suggestions to show on focus (before the user types).
   * Used by the Graph page to provide all machine orders with tagged
   * orders listed first.
   *
   * The component has two distinct modes based on whether this field is provided:
   * - **Suggestions mode** (`suggestions` provided, even as `[]`): the dropdown
   *   only shows items from this list, filtered by prefix. The API is never called.
   *   Validation (red border, Enter blocked) is active. Use `setSuggestions()`
   *   to populate the list after creation (e.g., once the scaffold loads).
   * - **API mode** (`suggestions` omitted / `undefined`): typing triggers a
   *   debounced `tag_prefix` API search. No validation is applied.
   */
  suggestions?: OrderSuggestion[];
}

/**
 * Render an order search input with autocomplete dropdown.
 *
 * Two modes determined by whether `options.suggestions` is provided:
 *
 * **API mode** (suggestions omitted):
 * - On each keystroke (debounced 300ms): calls GET /orders?tag_prefix={input}&limit=10
 *   to find orders whose tag matches the typed prefix.
 * - Shows results in a dropdown. Each item displays: primary order value + tag (if set).
 * - On Enter: navigates directly to /orders/{inputValue} (exact order value lookup).
 * - On dropdown item click: navigates to that order (or calls onSelect callback).
 *
 * **Suggestions mode** (suggestions provided, even as []):
 * - On focus, the dropdown shows all suggestions with tagged orders listed first.
 * - Typing filters suggestions by prefix matching (no API call).
 * - A red border appears when the typed value has no prefix matches.
 * - Pressing Enter is blocked when the input has no matches (red border state).
 * - Use `setSuggestions()` to update the list after creation (e.g., once scaffold data loads).
 *   During the initial period before setSuggestions() is called, the dropdown is simply empty.
 *
 * This approach works because:
 * - Tag search uses the API's tag_prefix filter (server-side, efficient).
 * - Direct order value entry works by navigating to the order detail URL.
 * - No need to load all orders client-side.
 *
 * Note: The API does NOT support filtering by order value prefix — only by
 * tag and tag_prefix. So the autocomplete only surfaces tag-matching orders.
 * For order-value lookup, the user types the full value and presses Enter.
 *
 * Returns an object with `destroy()` for cleanup and `setSuggestions()` for
 * updating the suggestions list after render (e.g., once scaffold data is ready).
 */
export function renderOrderSearch(
  container: HTMLElement,
  options: OrderSearchOptions,
): { destroy: () => void; setSuggestions: (s: OrderSuggestion[]) => void } {
  // ... implementation
}
```

### 2.3 Dashboard Page

**File**: `lnt/server/ui/v5/frontend/src/pages/dashboard.ts`

```typescript
// pages/dashboard.ts

import type { PageModule, RouteParams } from '../router';
import type { OrderDetail } from '../types';
import { getRecentRuns, getOrder } from '../api';
import { el, spaLink, formatTime, truncate, primaryOrderValue } from '../utils';
import { renderDataTable } from '../components/data-table';

export const dashboardPage: PageModule = {
  mount(container: HTMLElement, params: RouteParams): void {
    const ts = params.testsuite;
    container.append(el('h2', { class: 'page-header' }, 'Dashboard'));

    const recentSection = el('div', { class: 'dashboard-section' });
    container.append(recentSection);

    loadRecentOrders(ts, recentSection);
  },
};
```

**Recent Orders section**: Fetches `getRecentRuns(ts, { limit: 50, sort: '-start_time' })`, groups runs by primary order field value, deduplicates to unique orders, and tracks the latest run UUID per order. Then batch-fetches `getOrder(ts, value)` for each unique order (typically <20 after dedup) to get their tags. Displays a two-column data table: **Order** (order value with tag suffix when set, e.g. "abc123 (release-18)", linked to Order Detail via `spaLink`) and **Latest Run** (timestamp linked to Run Detail via `spaLink`).

The dashboard is intentionally minimal — just the Recent Orders table. Machine List and Field Change Triage are accessible from the navbar; separate dashboard sections for them added no value.

### 2.4 Machine List Page

**File**: `lnt/server/ui/v5/frontend/src/pages/machine-list.ts`

- Renders a search input (name filter) and a data table
- Calls `getMachines(ts, { nameContains, limit, offset })` with offset pagination
- Table columns: Name (link to Machine Detail via `spaLink`), Info (key fields), Last Run (fetched lazily or omitted initially)
- Uses `renderDataTable` from `components/data-table.ts`
- URL state: `?search=` for the name filter (use `replaceState` on input change)
- All internal links use `spaLink()` from `utils.ts` for SPA navigation (no full page reloads)

### 2.5 Machine Detail Page

**File**: `lnt/server/ui/v5/frontend/src/pages/machine-detail.ts`

- Reads `params.name` from the route
- Calls `getMachine(ts, name)` for metadata
- Calls `getMachineRuns(ts, name, { sort: '-start_time', limit: 25 })` for run history
- Displays:
  - Machine name as heading
  - Info key-value pairs as a definition list
  - Run history table with columns: UUID (link to Run Detail), Order (link to Order Detail), Start Time
  - Pagination controls for the run history table
- Action links: "Graph for this machine" (links to `/graph?machine={name}`), "Compare" (links to `/compare?machine_a={name}`)
- **Delete section** at the bottom (visually separated):
  - "Delete Machine" button (red, danger style)
  - Clicking shows a confirmation prompt: text input where the user must type the exact machine name, plus Confirm/Cancel buttons
  - Confirm button stays disabled until the typed name matches exactly
  - On confirm, calls `deleteMachine(ts, name)` (`DELETE /api/v5/{ts}/machines/{name}`, requires `manage` scope)
  - While in-flight, shows "Deleting..." on the button and a message that deletion may take a while for machines with many runs
  - On success (204), navigates to `/machines`
  - On 401/403, shows an error message: "Permission denied. Set an API token with 'manage' scope in Settings."
  - On other errors, shows the error message from the API

### 2.6 Run Detail Page

**File**: `lnt/server/ui/v5/frontend/src/pages/run-detail.ts`

- Reads `params.uuid` from the route
- Calls `getRun(ts, uuid)` for run metadata and `getFields(ts)` for the metric selector in parallel
- Loads samples progressively via `fetchOneCursorPage()` in a loop (limit=2000 per page):
  - Renders the table immediately with the first page
  - Appends rows and re-renders as each subsequent page arrives
  - Shows progress ("Loading samples: N...")
  - Preserves current sort and filter state across re-renders
- Displays:
  - Run UUID, machine (link), order (link), start/end time, parameters as metadata table
  - Metric selector drop-down (reuses `renderMetricSelector` from `components/metric-selector.ts`)
  - Test filter: text input (debounced 200ms) for case-insensitive substring matching on test names, with summary message showing filtered counts
  - Samples table: Test name, selected metric value — sorted by test name ascending by default (using data-table's `sortKey`/`sortDir` options)
  - The metric selector controls which metric column is shown
- Action links: "Compare with..." button (navigates to `/compare?machine_a={machine}&order_a={orderValue}`)
- **Delete section** at the bottom (same pattern as machine-detail.ts):
  - "Delete Run" button (red, danger style)
  - Confirmation: type first 8 chars of run UUID to confirm
  - Calls `deleteRun(ts, uuid)` (requires `manage` scope)
  - On success, navigates to the machine detail page
  - On auth error, shows `authErrorMessage()`

### 2.7 Order Detail Page

**File**: `lnt/server/ui/v5/frontend/src/pages/order-detail.ts`

- Reads `params.value` from the route
- Calls `getOrder(ts, value)` for order detail (includes prev/next links)
- Calls `getRunsByOrder(ts, value)` for runs at this order
- Displays:
  - Order field values prominently
  - **Tag display + editing**: Show the current tag (or "No tag") next to the order field values. An "Edit" button opens an inline text input (max 64 chars) with Save/Cancel buttons. Save calls `updateOrderTag(ts, value, newTag)` (requires `manage` scope token from Settings). On 401/403, shows auth error via `authErrorMessage()`. Setting the tag to empty string clears it (sends `null`).
  - Prev/Next navigation buttons (using `previous_order`/`next_order` from the API response)
  - Summary: "N runs across M machines"
  - **Machine filter**: Text input for case-insensitive substring matching on machine names, debounced (200ms). Filters the runs table and updates the summary to reflect filtered counts (e.g., "5 of 12 runs across 2 of 8 machines").
  - Runs table: Machine (link to Machine Detail), Run UUID (link to Run Detail), Start Time

### 2.8 Phase 2 Types

**File**: `lnt/server/ui/v5/frontend/src/types.ts` (extend)

Add the new interfaces listed in section 2.1: `OrderDetail`, `OrderNeighbor`, `RunDetail`, `TestInfo`, `QueryDataPoint`, `FieldChangeInfo`, `SchemaInfo`, `APIKeyInfo`. Also add `tag: string | null` to the existing `OrderSummary` interface.

### 2.9 Phase 2 Testing

**Unit tests per page module** (in `__tests__/pages/`):

- **dashboard.test.ts**: Mock API calls, verify correct sections render, verify links to other pages
- **machine-list.test.ts**: Verify search filtering calls API with `name_contains`, verify table renders, verify click navigates
- **machine-detail.test.ts**: Verify metadata display, run history table, pagination
- **run-detail.test.ts**: Verify metadata, metric selector, samples table
- **order-detail.test.ts**: Verify order fields, prev/next navigation, machine filter, runs table

**Tests for new API functions** (`__tests__/api.test.ts` — extend):

- `getMachine`: correct URL, returns data
- `getMachineRuns`: correct URL with sort/limit/cursor params
- `getRun`: correct URL with UUID encoding
- `getOrder`: correct URL with order value encoding
- `getRunsByOrder`: correct URL with order filter
- `getTests`: correct URL with filter params
- `queryDataPoints`: correct URL with all filter combinations

**Tests for data-table component** (`__tests__/data-table.test.ts`):

- Renders columns and rows correctly
- Sort toggle works
- Row click callback fires
- Empty state message shows when no rows

**Tests for pagination component** (`__tests__/pagination.test.ts`):

- Renders Previous/Next buttons
- Buttons disabled state when hasPrevious/hasNext is false
- Click callbacks fire

**Tests for order search component** (`__tests__/order-search.test.ts`):

- Renders input field
- Debounced API call on keystroke (calls `searchOrdersByTag` with typed prefix)
- Dropdown shows results with order value + tag
- Enter key navigates to order detail URL
- Dropdown item click navigates to the selected order
- Suggestions mode: when `suggestions` are set, dropdown shows all suggestions on focus with tagged orders first
- Suggestions filtering: typing filters suggestions by prefix; red border appears when no matches; Enter is blocked in red-border state
- `setSuggestions()`: calling it after render updates the suggestions list

**Tests for new API functions** (`__tests__/api.test.ts` — extend):

- `searchOrdersByTag`: correct URL with `tag_prefix` param
- `updateOrderTag`: correct URL, PATCH method, JSON body with `tag` field, auth header

---

## Phase 3: Graph Page

**Goal**: Implement the time-series graph page with auto-plot (no Plot button), lazy-loaded Plotly line charts, per-metric client-side caching, test filtering, aggregation controls, and pinned order overlays. Data is fetched newest-first and rendered progressively so the chart appears immediately.

### 3.1 Time Series Chart Component (`ChartHandle` API)

**File**: `lnt/server/ui/v5/frontend/src/components/time-series-chart.ts` (new file)

A Plotly-based line chart component for time-series data, designed for **incremental updates**. Distinct from the existing bar chart in `chart.ts` (which is for Compare).

The key design choice is the `ChartHandle` pattern: instead of a one-shot `renderTimeSeriesChart()` function, the component exposes `createTimeSeriesChart()` which returns a handle. The handle's `update()` method calls `Plotly.react()` to update the chart in-place as new pages of data arrive, without destroying and re-creating the chart. This enables smooth progressive rendering during lazy loading.

```typescript
// components/time-series-chart.ts

declare const Plotly: {
  newPlot(el: HTMLElement, data: unknown[], layout: unknown, config?: unknown): Promise<HTMLElement>;
  react(el: HTMLElement, data: unknown[], layout: unknown, config?: unknown): Promise<HTMLElement>;
  purge(el: HTMLElement): void;
};

export interface TimeSeriesTrace {
  /** Test name (used for color assignment and filtering). */
  testName: string;
  /** Machine name (used for marker symbol assignment and trace naming). */
  machine: string;
  /** Plotly marker symbol for this trace's machine (e.g., 'circle', 'triangle-up'). */
  markerSymbol?: string;
  /** Data points: [{ orderValue, value, runCount, timestamp }] sorted by order. */
  points: Array<{
    orderValue: string;
    value: number;
    runCount: number;
    timestamp: string | null;
  }>;
}

export interface PinnedOrder {
  orderValue: string;
  /** User-assigned label, if any. */
  tag: string | null;
  /** Per-test values at this pinned order. */
  values: Map<string, number>;
  /** Color for the pinned order lines. */
  color: string;
}

export interface TimeSeriesChartOptions {
  traces: TimeSeriesTrace[];
  /** Y-axis label (metric display name). */
  yAxisLabel: string;
  /** Pinned orders to overlay as horizontal dashed lines. */
  pinnedOrders?: PinnedOrder[];
  /**
   * Pre-fetched complete list of order values for the x-axis.
   * When provided, sets Plotly's xaxis.categoryarray and
   * xaxis.categoryorder = 'array' so the x-axis is fully established
   * from the start and does not resize/shift as lazy-loaded pages arrive.
   */
  categoryOrder?: string[];
  /** Lazy callback to get individual pre-aggregation values for a data point.
   *  Called on hover with (testName, machine, orderValue); if >1 values,
   *  a scatter is shown. */
  getRawValues?: (testName: string, machine: string, orderValue: string) => number[];
}

/**
 * Handle for an active time-series chart. Supports incremental updates
 * via Plotly.react() — the chart is updated in-place as new data arrives.
 */
export interface ChartHandle {
  /** Re-render the chart with updated options (uses Plotly.react). */
  update(options: TimeSeriesChartOptions): void;
  /** Highlight an entire trace by its trace name ('{testName} - {machine}'),
   *  dimming all others. Uses Plotly.restyle() to set opacity and line width —
   *  the hovered trace gets full opacity and a thicker line (3px), while all
   *  other main traces are dimmed to 0.2 opacity. Passing null restores all
   *  traces to their normal appearance. Pinned-order traces are
   *  dimmed along with non-hovered main traces. */
  hoverTrace(traceName: string | null): void;
  /** Clean up the chart (calls Plotly.purge). */
  destroy(): void;
}

/**
 * Create a time-series line chart and return a handle for incremental updates.
 * X-axis: order values (categorical). Y-axis: metric values.
 * One trace (line) per test.
 *
 * Initial render uses Plotly.newPlot(). Subsequent calls to handle.update()
 * use Plotly.react() for efficient in-place updates as lazy-loaded pages arrive.
 */
export function createTimeSeriesChart(
  container: HTMLElement,
  options: TimeSeriesChartOptions,
): ChartHandle {
  // Build one Plotly trace per test×machine combination:
  // { x: orderValues[], y: metricValues[], name: '{testName} - {machine}',
  //   mode: 'lines+markers', marker: { symbol: trace.markerSymbol } }
  //
  // Trace naming: each trace's Plotly name is '{testName} - {machine}'.
  // Marker symbol: if trace.markerSymbol is set, it is passed through to
  // Plotly's marker.symbol property. This distinguishes machines visually
  // (circle for machine 1, triangle-up for machine 2, etc.) while colors
  // represent test identity.
  //
  // If options.categoryOrder is provided, set layout.xaxis.categoryarray
  // and layout.xaxis.categoryorder = 'array' so the x-axis is fixed from
  // the start and does not resize/shift as lazy-loaded data pages arrive.
  // Also set xaxis.autorange = false and xaxis.range = [-0.5, len - 0.5]
  // to lock the visible range, since Plotly's autorange ignores null
  // y-values in the scaffold and would shrink the axis otherwise.
  //
  // Pinned orders: rendered as actual Plotly traces (not layout shapes)
  // so they support hover tooltips. Each pinned order line is a scatter
  // trace with mode='lines', dash='dot', and showlegend=false,
  // populated with a data point at every x-category (scaffold or all
  // trace x-values as fallback) so that hover detection works anywhere
  // along the line. The hovertemplate shows: pinned order value (with
  // tag if set), test name, and metric value. Using traces instead of
  // shapes avoids the Plotly issue where shapes on category axes
  // require numeric indices rather than category name strings for x0/x1.
  //
  // Hover template: test name, machine name, order value, metric value, run count.
  // Hover distance: set layout.hoverdistance = 5 for less sticky tooltips.
  //
  // Raw value scatter on hover: when `getRawValues` callback is provided
  // in options, `plotly_hover` calls it with (testName, orderValue) to
  // lazily fetch the individual pre-aggregation values. If >1 values are
  // returned, a temporary scatter trace is added via Plotly.addTraces()
  // showing the individual values at the same x-position, using the same
  // trace color at 0.3 opacity, mode 'markers', showlegend false. The
  // temporary trace is tracked via `scatterTraceIndex` and removed on
  // `plotly_unhover` via Plotly.deleteTraces(). Both operations are
  // chained after `plotReady`. The callback reference is stored and
  // updated on each doPlot() call so it always reflects the latest options.
  //
  // Zoom preservation: buildPlotlyData() always produces the canonical
  // layout with the full scaffold x-axis range. On react() calls (not
  // the initial newPlot()), doPlot() reads the current axis state from
  // chartDiv.layout (a documented Plotly API) and applies it to the
  // new layout before passing it to react(). Importantly, the read
  // must happen inside the plotReady.then() callback (not at the top
  // of doPlot()), since chartDiv.layout may not reflect the correct
  // state until the previous newPlot()/react() has resolved.
  //   - X-axis: always preserve chartDiv.layout.xaxis.range and
  //     xaxis.autorange. The x-axis range was established by the
  //     scaffold on initial render, or narrowed by user zoom — either
  //     way it should not change on data updates.
  //   - Y-axis: check chartDiv.layout.yaxis.autorange. If false, the
  //     user has explicitly zoomed (Plotly sets autorange=false and an
  //     explicit range on drag-zoom), so preserve the range. If true
  //     (or undefined), the chart is auto-ranging — don't set an
  //     explicit range, letting Plotly auto-fit to new data as it
  //     arrives during progressive loading.
  // Double-click zoom reset works naturally: Plotly internally sets
  // autorange=true on both axes, so the next react() call sees
  // autorange=true and lets both axes auto-range again.
  // When categoryOrder is not provided (scaffold unavailable), the
  // same logic applies: Plotly's default autorange=true is preserved
  // until the user zooms.
  //
  // Empty chart annotation: when traces are empty but categoryOrder is set,
  // add a Plotly annotation at paper coordinates (0.5, 0.5) with text
  // "No data to plot". This preserves the x-axis scaffold so the user
  // can see the order range even when no data matches the current filter.
  //
  // newPlot/react race fix: the initial render stores Plotly.newPlot()'s
  // return value as a `plotReady` promise. Subsequent calls to
  // handle.update() chain Plotly.react() after `plotReady` resolves,
  // preventing race conditions if update() is called before newPlot()
  // completes.
  //
  // Returns a ChartHandle whose update() method rebuilds traces from new
  // options and calls Plotly.react() to update in-place.
  // ...
}
```

### 3.2 `fetchOneCursorPage` API Function

**File**: `lnt/server/ui/v5/frontend/src/api.ts` (extend existing)

Add a low-level cursor-pagination helper alongside the existing `queryDataPoints`:

```typescript
export interface CursorPageResult<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Fetch a single page of cursor-paginated results.
 * Unlike fetchAllCursorPages, the caller controls limit and cursor via params.
 *
 * Used by the graph page for progressive loading: fetch newest data first,
 * render immediately, then fetch older pages in the background.
 */
export async function fetchOneCursorPage<T>(
  url: string,
  params?: Record<string, string>,
  signal?: AbortSignal,
): Promise<CursorPageResult<T>> {
  const page = await fetchJson<CursorPaginated<T>>(url, params, signal);
  return { items: page.items, nextCursor: page.cursor.next };
}
```

This function is generic and URL-agnostic — it takes a full URL (built via `apiUrl()`) and an arbitrary params record. The graph page calls it with `apiUrl(ts, 'query')` and params like `{ machine, metric, sort: '-order', limit: '10000' }`, as well as with `apiUrl(ts, 'machines/{name}/runs')` for the scaffold fetch.

### 3.3 Graph Page Module

**File**: `lnt/server/ui/v5/frontend/src/pages/graph.ts`

The graph page is the most data-intensive page. It uses **lazy loading with per-metric client-side caching** to deliver a fast, interactive experience.

1. **Controls section** (top, wrapped in a `.controls-panel` box — same shared style as the Compare page's selection panel):
   - Machine chip input: uses `renderMachineCombobox` from `components/machine-combobox.ts` for typeahead. When the user types a machine name and presses Enter, the machine is added to a `machines: string[]` list and a chip is rendered. Each chip has an × button to remove it. Adding or removing a machine triggers `doPlot()` if a metric is also selected. The machine list is always restored from URL params on mount (URL is the source of truth); the per-metric data cache is preserved at module scope so navigating back renders instantly.
   - Metric selector drop-down (uses `renderMetricSelector` from `components/metric-selector.ts`). Rendered with `placeholder: true` so it initially shows "-- Select metric --" with no metric pre-selected, consistent with the Compare page. Accepts an optional `initialValue` parameter to pre-select the metric from URL state. When changed (`onChange` callback), if at least one machine is selected, auto-triggers `doPlot()`.
   - "Filter tests" text input (label and placeholder consistent with Compare page, substring match, debounced 200ms). Matches on **test name only** (not machine name), showing/hiding the test across all machines simultaneously. Changes re-render from cache via `updateUrlState()` — no refetch.
   - Run aggregation drop-down (median/mean/min/max) in a labeled control group ("Run aggregation"), consistent with Compare's layout. Changes re-render from cache via `updateUrlState()`.
   - Sample aggregation drop-down (median/mean/min/max) in a separate labeled control group ("Sample aggregation"). Changes re-render from cache via `updateUrlState()`.
   - Pinned order input (label: "Pinned Orders", placeholder: "Pin an order..."). Uses `renderOrderSearch` from `components/order-search.ts` in **suggestions mode** — `suggestions` is always passed (as `cachedSuggestions ?? []`), so the API fallback is never triggered. The suggestions are built from the **union** of all machines' scaffold order values combined with tags from `getOrders()` (fetched in parallel with the scaffolds), and cached at module scope (`cachedSuggestions`). `cachedSuggestions` is rebuilt when machines are added or removed. On focus, the suggestions dropdown shows all orders with tagged orders listed first. Typing filters suggestions by prefix matching. A red border appears when the typed value has no prefix matches; Enter is blocked for invalid values. Adding or removing a pinned order calls `updateUrlState()` — no refetch.
   - No "Plot" button. Plotting is triggered automatically when at least one machine and a metric are selected.

2. **Data fetching strategy — lazy loading with progressive rendering**:
   - On `doPlot()` (called automatically when the machine list and metric are both non-empty):
     - For **each machine** in the `machines` list, independently:
       - Check the **per-metric client-side cache** (keyed by `machine::metric`). If the cache has data for this combination, use it immediately — no API call needed.
       - If no cache hit, proceed in three sequential steps per machine:
         1. **X-axis scaffold** (if not already cached for this machine): Paginated calls to `GET machines/{name}/runs` (via `fetchOneCursorPage<MachineRunInfo>` with `sort=order`) to fetch the complete list of order values. In parallel, `getOrders(ts)` is called to obtain tags for the pinned-order suggestions dropdown. The scaffold is cached per machine.
         2. **Compute union scaffold**: The x-axis scaffold passed to the chart is the **union** of all machines' scaffolds (preserving order). This is recomputed whenever a machine is added/removed or a scaffold finishes loading.
         3. **Lazy data loading**: Begin fetching data pages via `fetchOneCursorPage<QueryDataPoint>(apiUrl(ts, 'query'), { machine, metric, sort: '-order', limit: '10000' })`. After each page, merge into that machine's cache and call `renderFromCache()` to update the chart with traces from **all** machines.
     - Show a progress indicator during background fetching (e.g., "Loading: clang-x86 30000 points, gcc-arm 15000 points...").
     - **Per-machine×metric AbortControllers**: Each machine×metric fetch gets its own `AbortController`. Removing a machine aborts its in-flight fetch without affecting other machines.
   - `renderFromCache()` iterates over all machines' caches, builds traces for each machine (with `machine` field and `markerSymbol` set), merges them, and passes the combined trace list to the chart.
   - `buildTraces()` is called per machine with an empty text filter to get ALL tests. The active set is computed by `computeActiveTests()` based on trace names ("`{test} - {machine}`"), the text filter (matching test name only), manual toggles, and auto-cap.
   - **Marker symbol assignment**: A fixed ordered list of Plotly marker symbols (`MACHINE_SYMBOLS = ['circle', 'triangle-up', 'square', 'diamond', 'x', 'cross', 'star', ...]`). The i-th machine in the `machines` list gets `MACHINE_SYMBOLS[i % MACHINE_SYMBOLS.length]`.
   - **Color assignment**: Colors are assigned by alphabetical index of all **test names** (not trace names) across all machines, using the D3 category10 palette. This ensures the same test on different machines shares the same color.

3. **Legend table and visibility control**:
   - A `createLegendTable` component (`components/legend-table.ts`) renders below the chart, listing traces sorted alphabetically by name. The table is part of the normal page flow (no `max-height`, no `overflow` — scrolling the table scrolls the page, consistent with the Compare page's table) but has a border for visual grouping. Each row represents one trace and shows: a colored marker symbol character (●, ▲, ■, etc. in the trace's color), the test name (left-justified), and the machine name (right-justified, grey). Tests not matching the text filter are hidden entirely (filter matches test name only, hiding all machine variants of non-matching tests). Inactive traces (manually hidden or beyond the 20-cap) are grayed out in place (not partitioned below active traces).
   - The legend message area above the table rows always shows a count: when the 20-cap is active, it shows the cap warning (e.g., "Showing first 20 of 150 traces..."); otherwise it shows a matching count (e.g., "42 of 150 traces matching"). When all traces are visible, it shows just the total (e.g., "150 traces").
   - A trace is active if: its test name matches the text filter, it has not been manually hidden, and (when the 20-cap is active) it is within the first 20 candidates.
   - The 20-cap is only active when there is no text filter AND no manual toggles. Typing in the filter or clicking any row permanently disables the cap for the rest of the page session.
   - Clicking a row toggles visibility and triggers `renderFromCache()`. Double-clicking a row is a shortcut for hiding all other visible traces: the `onIsolate` callback populates `manuallyHidden` with all visible trace names except the double-clicked one. If the double-clicked trace is already the only non-hidden trace, `manuallyHidden` is cleared to restore all. This uses the same `manuallyHidden` mechanism as single-click, so subsequent single-clicks work naturally (e.g., single-clicking a hidden trace after a double-click simply unhides it). The click/dblclick interaction is handled with a 200ms delay on single-click to prevent spurious toggles during a double-click. The legend table exposes both `onToggle` and `onIsolate` callbacks.
   - Colors are assigned by alphabetical index of all **test names** (not trace names) using the D3 category10 palette (`PLOTLY_COLORS`), ensuring the same test on different machines shares the same color.
   - Plotly's built-in legend is disabled (`showlegend: false` always). Traces receive explicit `line.color` and `marker.color` from the color map, and `marker.symbol` from the machine symbol assignment.
   - Bidirectional hover: the legend table dispatches `GRAPH_TABLE_HOVER` events; the chart dispatches `GRAPH_CHART_HOVER` events. The graph page wires these via `onCustomEvent()` (which now returns a cleanup function) to call `chartHandle.hoverTrace()` and `legendHandle.highlightRow()` respectively. `hoverTrace()` uses `Plotly.restyle()` to emphasize the entire trace line (line width 3px, opacity 1.0) and dim all other main traces (opacity 0.2) and pinned-order traces. Passing `null` restores all traces to their normal appearance (line width 1.5px, opacity 1.0). The restyle calls are chained after `plotReady` to avoid race conditions with newPlot/react.
   - `manuallyHidden` (Set of trace names — `'{test} - {machine}'`), `autoCapped` (boolean), `prevActiveTraceNames` (`Set<string>` — the active set from the last chart render, used to skip no-op chart updates), and `legendHandle` are module-scope state. They are preserved across unmount/remount (like the cache). `computeActiveTests()` takes four inputs (allTraceNames, testFilter, manuallyHidden, autoCapped) and returns the active set. The test filter matches against the **test name portion** of each trace name. Double-click isolation is implemented purely through `manuallyHidden` — no separate `isolatedTest` state.

3. **Per-metric client-side cache**:
   - Cache structure: `Map<string, CachedMetricData>` where the key is `${machine}::${metric}` and the value holds the accumulated data points, the next cursor (if fetching is still in progress), and whether fetching is complete. Each machine's data is cached independently.
   - Cache is populated incrementally as pages arrive for each machine.
   - **Instant interactions from cache**: When the user changes the test filter, aggregation mode, or pinned orders, the page re-processes all machines' cached data — no API call, no loading spinner. This is the primary UX benefit of the caching architecture. The `renderFromCache()` function accepts a `batch` parameter and is split into two phases:
     - **Synchronous phase** (legend table + progress): For each machine, extract test names from its cache. Compute trace names (`{test} - {machine}`), compute active set, build legend entries, and update the legend table. This is cheap DOM work and provides instant feedback (e.g., showing which tests match while the user types a filter).
     - **Deferred chart update phase**: For each machine, build traces with the machine's `markerSymbol`. Merge all machines' traces into a single list, then feed to the chart via `requestAnimationFrame`. **Before scheduling any chart work, compare the new active trace name set to `prevActiveTraceNames` (a module-scope `Set<string>`). If the sets are identical and no new data has arrived (`batch = true` indicates a user-initiated change, not a data update), skip the entire deferred phase — the chart already shows the correct traces.** When the chart does need updating, the behavior depends on the `batch` parameter:
       - **`batch = true`** (user-initiated changes: filter, toggle, aggregation, pinned orders): Traces are fed in **batches of `CHART_BATCH_SIZE` (10)** per animation frame. This batching exists to prevent the browser from freezing when a filter matches thousands of tests and the 20-cap is disabled — the chart achieves eventual consistency while the UI stays responsive.
       - **`batch = false`** (progressive data loading: new pages arriving from the API): All traces are rendered in a **single deferred `requestAnimationFrame` call**.
       - In both modes, a module-scope `chartRenderGen` generation counter ensures stale render sequences are abandoned. A `pendingChartRAF` ID is also tracked so the pending frame can be canceled on `unmount()`. Pinned orders are included in every update so pinned-order lines appear from the first frame.
   - **Cache persists across navigation**: The per-machine data cache and scaffolds are module-scope variables that survive `unmount()`/`mount()` cycles. When the user navigates away and presses browser back, `doPlot()` finds the cached data and renders instantly. In-flight fetches are aborted on unmount (their `finally` blocks reset `entry.loading = false`), so `startLazyLoad()` resumes from the saved `nextCursor` on remount. A machine's cache is cleared when that machine is removed from the chip list. Module-scope UI state (`manuallyHidden`, `autoCapped`, `prevActiveTraceNames`, `chartRenderGen`, `cachedSuggestions`) is reset on unmount to prevent stale state on remount — the machines list is restored from URL params.

4. **Pinned orders — asynchronous fetch with aggregation**:
   - Pinned orders are fetched **after the first chart render**, so they do not block initial display.
   - For each machine, check if the pinned order's data points are already in that machine's cache. If so, extract them directly. If not (e.g., the pinned order is outside the fetched range), make a targeted call per machine: `queryDataPoints(ts, { machine, metric, afterOrder: ref, beforeOrder: ref })`.
   - **Aggregation consistency**: Pinned order Y values must be computed using the same run aggregation function (`runAgg`) as the main traces. When multiple data points exist for the same test at the pinned order (multiple runs), they are collected and aggregated, not just taking the first value. The `buildRefsFromCache` function receives the `runAgg` function and applies it per test, so the pinned dashed line aligns exactly with the trace point at that order.
   - Once pinned order data is available, call `chartHandle.update()` to overlay the dashed lines.

5. **Chart rendering**:
   - For each machine: group data points by test name and order, apply aggregation, produce `TimeSeriesTrace[]` with `machine` and `markerSymbol` fields set
   - Merge all machines' traces into a single list, sorted alphabetically by trace name (`{test} - {machine}`)
   - Pass to `createTimeSeriesChart()` (initial) or `chartHandle.update()` (incremental)

6. **URL state**:
   - `?machine={name}&machine={name2}&metric={name}&test_filter={text}&run_agg={fn}&sample_agg={fn}&pin={order1}&pin={order2}`
   - The `machine` parameter is repeated for each selected machine. On mount, parse all `machine` values from URL params and populate the chip list.
   - On mount, parse URL params and auto-plot if machines and metric are provided. The metric selector uses `initialValue` to pre-select the URL metric. The chart container is initialized with a "No data to plot." message, which is replaced on the first successful plot.
   - `updateUrlState()` is called from all interactive handlers (machine add/remove, test filter change, aggregation change, pinned order add/remove), not only from `doPlot()`. This ensures the URL always reflects the current UI state.

### 3.4 Phase 3 Testing

**Tests for `time-series-chart.ts`** (`__tests__/time-series-chart.test.ts`):
- `createTimeSeriesChart` returns a valid `ChartHandle`
- `ChartHandle.update()` calls `Plotly.react()` (not `newPlot`) for incremental updates
- Data preparation: verify traces are built correctly from input data
- Pinned orders: verify pinned-order traces (not shapes) are generated with correct y-values, dash style, color, `showlegend: false`, and hover template containing pinned order value, tag, test name, and metric value; verify scaffold x-range is used when `categoryOrder` is provided; verify no pinned-order traces are generated for tests not in the main traces
- X-axis scaffolding: verify that when `categoryOrder` is provided, the layout sets `xaxis.categoryarray` and `xaxis.categoryorder = 'array'`; verify that when `categoryOrder` is omitted, these layout properties are not set
- Marker symbols: verify that `markerSymbol` on `TimeSeriesTrace` is passed through to Plotly's `marker.symbol`
- Trace naming: verify that the Plotly trace name is `{testName} - {machine}`
- Empty chart annotation: verify that when traces are empty and `categoryOrder` is set, a Plotly annotation is added at paper coordinates (0.5, 0.5) with "No data to plot"
- `plotReady` promise: verify that `update()` chains `Plotly.react()` after the `plotReady` promise from `newPlot()`, preventing race conditions
- `ChartHandle.destroy()` calls `Plotly.purge()`
- Trace highlighting via `hoverTrace()`: verify that `hoverTrace(testName)` calls `Plotly.restyle()` to set the hovered trace to opacity 1.0 and line width 3, while dimming all other traces to opacity 0.2; verify that `hoverTrace(null)` restores all traces to opacity 1.0 and line width 1.5; verify that pinned-order traces are dimmed along with non-hovered main traces; verify restyle calls are chained after `plotReady`
- Raw value scatter: verify that when `getRawValues` returns >1 values, `Plotly.addTraces()` is called with a markers-only scatter trace at the hovered x-position; verify the scatter trace uses the same color at opacity 0.3; verify `Plotly.deleteTraces()` is called on unhover; verify no scatter trace is added when `getRawValues` returns ≤1 values; verify no scatter trace is added when `getRawValues` is not provided
- Zoom preservation: verify that `update()` passes the current `xaxis.range` and `xaxis.autorange` from `chartDiv.layout` to `Plotly.react()`, so x-axis zoom is preserved; verify that when `yaxis.autorange` is `false` on the chart div, the y-axis range is also preserved; verify that when `yaxis.autorange` is `true`, no explicit y-axis range is set (allowing auto-range); verify that after a zoom reset (both axes `autorange` set back to `true`), the next `update()` does not set explicit ranges

**Tests for `fetchOneCursorPage`** (`__tests__/api.test.ts`):
- Returns data points and next cursor from a paginated response
- Returns `nextCursor: null` on the last page
- Passes abort signal through to fetch

**Tests for `pages/graph.ts`** (`__tests__/pages/graph.test.ts`):
- Machine chip input: verify typing a machine name and pressing Enter adds a chip; verify × button removes it; verify removing the last machine clears the chart
- Auto-plot: verify `doPlot()` is called when a machine is added and metric is set; verify no Plot button element exists
- Multi-machine: verify that adding a second machine triggers its own fetch pipeline; verify traces from both machines appear in the chart options; verify trace names are `{test} - {machine}` format; verify marker symbols are assigned per machine index
- URL state parsing: verify multiple `machine` params are restored from URL; verify metric/filter/pinned orders are restored; verify metric selector receives `initialValue` from URL
- URL sync: verify `updateUrlState()` is called from machine add/remove, test filter, aggregation, and pinned order handlers; verify `machine` param is repeated for each selected machine
- Pinned orders: verify URL param is `pin` (not `ref`); verify label is "Pinned Orders" and placeholder is "Pin an order..."; verify pinned order Y values use the same run aggregation as main traces (not just the first raw value)
- Order search suggestions: verify suggestions are populated from union of all machines' scaffolds + `getOrders()` (tags), with tagged orders first; verify prefix-based filtering; verify red border on no matches and Enter blocked
- Test filter: verify filter matches test name only (not machine name); verify matching test shows all machine variants; verify non-matching test hides all machine variants
- Color assignment: verify colors are assigned by alphabetical index of test names (not trace names); verify same test on different machines gets the same color
- Test cap warning: verify warning shows when > N traces match
- Aggregation: verify data points are correctly aggregated before charting
- Cache hit: verify that changing test filter re-renders from cache without API call
- Skip-no-op: verify that `setsEqual` returns true for identical sets and false for different sets; verify that the chart update is skipped when the active trace set has not changed (batch=true path only)
- Cache miss: verify that a new machine triggers a fetch for that machine only
- Progressive rendering: verify `chartHandle.update()` is called after each page, with traces from all machines
- AbortController: verify that removing a machine aborts its in-flight fetch without affecting other machines
- X-axis scaffold: verify the machine runs endpoint is called per machine; verify scaffold union is passed as `categoryOrder` to the chart; verify scaffold is cached per machine; verify chart still renders if one machine's scaffold fetch fails
- `computeActiveTests`: 20-cap with no filter, filter disables cap, manuallyHidden excludes traces, cap disabled when manuallyHidden non-empty, cap never re-enabled

**Tests for `legend-table.ts`** (`__tests__/legend-table.test.ts`):
- Rows rendered in entry order with inactive rows grayed out (no partitioning)
- Colored symbol shows correct color and defaults to ● when no symbolChar specified
- Single-click calls `onToggle` (after 200ms delay)
- Double-click calls `onIsolate` without triggering `onToggle`
- `update()` replaces table content
- `highlightRow()` adds/removes highlight class
- `GRAPH_TABLE_HOVER` events dispatched on hover
- `destroy()` removes the table

---

## Phase 4: Compare Integration

**Goal**: Absorb the existing Compare page into the SPA as a page module, add geomean summary row, and support pre-selected side A from URL params.

### 4.0 Existing Implementation (what's already built)

The Compare page was the first v5 frontend page and is already functional as a standalone SPA. This section summarizes what exists before Phase 4 changes. See the Compare section of `docs/design/v5-ui.md` for the full design.

**Modules**:
- `comparison.ts` — Core comparison logic: aggregation (within-run, across-runs), delta/ratio/status computation, `bigger_is_better` handling, zero-baseline and null-metric edge cases
- `selection.ts` — Renders the selection panel: per-side order/machine comboboxes, runs checkbox list, run/sample aggregation dropdowns, metric selector, noise threshold, test filter, hideNoise checkbox
- `table.ts` — Renders the comparison table: columns (Test, Value A/B, Delta, Delta %, Ratio, Status), sortable headers, color-coded status, noise de-emphasis, missing-test section, chart-zoom filtering
- `chart.ts` — Sorted ratio chart via Plotly: X=tests sorted by ratio, Y=log₂(ratio) on a **log₂ scale** with adaptive percentage tick labels (±1%, ±5%, ±50%, etc.) auto-selected from "nice" values to fit the data range, bar chart, noise band reference lines (converted to log₂ space), hover tooltips, zoom/drag-select that filters the table
- `combobox.ts` — Searchable dropdown widget used for order and machine selection, with typeahead filtering
- `state.ts` — URL state management: encode/decode all selection params (`order_a`, `machine_a`, `runs_a`, `run_agg_a`, etc.), `replaceState`-based URL sync
- `events.ts` — Custom event system for chart-table sync (`CHART_ZOOM`, `CHART_HOVER`, `TABLE_HOVER`, `SETTINGS_CHANGE`, `TEST_FILTER_CHANGE`)

**Data flow**: On load, fetches metric metadata (`GET test-suites/{ts}`) and all orders (`GET orders`, cursor-paginated). On order+machine change per side, fetches runs. On comparison trigger, fetches samples per run (`GET runs/{uuid}/samples`). All subsequent interactions (filter, sort, zoom) are client-side.

### 4.1 Refactoring Existing Modules

The existing Compare code is spread across `comparison.ts`, `selection.ts`, `table.ts`, `chart.ts`, `combobox.ts`, `state.ts`, and `events.ts`. These modules are well-structured and mostly decoupled from `main.ts`.

**Strategy**: The existing modules remain as-is (they are shared utilities), with adjustments to `selection.ts`, `chart.ts`, and `state.ts`:

**`state.ts` changes:**
- `setState()`, `setSideA()`, and `setSideB()` automatically call `replaceUrl()` after mutating state, so the URL always reflects the current UI state immediately — callers don't need to manage URL updates explicitly. All URL updates use `replaceState` (never `pushState`) so the browser Back button navigates between pages, not between individual setting changes within a page.
- `swapSides()` exchanges `sideA` and `sideB` in the global state and calls `replaceUrl()`. Used by the swap button in the selection panel.

**`selection.ts` changes:**
1. **Remove the Settings panel** (toggle button + token input) from `renderSelectionPanel()` — the SPA nav bar already provides the Settings panel with the API token input, so duplicating it on the Compare page is unnecessary. Also **remove the Compare button** — comparison is now auto-triggered via `tryAutoCompare()` whenever state is valid (both sides have runs + metric selected). `tryAutoCompare()` is called from: `createRunsPanel` (runs loaded or checkbox changed), metric select change, run agg change, sample agg change.
2. **Always select all runs by default** in `createRunsPanel()`: all available runs are checked by default. The only exception is URL state restoration: if the URL contains `runs_a` or `runs_b` UUIDs that match available runs, that selection is restored (allowing shared URLs to preserve a specific run subset). When no URL runs match (fresh load, order change), all runs are selected.
3. **Metric selector uses shared component**: Replace the inline `createMetricSelect()` with the shared `renderMetricSelector` from `components/metric-selector.ts` (with `placeholder: true`). The `getMetricFields()` function uses `filterMetricFields()` from the shared component to filter by `type === 'Real'` (consistent with all other pages). The `onChange` callback calls `setState({ metric })` then `tryAutoCompare()`.
4. **Swap sides button**: A circular button (⇄) between the two side panels in the `.sides-row`. Clicking it calls `swapSides()` from `state.ts`, re-renders the selection panel, and triggers `tryAutoCompare()`. This lets users quickly reverse the baseline/new direction.

**`chart.ts` changes:**
3. **Apply text filter to chart**: `drawChart()` reads `state.testFilter` and applies it as an additional filter on top of the chart zoom filter (`filterTests`). When both are active, their intersection is used. This ensures the chart only shows tests matching the text filter.
4. **Add `refreshChart()` export**: Redraws the chart using the last-used zoom filter (stored in module-scope `lastFilterTests`). Called by the compare page on `TEST_FILTER_CHANGE` and `SETTINGS_CHANGE` events to update the chart without losing the current zoom state.
5. **Remove `hideNoise` from `prepareChartData`**: Visibility is now controlled entirely by the compare page via `manuallyHidden`. The compare page passes only visible rows to the chart, so `prepareChartData` no longer needs to filter by noise status. The `hideNoise` parameter is removed.

**`table.ts` changes:**
6. **Interactive row toggling**: `renderTable` accepts an optional `TableOptions` with `hiddenTests: Set<string>`, `onToggle: (test) => void`, and `onIsolate: (test) => void`. Hidden rows are shown grayed out (not removed). Click/dblclick handlers on rows use a 200ms delay (same pattern as the Graph page's legend table) to distinguish single-click (toggle) from double-click (isolate). Double-clicking isolates among **currently-visible rows** (those matching the text filter), consistent with the Graph page's legend behavior. The internal `hideNoise` filtering is removed from `redraw()` — this is now handled by the compare page via `hiddenTests`.
7. **Table summary message**: `redraw()` adds a message div above the table showing counts: "N tests" (all visible), "M of N tests visible" (some hidden), or "M of N tests matching" (text filter or zoom active). Consistent with the Graph page's legend message.

**`chart.ts` changes (continued):**
8. **`preserveZoom` parameter on `renderChart`**: `renderChart(container, rows, preserveZoom?)` accepts an optional `preserveZoom` flag (default `false`). When `true`, the chart redraws with the last-used zoom filter (`lastFilterTests`) instead of resetting to `null`. Used by the compare page for all re-renders (settings changes, toggles, filters) so zoom is preserved.

**`pages/compare.ts` changes:**
9. **`manuallyHidden: Set<string>`** at module scope. The compare page manages visibility: toggle adds/removes from the set; isolate hides all others (or restores if the target is the only visible test). `hideNoise` is a separate filter applied on top — a test is hidden if it's in `manuallyHidden` OR (its status is 'noise' AND `state.hideNoise` is true). The two filters are independent: manual toggles persist across hideNoise changes. The effective hidden set is computed by `computeEffectiveHidden()` and passed to both the table (for graying out rows) and the chart (by filtering rows before passing them). All chart updates use `preserveZoom: true`.

**`combobox.ts` changes:**
10. **Order tags in dropdown**: `ComboboxContext` gains an `orderTags: Map<string, string | null>` field (built from `cachedOrders` in `selection.ts`). The order dropdown displays tags alongside values (e.g., "abc123 (release-18)") and the text filter matches against both the order value and the tag.
11. **Machine-filtered orders**: When a machine is selected but its orders haven't loaded yet (`machineOrders` is null), the dropdown shows "Loading orders..." instead of unfiltered results. On combobox creation, if a machine is pre-selected from URL state, `fetchMachineOrders` is called immediately so the dropdown is correctly filtered from the start.
12. **Per-side abort controllers**: `fetchMachineOrders` uses per-side abort controllers (`machineOrdersControllerA`/`B`) instead of a single shared one, so fetching orders for side B doesn't abort side A's in-flight request.
13. **Abort controllers in reset**: `resetComboboxState()` aborts in-flight `machineOrdersControllerA`/`B` and `machineSearchController` requests.

**File**: `lnt/server/ui/v5/frontend/src/pages/compare.ts`

The compare page module implements:
- `mount()`: Renders a page header (`<h2>Compare</h2>`), restores URL state, fetches fields/orders, renders selection panel, wires event listeners (`CHART_ZOOM`, `CHART_HOVER`, `TABLE_HOVER`, `SETTINGS_CHANGE`, `TEST_FILTER_CHANGE`), auto-compare via `tryAutoCompare()` in selection.ts. The chart container is initialized with a "No data to chart." message (consistent with the Graph page's empty state), which is replaced on the first comparison.
- `unmount()`: Removes event listeners, aborts fetches, clears sample cache and `manuallyHidden`, calls `destroyChart()` and `resetTable()`
- `doCompare()`: Checks sample cache, fetches only uncached runs, evicts stale cache entries, calls `recomputeFromCache()`
- `recomputeFromCache()`: Aggregates from cached samples, computes comparison, renders table and chart
- `renderTableAndChart()`: Computes effective hidden set (`manuallyHidden` + hideNoise filter), passes visible rows to chart with `preserveZoom: true`, passes full rows + toggle/isolate callbacks to table
- `computeEffectiveHidden()`: Unions `manuallyHidden` with noise tests when `state.hideNoise` is true

**Critical**: The `unmount()` function must:
- Abort in-flight fetch requests (via `AbortController`)
- Remove `document` event listeners (registered via `onCustomEvent()` which returns cleanup functions)
- Call `destroyChart()` from `chart.ts` (calls `Plotly.purge()` and clears module-level refs)
- Call `resetTable()` from `table.ts` (clears module-level container and row refs)

### 4.2 Geomean Summary Row

Add a computed geomean row to the comparison table showing aggregate values for both sides, their delta, and the ratio geomean.

**File**: `lnt/server/ui/v5/frontend/src/comparison.ts` (extend)

`computeGeomean(rows)` returns a `GeomeanResult` with:
- `geomeanA` / `geomeanB`: geometric mean of absolute values per side
- `delta`: `geomeanB - geomeanA`
- `deltaPct`: delta as percentage of geomeanA (null if geomeanA is 0)
- `ratioGeomean`: geometric mean of per-test ratios (the standard multiplicative average speedup)

Rows with `status === 'na'`, null ratios, or null values are excluded. Returns null if no valid rows exist.

**File**: `lnt/server/ui/v5/frontend/src/table.ts` (extend)

The geomean row is the first row of the tbody, showing all columns filled: Value A (geomeanA), Value B (geomeanB), Delta, Delta %, Ratio (ratioGeomean).

### 4.3 Pre-Selected Side A from URL

When navigating from Machine Detail or Run Detail to Compare with a pre-selected machine and order on side A, the URL will contain `?machine_a={name}&order_a={value}`.

This already works with the existing state management: `applyUrlState` in `state.ts` decodes `machine_a` and `order_a` from the URL and populates `state.sideA`. The selection panel renders with these values pre-filled. The user can then fill in side B and click Compare.

No additional code is needed beyond ensuring the linking pages generate the correct URL params.

### 4.4 Remove Old Compare Files

After Phase 4 is complete and verified:

1. Delete `v5_compare.html` (the old standalone template that extended `layout.html`)
2. Delete `static/comparison/` directory (the old standalone build output)
3. Remove the Compare link from the v4 navbar in `layout.html` — Compare is now only accessible via the v5 SPA

Note: The old `v5_compare` route was already removed during Phase 1 (SPA scaffolding) — the catch-all route in `views.py` now handles `/v5/{ts}/compare`.

### 4.5 Phase 4 Testing

**Tests for `computeGeomean`** (`__tests__/comparison.test.ts`):
- Returns null for empty rows, missing rows, na rows
- Computes correct ratio geomean, geomeanA, geomeanB, delta, deltaPct
- Ignores rows with null ratio or a_only/b_only
- Single row: geomean equals the values
- All ratios = 1.0: ratio geomean = 1.0, delta = 0

**Tests for Compare page module** (`__tests__/pages/compare.test.ts`):
- Mount loads fields and orders
- Shows error when fetch fails
- Renders selection panel after data loads
- Unmount cleans up without errors
- Unmount is safe before mount completes

**Tests for chart** (`__tests__/chart.test.ts`):
- `prepareChartData` filters, sorts, colors, customdata — updated to 2-parameter signature (no `hideNoise`)
- Noise rows included (visibility controlled by caller)
- `filterTests` combined with noise rows

**Tests for table** (`__tests__/table.test.ts`):
- Geomean row with A/B values, delta, and ratio
- No geomean row when no valid ratios
- Hidden rows rendered with `row-hidden` class
- All rows shown including noise when `hiddenTests` is empty
- `onToggle` called on single click with 200ms delay
- `onIsolate` called on double-click without triggering `onToggle`

**Tests for combobox** (`__tests__/combobox.test.ts`):
- Tags shown in dropdown items
- Filter matches by tag text and by order value
- Loading hint when machine set but orders not loaded
- `setSide` called with order value (not tag) on selection
- Tag shown in input after selection
- Tag shown in input on URL restore
- Plain value shown when order has no tag

---

## Phase 5: Stub Pages

**Goal**: Add placeholder pages for Regression List, Regression Detail, and Field Change Triage.

### 5.1 Stub Pattern

Each stub follows the same pattern:

```typescript
import type { PageModule, RouteParams } from '../router';
import { el } from '../utils';

export const regressionListPage: PageModule = {
  mount(container: HTMLElement, params: RouteParams): void {
    container.append(
      el('div', { class: 'page-placeholder' },
        el('h2', {}, 'Regression List'),
        el('p', {}, 'Not implemented yet.'),
        el('p', {},
          'This page will show detected regressions with filtering by state, ',
          'machine, test, and metric. Design coming in a later phase.'
        ),
      )
    );
  },
};
```

### 5.2 Stub Pages to Create

- `pages/regression-list.ts` — "Regression List: Not implemented yet."
- `pages/regression-detail.ts` — "Regression Detail: Not implemented yet." (reads `params.uuid` for display)
- `pages/field-change-triage.ts` — "Field Change Triage: Not implemented yet."

These were already registered in the router in Phase 1, so they are routable; they just show placeholder content.

### 5.3 Phase 5 Testing

No new unit tests needed beyond verifying the stubs render their placeholder text (covered by basic smoke tests in Phase 1).

---

## Phase 6: Admin Page

**Goal**: Implement the Admin page with API key management and schema viewer. The admin page is not test-suite specific — it is served at `/v5/admin`.

### 6.1 Flask Route

**File**: `lnt/server/ui/v5/views.py`

A new route `/v5/admin` serves the SPA shell with `g.testsuite_name = ''`. The template conditionally renders the title and v4 URL based on whether a testsuite is set.

### 6.2 SPA Bootstrap

**File**: `lnt/server/ui/v5/frontend/src/main.ts`

When `data-testsuite` is empty (admin-only context), the SPA sets `basePath = /v5` and only registers the admin route. The nav bar is still rendered with the full testsuites list.

**File**: `lnt/server/ui/v5/frontend/src/components/nav.ts`

The Admin link uses a regular `<a href="/v5/admin">` (not SPA router navigation) so it works from any testsuite context and navigates to the global admin page.

### 6.3 Admin Page Module

**File**: `lnt/server/ui/v5/frontend/src/pages/admin.ts`

The Admin page has three tabs: API Keys, Test Suites, and Create Suite. The page reads `data-testsuites` from the HTML root element to get the list of available test suites. A shared `activateTab()` helper manages the active tab state.

- **API Keys tab** (default): Lists keys, create key form, revoke buttons.
- **Test Suites tab**: Suite selector dropdown, schema viewer (metrics + field tables), delete suite with double confirmation.
- **Create Suite tab**: Name input + JSON textarea. On success, switches to the Test Suites tab with the new suite selected.

### 6.2 API Keys Tab

Shows a table of existing API keys with columns: Prefix, Name, Scope, Created, Last Used, Active. Provides a "Create Key" form (name + scope select) and a "Revoke" button per active key. Created tokens display with a copy-to-clipboard button. Auth errors (401/403) show "Admin token required. Set your token in Settings."

API calls: `GET/POST/DELETE /api/v5/admin/api-keys` (require `admin` scope).

API functions in `api.ts`: `getApiKeys()`, `createApiKey(name, scope)`, `revokeApiKey(prefix)`.

### 6.4 Test Suites Tab

Displays the test suite schema definition and field metadata with a suite selector, plus delete functionality:

**Suite selector + viewer**:
- A dropdown populated from `data-testsuites` lets the user switch between test suites
- Calls `getTestSuiteInfo(ts)` for the selected suite
- Shows metrics table: Name, Type, Display Name, Unit, Bigger is Better
- Shows order fields, machine fields, and run fields tables

**Delete suite**:
- A "Delete This Suite" button below the schema viewer for the currently selected suite
- Clicking it reveals an inline confirmation panel with:
  - Warning text: "Deleting test suite '{name}' will permanently destroy all machines, runs, orders, samples, regressions, and field changes. This cannot be undone."
  - A text input where the user must type the exact suite name
  - A red "Delete permanently" button, disabled until the typed name matches
- Calls `deleteTestSuite(name)` — wraps `DELETE /api/v5/test-suites/{name}?confirm=true`
- On success: refreshes the suite list, selects the first remaining suite
- Requires `manage` scope; shows auth error on 401/403

### 6.5 Create Suite Tab

A standalone tab for creating new test suites:
- Name input for the suite name
- JSON textarea for the full schema definition (format_version, metrics, run_fields, machine_fields)
- The name input value overrides `name` in the JSON; `format_version` defaults to `"2"` if not set
- Calls `createTestSuite(payload)` — wraps `POST /api/v5/test-suites`
- On success: adds the suite to the local list and switches to the Test Suites tab with the new suite auto-selected
- Requires `manage` scope; shows auth error on 401/403

**API functions** in `api.ts`:
```typescript
createTestSuite(payload: object, signal?): Promise<TestSuiteInfo>
deleteTestSuite(name: string, signal?): Promise<void>
```

### 6.6 Phase 6 Testing

**Tests for admin page** (`__tests__/pages/admin.test.ts`):
- Tab bar renders API Keys, Test Suites, and Create Suite tabs
- List keys renders table
- Create key form present
- 401/403 error shows auth message
- Revoke button only shown for active keys
- Suite selector with all suites, loads first suite automatically
- Schema renders metrics and field tables
- Create Suite tab shows name input and JSON textarea
- Delete suite shows confirmation with name-match input
- Delete button disabled until name matches

---

## Cross-Cutting Concerns

### URL State Management Pattern

Each page manages its own URL state independently. The pattern:

1. **On mount**: Parse `window.location.search` to restore page-specific state
2. **On user interaction**: Update state, call `replaceState` (for filter/sort changes) or `pushState` (for navigation-like changes)
3. **On popstate**: Re-parse URL and update the page

The existing `state.ts` module handles Compare-specific state. Other pages should NOT use the global `state.ts` — instead, each page manages its own local state with its own URL param names. This avoids conflicts.

**Recommended pattern for new pages**:

```typescript
// Each page defines its own state interface and encode/decode functions
interface PageState { ... }

function decodePageState(search: string): PageState { ... }
function encodePageState(state: PageState): string { ... }

// On mount:
const state = decodePageState(window.location.search);

// On state change:
const qs = encodePageState(state);
window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
```

### Error Handling and Loading States

Every page should follow this pattern:

1. **Loading**: Show "Loading..." text or a progress indicator while fetching data
2. **Error**: Catch API errors and display them using an inline error banner (e.g., a `div` with class `error-banner`)
3. **Empty state**: If the API returns empty results, show a meaningful message (e.g., "No machines found" rather than an empty table)

Progress and error feedback is handled per-page using simple DOM containers (a `span.progress-label` for loading messages, a `div.error-banner` for errors), following the same pattern as the Graph page.

### v4 Layout Toggle

The v5 SPA is a standalone page (does not extend `layout.html`). The v5 nav bar includes a "v4 UI" link pointing to the v4 recent activity page for the current test suite.

To add a "v5 UI" link in the v4 layout:

**File**: `lnt/server/ui/templates/layout.html` (modify)

In the test suite dropdown menu, add a link to the v5 UI:

```html
<li><a href="/v5/{{ g.testsuite_name }}/">v5 UI</a></li>
```

This should be added near the existing "Compare" link in the suite dropdown.

### Static Asset Serving

The v5 SPA assets are served from the Flask blueprint's static folder:
- CSS: `/v5/static/v5/v5.css`
- JS: `/v5/static/v5/v5.js`
- Source maps: `/v5/static/v5/v5.js.map`

The `v5_app.html` template references these via `url_for('lnt_v5.static', ...)`.

After each build (`npm run build`), the compiled assets appear in `lnt/server/ui/v5/static/v5/`. These should be committed to the repository (same pattern as the current `static/comparison/` directory).

### Navigation Between Pages

All internal links must use the `spaLink()` utility (defined in section 1.8) instead of raw `<a href="...">` tags. This ensures SPA navigation without full page reloads. Every page module should import `spaLink` from `utils.ts` and use it for all links to other v5 pages.

```typescript
// Usage in any page module:
import { spaLink } from '../utils';

const machineLink = spaLink(machineName, `/machines/${encodeURIComponent(machineName)}`);
```

---

## Testing Strategy

### Unit Test Coverage Per Phase

| Phase | Test Files | What to Test |
|-------|-----------|-------------|
| 1 | `router.test.ts`, `nav.test.ts` | Route matching, navigation, nav rendering, active link |
| 2 | `api.test.ts` (extend), `data-table.test.ts`, `pagination.test.ts`, `order-search.test.ts`, `pages/dashboard.test.ts`, `pages/machine-list.test.ts`, `pages/machine-detail.test.ts`, `pages/run-detail.test.ts`, `pages/order-detail.test.ts` | API function signatures and URL construction, component rendering, page mount/data flow |
| 3 | `time-series-chart.test.ts`, `pages/graph.test.ts` | Pure function tests (buildTraces, computeActiveTests, buildRefsFromCache, setsEqual), mount-level tests (controls, URL state, metrics, error handling) |
| 4 | `comparison.test.ts` (extend), `pages/compare.test.ts` | Geomean computation, SPA integration, unmount cleanup |
| 5 | (minimal) | Stub rendering |
| 6 | `pages/admin.test.ts` | API key CRUD, schema display, auth error handling |

### Testing Patterns

All tests use Vitest (already configured). DOM tests use `@vitest-environment jsdom`.

**API tests**: Mock `fetch` globally (same pattern as existing `api.test.ts`). Verify URL construction, param encoding, error handling.

**Component tests**: Create a container div, call the render function, assert on DOM structure.

**Page tests**: Mock API functions, call `page.mount(container, params)`, assert on rendered DOM and API call arguments.

### Manual Verification Checklist (Per Phase)

1. Build: `cd lnt/server/ui/v5/frontend && npm run build`
2. Tests: `npm test`
3. Start server: `lnt runserver`
4. Navigate to `http://localhost:8000/v5/{ts}/`
5. Verify all pages load without console errors
6. Verify SPA navigation (no full page reloads)
7. Verify browser back/forward
8. Verify direct URL access (bookmark)
9. Verify v4 UI is unaffected
10. Verify v4 <-> v5 toggle links

---

## File Summary

### New Files

```
lnt/server/ui/v5/templates/v5_app.html
lnt/server/ui/v5/frontend/src/router.ts
lnt/server/ui/v5/frontend/src/components/nav.ts
lnt/server/ui/v5/frontend/src/components/data-table.ts
lnt/server/ui/v5/frontend/src/components/pagination.ts
lnt/server/ui/v5/frontend/src/components/order-search.ts
lnt/server/ui/v5/frontend/src/components/machine-combobox.ts
lnt/server/ui/v5/frontend/src/components/time-series-chart.ts
lnt/server/ui/v5/frontend/src/pages/dashboard.ts
lnt/server/ui/v5/frontend/src/pages/machine-list.ts
lnt/server/ui/v5/frontend/src/pages/machine-detail.ts
lnt/server/ui/v5/frontend/src/pages/run-detail.ts
lnt/server/ui/v5/frontend/src/pages/order-detail.ts
lnt/server/ui/v5/frontend/src/pages/graph.ts
lnt/server/ui/v5/frontend/src/pages/compare.ts
lnt/server/ui/v5/frontend/src/pages/regression-list.ts
lnt/server/ui/v5/frontend/src/pages/regression-detail.ts
lnt/server/ui/v5/frontend/src/pages/field-change-triage.ts
lnt/server/ui/v5/frontend/src/pages/admin.ts
lnt/server/ui/v5/frontend/src/__tests__/router.test.ts
lnt/server/ui/v5/frontend/src/__tests__/nav.test.ts
lnt/server/ui/v5/frontend/src/__tests__/data-table.test.ts
lnt/server/ui/v5/frontend/src/__tests__/pagination.test.ts
lnt/server/ui/v5/frontend/src/__tests__/order-search.test.ts
lnt/server/ui/v5/frontend/src/__tests__/machine-combobox.test.ts
lnt/server/ui/v5/frontend/src/__tests__/time-series-chart.test.ts
lnt/server/ui/v5/frontend/src/__tests__/pages/dashboard.test.ts
lnt/server/ui/v5/frontend/src/__tests__/pages/machine-list.test.ts
lnt/server/ui/v5/frontend/src/__tests__/pages/machine-detail.test.ts
lnt/server/ui/v5/frontend/src/__tests__/pages/run-detail.test.ts
lnt/server/ui/v5/frontend/src/__tests__/pages/order-detail.test.ts
lnt/server/ui/v5/frontend/src/__tests__/pages/graph.test.ts
lnt/server/ui/v5/frontend/src/__tests__/pages/compare.test.ts
lnt/server/ui/v5/frontend/src/__tests__/pages/admin.test.ts
```

### Modified Files

```
lnt/server/ui/v5/frontend/vite.config.ts          — Output v5.js/v5.css
lnt/server/ui/v5/frontend/src/main.ts             — SPA bootstrap
lnt/server/ui/v5/frontend/src/api.ts              — New API functions
lnt/server/ui/v5/frontend/src/types.ts            — New interfaces
lnt/server/ui/v5/frontend/src/utils.ts            — spaLink helper
lnt/server/ui/v5/frontend/src/comparison.ts       — computeGeomean (GeomeanResult with A/B values)
lnt/server/ui/v5/frontend/src/table.ts            — Geomean row, row toggling, summary message, resetTable()
lnt/server/ui/v5/frontend/src/chart.ts            — Text filter, destroyChart(), preserveZoom, removed hideNoise
lnt/server/ui/v5/frontend/src/selection.ts        — Removed Settings panel and Compare button, auto-select runs, tryAutoCompare(), swap sides button
lnt/server/ui/v5/frontend/src/state.ts           — swapSides() function
lnt/server/ui/v5/frontend/src/combobox.ts         — Order tags, machine filtering, per-side abort controllers
lnt/server/ui/v5/frontend/src/style.css           — Nav bar + new page styles, row-hidden, table-message
lnt/server/ui/v5/views.py                         — Catch-all route
lnt/server/ui/templates/layout.html               — v5 UI link in v4 nav, removed Compare link
lnt/server/ui/templates/layout.html               — v5 UI link in v4 nav, nonav support
lnt/server/ui/v5/templates/v5_app.html             — Standalone SPA shell (does not extend layout.html)
lnt/server/ui/v5/frontend/src/__tests__/api.test.ts       — Tests for new API functions
lnt/server/ui/v5/frontend/src/__tests__/comparison.test.ts — Tests for geomean
```

### Deleted Files (after Phase 4)

```
lnt/server/ui/v5/templates/v5_compare.html        — Replaced by v5_app.html
lnt/server/ui/v5/static/comparison/               — Replaced by static/v5/
lnt/server/ui/v5/frontend/src/feedback.ts         — Progress/error now handled per-page with simple DOM containers
```
