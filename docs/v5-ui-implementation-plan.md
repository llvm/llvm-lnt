# v5 Web UI Redesign — Implementation Plan

This document is a step-by-step implementation plan for the v5 Web UI redesign described in `docs/design/ui/` (see `docs/design/README.md` for the full document map). Each phase includes the exact file changes, new modules, API function signatures, type definitions, and testing strategy needed for a developer to execute independently.

## Prerequisite Reading

Before starting, read:
- `docs/design/ui/` — the high-level design (see `docs/design/README.md` for the full document map)
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
     data-v4-url="{{ url_for('lnt.index') }}">
</div>
<script src="{{ url_for('lnt_v5.static', filename='v5/v5.js') }}"></script>
</body>
</html>
```

The `data-testsuites` attribute provides the list of available test suite names (for the suite selector in the nav bar). The `data-v4-url` attribute provides the v4 URL for the toggle link.

**Note on `| tojson | forceescape`**: Flask's `tojson` returns a `Markup` object (marked HTML-safe), so Jinja2's `| e` filter is a no-op on it. Using `| forceescape` ensures the JSON double-quotes are escaped to `&quot;` inside the HTML attribute. Without this, the raw `"` in the JSON would terminate the attribute and break `JSON.parse()` at runtime.

### 1.4 Flask Backend Changes

**File**: `lnt/server/ui/v5/views.py`

Two view functions serve the SPA shell. Pages are split into **suite-scoped** (browsing data within a test suite) and **suite-agnostic** (analysis tools and admin that manage suite selection internally).

```python
from flask import g, render_template, request

from . import v5_frontend, _setup_testsuite
from lnt.server.ui.views import ts_data
from lnt.server.ui.decorators import _make_db_session


@v5_frontend.route("/v5/", strict_slashes=False)
@v5_frontend.route("/v5/test-suites", strict_slashes=False)
@v5_frontend.route("/v5/admin", strict_slashes=False)
@v5_frontend.route("/v5/graph", strict_slashes=False)
@v5_frontend.route("/v5/compare", strict_slashes=False)
def v5_global():
    """Suite-agnostic pages (dashboard, test suites, admin, graph, compare).

    Serves the SPA shell with an empty testsuite. Each page manages
    suite selection internally via its own UI controls. The list of
    available test suites is provided via data-testsuites.
    """
    g.testsuite_name = ''
    _make_db_session(None)
    try:
        db = request.get_db()
        return render_template("v5_app.html",
                               testsuites=sorted(db.testsuite.keys()))
    finally:
        request.session.close()


@v5_frontend.route("/v5/<testsuite_name>/")
@v5_frontend.route("/v5/<testsuite_name>/<path:subpath>")
def v5_app(testsuite_name, subpath=None):
    """Catch-all route for the v5 SPA.

    All suite-scoped client-side routes (dashboard, machines, regressions,
    etc.) hit this single endpoint, which serves the SPA shell. The
    TypeScript router handles the rest.
    """
    _setup_testsuite(testsuite_name)
    try:
        ts = request.get_testsuite()
        data = ts_data(ts)
        db = request.get_db()
        data['testsuites'] = sorted(db.testsuite.keys())
        return render_template("v5_app.html", **data)
    finally:
        request.session.close()
```

**Key design decision**: Graph and Compare are suite-agnostic (`/v5/graph`, `/v5/compare`) rather than suite-scoped (`/v5/{ts}/graph`, `/v5/{ts}/compare`). This is because:
- The Graph page has its own suite `<select>` dropdown and reads the suite from `?suite=...` URL params.
- The Compare page has independent suite selectors per side (side A and side B can compare across different test suites), reading from `?suite_a=...` and `?suite_b=...` URL params.
- Both pages use `getTestsuites()` from the router to populate their suite dropdowns.

The `v5_global()` function sets `g.testsuite_name = ''` and does not call `_setup_testsuite()` (no test suite context is needed). The template receives the `testsuites` list but no `old_config` or `ts_data` — the SPA template handles the empty-testsuite case.

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
let basePath = ''; // e.g. "/v5/nts" (suite context) or "/v5" (agnostic context)
let onAfterResolve: ((routePath: string) => void) | null = null;
let routerTestsuite = '';
let routerTestsuites: string[] = [];

/**
 * Return the list of available test suites.
 * Populated from data-testsuites on the SPA shell.
 */
export function getTestsuites(): string[] {
  return routerTestsuites;
}

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
 * @param tsBasePath The base path, e.g. "/v5/nts" or "/v5"
 * @param afterResolve Optional callback after each route resolution (for nav highlighting)
 * @param context Testsuite context from the SPA shell — { testsuite, testsuites }
 */
export function initRouter(
  container: HTMLElement,
  tsBasePath: string,
  afterResolve?: (routePath: string) => void,
  context?: { testsuite: string; testsuites: string[] },
): void {
  appContainer = container;
  basePath = tsBasePath;
  onAfterResolve = afterResolve || null;
  routerTestsuite = context?.testsuite ?? '';
  routerTestsuites = context?.testsuites ?? [];

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
        testsuite: routerTestsuite,
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

Routes are split into two contexts based on whether a test suite is set in the SPA shell's `data-testsuite` attribute:

**Suite-scoped context** (`basePath = /v5/{ts}`):

| Pattern | Page Module |
|---------|-------------|
| `/` | `pages/dashboard` |
| `/machines` | `pages/machine-list` |
| `/machines/:name` | `pages/machine-detail` |
| `/runs/:uuid` | `pages/run-detail` |
| `/orders/:value` | `pages/order-detail` |
| `/regressions/:uuid` | `pages/regression-detail` |
| `/field-changes` | `pages/field-change-triage` |

**Suite-agnostic context** (`basePath = /v5`):

| Pattern | Page Module |
|---------|-------------|
| `/` | `pages/home` |
| `/test-suites` | `pages/test-suites` |
| `/graph` | `pages/graph` |
| `/compare` | `pages/compare` |
| `/admin` | `pages/admin` |

Graph and Compare manage suite selection internally (Graph has a single suite `<select>`, Compare has per-side suite selects). Admin is not suite-specific. Home and Test Suites are placeholders.

### 1.6 Navigation Bar Component

**File**: `lnt/server/ui/v5/frontend/src/components/nav.ts`

Renders a persistent navigation bar above the page content. The nav bar is rendered once by `main.ts` and is not re-rendered on route changes; instead, the active link is updated.

All navbar links are suite-agnostic. The behavior depends on the page context:

- **Suite-agnostic context** (`data-testsuite` is empty): All navbar links use SPA navigation via `navigate()`. The API link opens in a new tab. The v4 UI link is external.
- **Suite-scoped context** (`data-testsuite` is set): All navbar links use full-page navigation (since they target `/v5/...` which is outside the suite basePath `/v5/{ts}`).

```typescript
// components/nav.ts — Navigation bar

import { el, isModifiedClick } from '../utils';
import { navigate } from '../router';

export interface NavConfig {
  testsuite: string;
  v4Url: string;
  urlBase: string; // lnt_url_base
}
```

**`buildNavLink(link, agnosticBase, config)` helper:** A shared function that constructs a nav link `<a>` element with the dual-mode behavior. It builds the href from `agnosticBase + link.path`, appends `?suiteParam={ts}` when in suite context, sets `data-path`, and attaches a SPA click handler only in suite-agnostic context. Used for all standard links (Test Suites, Graph, Compare) and the Admin link.

**Link table:**

Left-side links:
| Label | Path | data-path | Notes |
|-------|------|-----------|-------|
| LNT (brand) | `{urlBase}/v5/` | — | Dashboard. SPA `navigate('/')` in agnostic context, full-page nav in suite context. |
| Test Suites | `{urlBase}/v5/test-suites` | `/test-suites` | SPA or full-page depending on context. |
| Graph | `{urlBase}/v5/graph` | `/graph` | In suite context, appends `?suite={ts}`. |
| Compare | `{urlBase}/v5/compare` | `/compare` | In suite context, appends `?suite_a={ts}`. |
| API | `/api/v5/openapi/swagger-ui` | — | Always opens in new tab (`target="_blank"`). No SPA navigation. |

Right-side links:
| Label | Path | data-path | Notes |
|-------|------|-----------|-------|
| v4 UI | `config.v4Url` | — | External link, no SPA nav. |
| Admin | `{urlBase}/v5/admin` | `/admin` | SPA or full-page depending on context. |
| Settings | `#` | — | Toggle panel (unchanged). |

**`updateActiveNavLink(currentPath)`**: Queries `.v5-nav-link[data-path]` elements and highlights the one matching the current route path (exact match for specific paths, prefix match for sub-paths). The LNT brand has no `data-path`, so the home page (`/`) has no highlighted nav link.

**Removed**: `removeSuiteFromNav()` and `addSuiteToNav()` — the navbar no longer has a suite dropdown.

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
import { homePage } from './pages/home';
import { testSuitesPage } from './pages/test-suites';
import { machineDetailPage } from './pages/machine-detail';
import { runDetailPage } from './pages/run-detail';
import { orderDetailPage } from './pages/order-detail';
import { graphPage } from './pages/graph';
import { comparePage } from './pages/compare';
import { regressionDetailPage } from './pages/regression-detail';
import { fieldChangeTriagePage } from './pages/field-change-triage';
import { adminPage } from './pages/admin';

declare const lnt_url_base: string;

function init(): void {
  const root = document.getElementById('v5-app');
  if (!root) return;

  const testsuite = root.getAttribute('data-testsuite') || '';
  const testsuites: string[] = JSON.parse(
    root.getAttribute('data-testsuites') || '[]'
  );
  const v4Url = root.getAttribute('data-v4-url') || '#';

  // Set API base from global set in v5_app.html
  const urlBase = typeof lnt_url_base !== 'undefined' ? lnt_url_base : '';
  setApiBase(urlBase);

  // Render nav bar (persistent across route changes)
  const nav = renderNav({ testsuite, v4Url, urlBase });
  root.append(nav);

  // Page content container
  const pageContainer = el('div', { id: 'v5-page' });
  root.append(pageContainer);

  if (testsuite) {
    // Suite-scoped pages — detail views within a single test suite.
    // The suite root redirects to the Test Suites page with suite pre-selected.
    const suiteRedirectPage: PageModule = {
      mount(): void {
        window.location.replace(`${urlBase}/v5/test-suites?suite=${encodeURIComponent(testsuite)}`);
      },
    };
    addRoute('/', suiteRedirectPage);
    addRoute('/machines/:name', machineDetailPage);
    addRoute('/runs/:uuid', runDetailPage);
    addRoute('/orders/:value', orderDetailPage);
    addRoute('/regressions/:uuid', regressionDetailPage);
    addRoute('/field-changes', fieldChangeTriagePage);

    const basePath = `${urlBase}/v5/${encodeURIComponent(testsuite)}`;
    initRouter(pageContainer, basePath, updateActiveNavLink, { testsuite, testsuites });
  } else {
    // Suite-agnostic pages — dashboard, test suites, analysis tools, admin
    addRoute('/', homePage);
    addRoute('/test-suites', testSuitesPage);
    addRoute('/admin', adminPage);
    addRoute('/graph', graphPage);
    addRoute('/compare', comparePage);

    const basePath = `${urlBase}/v5`;
    initRouter(pageContainer, basePath, updateActiveNavLink, { testsuite: '', testsuites });
  }
}

// Start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
```

**Key design decision**: Graph, Compare, Admin, Dashboard (home), and Test Suites are registered in the **suite-agnostic** `else` branch (when `data-testsuite` is empty), with `basePath = /v5`. Suite-scoped pages (suite root, Machines, Regressions, etc.) are registered in the `if (testsuite)` branch with `basePath = /v5/{ts}`. This split means all navbar-linked pages live at `/v5/...` — suite-scoped pages are only reachable via links within page content.

**During Phase 1**, most page modules will be stubs (see section 1.8). Only the router, nav, and skeleton need to work.

### 1.8 SPA Link Utility

**File**: `lnt/server/ui/v5/frontend/src/utils.ts` (extend)

Add a `spaLink` helper that all page modules use for internal navigation. This ensures links use the SPA router instead of triggering full page reloads. Modified clicks (Cmd+Click, Ctrl+Click, Shift+Click, middle-click) bypass the SPA router and let the browser handle them natively (e.g. open in a new tab), since the `href` is set to the real URL.

```typescript
import { navigate, getBasePath } from './router';

/** Return true when the click should be handled by the browser (new tab, etc.). */
export function isModifiedClick(e: MouseEvent): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
}

/**
 * Create an anchor element that navigates via the SPA router.
 * All internal links across all pages should use this helper.
 */
export function spaLink(text: string, path: string): HTMLAnchorElement {
  const a = el('a', { href: getBasePath() + path, class: 'spa-link' }, text);
  a.addEventListener('click', (e) => {
    if (isModifiedClick(e)) return;
    e.preventDefault();
    navigate(path);
  });
  return a;
}
```

The same `isModifiedClick` check is used in the nav bar component (`components/nav.ts`) for brand and navigation links. Nav links also use real `href` values (via `getBasePath() + link.path`) instead of `href="#"` so that Cmd+Click opens the correct page in a new tab.

### 1.9 Stub Page Modules for Phase 1

During Phase 1, create minimal stub modules for every page. Each follows the `PageModule` interface.

**File pattern**: `lnt/server/ui/v5/frontend/src/pages/<name>.ts`

Example stub (`pages/home.ts`):

```typescript
import type { PageModule, RouteParams } from '../router';
import { el } from '../utils';

export const homePage: PageModule = {
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

Create identical stubs for all pages: `home.ts` (suite-agnostic dashboard placeholder), `machine-detail.ts`, `run-detail.ts`, `order-detail.ts`, `graph.ts`, `compare.ts`, `regression-list.ts`, `regression-detail.ts`, `field-change-triage.ts`, `admin.ts`. The `test-suites.ts` page is fully implemented in Phase 2.

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
- `basePath` stripping works correctly for both `/v5/nts` and `/v5`
- Trailing slash normalization
- `RouteParams.testsuite` derived from `context` parameter (not from basePath parsing)
- `getTestsuites()` returns the list from context

**Unit tests for `components/nav.ts`** (`__tests__/nav.test.ts`):

Suite-agnostic context (`testsuite: ''`):
- Renders left-side links: Test Suites, Graph, Compare (no Dashboard, Regressions, Machines)
- Renders API link with `target="_blank"` and correct Swagger UI href
- Renders right-side links: v4 UI, Admin, Settings
- LNT brand renders with href `/v5/`
- No suite selector dropdown rendered
- Clicking nav links calls `navigate()` with correct paths
- Clicking API link does NOT call `navigate()` (external, new tab)
- Modifier clicks (Cmd+Click, Ctrl+Click) bypass SPA navigation
- Nav links include `urlBase` prefix when set

Suite-scoped context (`testsuite: 'nts'`):
- Same links rendered (navbar looks identical)
- Brand href is `/v5/` (not suite-scoped)
- No nav link calls `navigate()` (all use full-page navigation)
- Graph link href includes `?suite=nts`, Compare includes `?suite_a=nts`

`updateActiveNavLink`:
- Highlights correct link for `/test-suites`, `/graph`, `/compare`, `/admin`
- No link highlighted for root `/` (brand has no `data-path`)
- Clears previous highlight when path changes

**Backend tests** (`tests/server/ui/v5/test_spa_shell.py`):
- `/v5/` returns 200 with `data-testsuite=""`
- `/v5` (no trailing slash) returns 200 or redirects
- `/v5/test-suites` returns 200 with `data-testsuite=""`
- `/v5/test-suites/` (trailing slash) works
- `/v5/nts/` still returns 200 with `data-testsuite="nts"` (no conflict with `/v5/` route)
- `data-v4-url` does not contain `recent_activity` (points to v4 root)

**Manual verification**:
1. Run `cd lnt/server/ui/v5/frontend && npm run build`
2. Start dev server: `lnt runserver`
3. Navigate to `http://localhost:8000/v5/` — should see nav bar + Dashboard placeholder
4. Click Test Suites — SPA navigation to placeholder page
5. Click Graph, Compare — SPA navigation to each page
6. Click API — opens Swagger UI in new tab
7. Navigate to `http://localhost:8000/v5/nts/machines` — same nav bar, all links use full-page navigation
8. From suite-scoped page, click Graph — navigates to `/v5/graph?suite=nts`
9. Browser back/forward works
10. Direct URL access (`/v5/`, `/v5/test-suites`, `/v5/graph`, `/v5/admin`, `/v5/nts/machines`) all work
11. v4 UI link navigates to v4 root page

---

## Phase 2: Core Browsing Pages

**Goal**: Implement the Test Suites page (suite picker + tabbed browsing), Machine Detail, Run Detail, Order Detail, and Dashboard (sparkline trend overview).

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

A search input for navigating to an order by value or tag. Used by Order Detail (for jumping to an arbitrary order) and later by Graph (for adding baselines).

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

### 2.3 Test Suites Page

**File**: `lnt/server/ui/v5/frontend/src/pages/test-suites.ts`

The primary entry point for browsing test suite data. Suite-agnostic page at `/v5/test-suites` with an internal suite picker and tabbed content.

**Suite picker**: A row of prominent card/button elements (`.suite-card`), one per test suite. List populated from `getTestsuites()` (router utility, reads `data-testsuites`). Clicking a card selects it (`.suite-card-active`), shows the tab bar, and loads the default tab (Recent Activity). When no suite is selected, only the suite picker is visible.

**Tab bar**: Reuses `.v5-tab-bar` / `.v5-tab` / `.v5-tab-active` CSS classes (shared with Admin page). Four tabs: Recent Activity (default), Machines, Runs, Orders.

**URL state**: `?suite={ts}&tab=machines&search=foo&offset=0` — all browsing state in query params. On mount, reads params to restore state. On every change (suite pick, tab switch, search, pagination), updates URL via `history.replaceState`.

**Tab content:**

- **Recent Activity tab** (default): Shows the last 25 runs sorted by `-start_time`. No search/filter — a quick-glance activity feed. Uses `getRunsPage(ts, { sort: '-start_time', limit: 25 })`. Columns: Machine, Order (primary value), Start Time, UUID (truncated, linked). "Load more" button fetches the next page via cursor.

- **Machines tab**: Search by name (`name_contains`), offset pagination with "X–Y of Z" range. Uses `getMachines(ts, { nameContains, limit: 25, offset })`. Columns: Name (linked), Info (key-value summary).

- **Runs tab**: Filter by machine name (exact match via `machine` param), cursor pagination (Previous/Next), sorted by `-start_time`. Uses `getRunsPage(ts, { machine, sort: '-start_time', limit: 25, cursor })`. Columns: UUID (truncated, linked), Machine, Order (primary value), Start Time.

- **Orders tab**: Filter by tag prefix (`tag_prefix`), cursor pagination. Uses `getOrdersPage(ts, { tagPrefix, limit: 25, cursor })`. Columns: Order Value (primary field, linked), Tag.

**Detail navigation**: All detail links (machine names, run UUIDs, order values) use `<a href=...>` targeting suite-scoped URLs (e.g., `/v5/{suite}/machines/{name}`). These are full page navigations (crossing from suite-agnostic to suite-scoped context).

**Cursor pagination UX**: A stack of cursors is maintained per tab. "Next" pushes the current cursor and fetches with `nextCursor`. "Previous" pops the stack and re-fetches. The stack is reset on search/filter changes.

**New API functions** (in `api.ts`):

```typescript
/** Fetch one page of runs with optional filters. */
export async function getRunsPage(
  ts: string,
  opts?: { machine?: string; sort?: string; limit?: number; cursor?: string },
  signal?: AbortSignal,
): Promise<CursorPageResult<RunInfo>> {
  const params: Record<string, string> = {};
  if (opts?.machine) params.machine = opts.machine;
  if (opts?.sort) params.sort = opts.sort;
  if (opts?.limit !== undefined) params.limit = String(opts.limit);
  if (opts?.cursor) params.cursor = opts.cursor;
  return fetchOneCursorPage<RunInfo>(apiUrl(ts, 'runs'), params, signal);
}

/** Fetch one page of orders with optional tag_prefix filter. */
export async function getOrdersPage(
  ts: string,
  opts?: { tagPrefix?: string; limit?: number; cursor?: string },
  signal?: AbortSignal,
): Promise<CursorPageResult<OrderSummary>> {
  const params: Record<string, string> = {};
  if (opts?.tagPrefix) params.tag_prefix = opts.tagPrefix;
  if (opts?.limit !== undefined) params.limit = String(opts.limit);
  if (opts?.cursor) params.cursor = opts.cursor;
  return fetchOneCursorPage<OrderSummary>(apiUrl(ts, 'orders'), params, signal);
}
```

**CSS additions** (in `style.css`):

```css
/* Suite picker cards */
.suite-picker { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 20px; }
.suite-card { padding: 12px 24px; border: 2px solid #dee2e6; border-radius: 6px;
  background: #f8f9fa; cursor: pointer; font-size: 15px; font-weight: 600; color: #333; }
.suite-card:hover { border-color: #0d6efd; background: #e7f1ff; }
.suite-card-active { border-color: #0d6efd; background: #0d6efd; color: #fff; }
```

**Suite root redirect**: In `main.ts`, the suite-scoped root route (`/`) uses a redirect page module that navigates to `/v5/test-suites?suite={ts}` via `window.location.replace()`.

**Nav bar update** (in `nav.ts`): Add `suiteParam: 'suite'` to the Test Suites nav link so that navigating from a suite-scoped detail page preserves suite context.

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
- Action links: "Graph for this machine" (links to `/v5/graph?suite={ts}&machine={name}`), "Compare" (links to `/v5/compare?suite_a={ts}&machine_a={name}`)
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
- Action links: "Compare with..." button (navigates to `/v5/compare?suite_a={ts}&machine_a={machine}&order_a={orderValue}`)
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

- **test-suites.test.ts**: Verify suite picker renders cards, tabs appear after suite selection, Recent Activity loads recent runs, Machines tab shows search + offset pagination, Runs tab shows cursor pagination, Orders tab shows cursor pagination, query param state restoration
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

### 2.10 Dashboard Page

**Goal**: Replace the `home.ts` stub with a full Dashboard showing sparkline trend charts for every test suite and metric.

#### 2.10.1 API Changes

**File**: `lnt/server/ui/v5/frontend/src/api.ts`

Add a `fetchTrends` function that calls the server-side geomean aggregation endpoint:

```typescript
// TODO: update frontend code to match (api.ts still uses old field names)
export interface TrendsDataPoint {
  machine: string;
  commit: string;
  ordinal: number | null;
  submitted_at: string | null;
  value: number;
}

export async function fetchTrends(
  ts: string,
  opts: { metric: string; machine?: string[]; afterTime?: string; beforeTime?: string },
  signal?: AbortSignal,
): Promise<TrendsDataPoint[]> {
  const body: Record<string, unknown> = { metric: opts.metric };
  if (opts.machine?.length) body.machine = opts.machine;
  if (opts.afterTime) body.after_time = opts.afterTime;
  if (opts.beforeTime) body.before_time = opts.beforeTime;
  const data = await fetchJson<{ metric: string; items: TrendsDataPoint[] }>(
    apiUrl(ts, 'trends'), { method: 'POST', body, signal });
  return data.items;
}
```

#### 2.10.2 Shared Geomean Utility

**File**: `lnt/server/ui/v5/frontend/src/utils.ts`

```typescript
/** Geometric mean of positive values. Returns null if no valid (> 0) values. */
export function geomean(values: number[]): number | null {
  const valid = values.filter(v => v > 0);
  if (valid.length === 0) return null;
  const sumLog = valid.reduce((s, v) => s + Math.log(v), 0);
  return Math.exp(sumLog / valid.length);
}
```

**File**: `lnt/server/ui/v5/frontend/src/comparison.ts`

Refactor `computeGeomean()` to call the shared `geomean()` primitive from `utils.ts` instead of inlining the `exp(mean(ln(...)))` logic. Existing Compare tests must continue to pass.

#### 2.10.3 Sparkline Card Component

**File**: `lnt/server/ui/v5/frontend/src/components/sparkline-card.ts` (new)

A lightweight Plotly wrapper for small trend charts:

```typescript
// TODO: update frontend code — SparklineTrace.points uses timestamp,
// but the API now returns submitted_at.
export interface SparklineTrace {
  machine: string;
  color: string;
  points: Array<{ timestamp: string; value: number }>;
}

export interface SparklineCardOptions {
  title: string;        // Metric display name or field name
  unit?: string;        // e.g. "ms", "bytes"
  traces: SparklineTrace[];
  /** Called on click. If a specific trace was clicked, `machine` is its name;
   *  otherwise (card background / title click) `machine` is undefined. */
  onClick?: (machine?: string) => void;
}

/** Create a sparkline card element. Call destroy() on unmount to free Plotly. */
export function createSparklineCard(options: SparklineCardOptions): {
  element: HTMLElement;
  destroy(): void;
};
```

- Plotly config: `responsive: true`, `displayModeBar: false`
- Layout: small margins (`t:8, r:8, b:30, l:40`), `showlegend: false`, x-axis type `date`, auto y-axis, `hovermode: 'closest'`
- Hover template: value + machine name
- Card container has `cursor: pointer`. Clicking the card background/title fires `onClick()` with no argument; clicking a specific Plotly trace fires `onClick(machine)` with that machine's name (via `plotly_click` event). A flag prevents double-firing since Plotly's click fires after the DOM click has already bubbled.
- Loading state: show a `.sparkline-loading` placeholder with "Loading..." text
- Error state: show a `.sparkline-error` placeholder with "Failed to load" text

#### 2.10.4 Dashboard Page Module

**File**: `lnt/server/ui/v5/frontend/src/pages/home.ts` (replace stub)

```
mount(container, params):
  1. Read ?range from URL (default '30d'), compute afterTime ISO string
  2. Render page header with time range buttons (30d / 90d / 1y)
  3. For each suite from getTestsuites():
     a. Render suite <h3> header + empty sparkline grid container
     b. Fetch getTestSuiteInfo(suite) → metrics list
     c. Fetch getRunsPage(suite, {sort: '-start_time', limit: 50}) → extract top 5 distinct machine names
     d. For each metric:
        - Render loading-state sparkline card in the grid
        - Call fetchSuiteTrends(suite, metric, machines, afterTime, signal)
        - On success: render sparkline card with data, onClick navigates to Graph page
        - On error: render error-state sparkline card
  4. Time range button click: update URL, abort all in-flight requests, re-fetch everything

unmount():
  - Abort all in-flight requests via AbortController
  - Destroy all Plotly sparkline instances
```

**`fetchSuiteTrends` abstraction** (in `home.ts`):

```typescript
/** Fetch trend data for one metric across multiple machines.
 *  Returns sparkline traces with server-computed geomean values per order. */
async function fetchSuiteTrends(
  suite: string,
  metric: string,
  machines: string[],
  afterTime: string,
  signal: AbortSignal,
): Promise<SparklineTrace[]> {
  // Call POST /api/v5/{suite}/trends — server returns geomean per (machine, commit)
  const items = await fetchTrends(suite, { metric, machine: machines, afterTime }, signal);

  // Group API response by machine, build SparklineTrace per machine
  // TODO: update frontend code to match (home.ts still uses old field names)
  const byMachine = new Map<string, Array<{ submitted_at: string; value: number }>>();
  for (const item of items) {
    if (!item.submitted_at) continue;
    let points = byMachine.get(item.machine);
    if (!points) { points = []; byMachine.set(item.machine, points); }
    points.push({ submitted_at: item.submitted_at, value: item.value });
  }

  const traces: SparklineTrace[] = [];
  for (const [machine, points] of byMachine) {
    if (points.length === 0) continue;
    const idx = machines.indexOf(machine);
    traces.push({ machine, color: machineColor(idx >= 0 ? idx : traces.length), points });
  }
  return traces;
}
```

**Click-through URL**: When a sparkline card background is clicked, navigate to the Graph page with all displayed machines. When a specific trace is clicked, navigate with just that machine:
```
/v5/graph?suite={suite}&machine={m1}&machine={m2}&...&metric={metric}
```

#### 2.10.5 Dashboard CSS

**File**: `lnt/server/ui/v5/frontend/src/style.css` (extend)

```css
/* Dashboard */
.dashboard-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.dashboard-range-group {
  display: flex;
  gap: 4px;
}

.dashboard-range-btn {
  padding: 4px 12px;
  border: 1px solid #ccc;
  border-radius: 3px;
  background: #fff;
  cursor: pointer;
  font-size: 13px;
}

.dashboard-range-btn:hover { background: #f0f0f0; }

.dashboard-range-btn-active {
  background: #0d6efd;
  color: #fff;
  border-color: #0d6efd;
}

.suite-section { margin-bottom: 24px; }

.sparkline-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.sparkline-card {
  width: 300px;
  border: 1px solid #dee2e6;
  border-radius: 6px;
  padding: 8px;
  cursor: pointer;
  transition: border-color 0.15s;
}

.sparkline-card:hover { border-color: #0d6efd; }

.sparkline-title {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 4px 0;
  color: #333;
}

.sparkline-chart { height: 130px; }

.sparkline-loading, .sparkline-error {
  height: 130px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #999;
}

.sparkline-error { color: #d62728; }
```

#### 2.10.6 Dashboard Testing

**Minimum required tests** (implementing agent may add more):

- **`geomean()` utility** (`__tests__/utils.test.ts`):
  - `geomean([4, 16])` returns 8
  - `geomean([4, 0, 16])` filters zero, returns 8
  - `geomean([0, -1])` returns null (all invalid)
  - `geomean([])` returns null
  - `geomean([25])` returns 25

- **`computeGeomean` refactored** (existing `__tests__/comparison.test.ts` tests pass — no new tests, just no regressions)

- **`fetchTrends`** (`__tests__/api.test.ts`):
  - POST body includes `metric`, `machine` list, and `after_time` when provided
  - Omits optional fields when not provided

- **Dashboard page** (`__tests__/home.test.ts`):
  - Mounts and renders a suite section header for each test suite
  - Time range buttons render; the active one reflects URL state
  - Sparkline cards render with correct metric titles given mock data

- **Sparkline card component** (`__tests__/sparkline-card.test.ts`):
  - Renders a container with the metric title
  - Shows loading state before data arrives
  - Shows error state on fetch failure
  - Click fires the navigation callback

---

## Phase 3: Graph Page

**Goal**: Implement the time-series graph page with auto-plot (no Plot button), lazy-loaded Plotly line charts, per-metric client-side caching, test filtering, aggregation controls, and baseline overlays. Data is fetched newest-first and rendered progressively so the chart appears immediately.

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

export interface PinnedBaseline {
  /** Display label, e.g. "libstdc++/gcc-x86/v13.2" or with " (tag)". */
  label: string;
  tag: string | null;
  /** Per-test values at this baseline. */
  values: Map<string, number>;
}

export interface TimeSeriesChartOptions {
  traces: TimeSeriesTrace[];
  /** Y-axis label (metric display name). */
  yAxisLabel: string;
  /** Baselines to overlay as horizontal dashed lines. */
  baselines?: PinnedBaseline[];
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
   *  traces to their normal appearance. Baseline traces are
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
  // Baselines: rendered as actual Plotly traces (not layout shapes)
  // so they support hover tooltips. Each baseline line is a scatter
  // trace with mode='lines', dash='dot', and showlegend=false,
  // populated with a data point at every x-category (scaffold or all
  // trace x-values as fallback) so that hover detection works anywhere
  // along the line. The hovertemplate shows: baseline order value (with
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

The graph page is the most data-intensive page. It uses **on-demand loading with per-metric client-side caching** and an **explicit test selection model** — the table shows all matching tests, the user selects which to plot, and data is fetched only for selected tests.

**Suite-agnostic architecture**: The graph page is served at `/v5/graph` (not `/v5/{ts}/graph`). The suite is read from the URL parameter `?suite=...` on mount, and managed via a `<select>` dropdown at the top of the controls panel. A module-level `currentSuite` variable replaces the old closure-captured `ts` from `params.testsuite`. A `suiteGeneration` counter is incremented on every suite change and checked by all async callbacks to discard stale responses. The `updateUrlState()` function encodes the suite as `qs.set('suite', currentSuite)`.

1. **Controls section** (top, wrapped in a `.controls-panel` box — same shared style as the Compare page's selection panel):
   - **Suite selector** (label: "Suite"): A `<select>` dropdown populated from `getTestsuites()` with an empty "-- Select suite --" option. Pre-selected from `?suite=` URL param, or auto-selected if only one suite exists. Changing the suite increments `suiteGeneration`, aborts all in-flight fetches, clears all module-level state (cache, machines, selections, etc.), re-fetches fields for the new suite, and calls `updateUrlState()`. All other controls are disabled until a suite is selected.
   - Machine chip input: uses `renderMachineCombobox` from `components/machine-combobox.ts` for typeahead, passing `currentSuite` as the testsuite. If `currentSuite` is empty (no suite selected), the input is disabled with a "Select a suite first" placeholder and no fetch is made. Otherwise, the combobox fetches the full machine list once on creation via `getMachines(ts, { limit: 500 })` and filters locally by case-insensitive substring — no per-keystroke API calls. When the user types a machine name and presses Enter, the machine is added to a `machines: string[]` list and a chip is rendered. Adding or removing a machine triggers `doPlot()` if a metric is also selected. A `.combobox-invalid` red halo appears when no machines match the typed text; Enter is blocked while the halo is showing.
   - Metric selector drop-down (uses `renderMetricSelector` from `components/metric-selector.ts`). Rendered with `placeholder: true` so it initially shows "-- Select metric --". When changed, if at least one machine is selected, triggers `doPlot()`.
   - "Filter tests" text input (substring match, debounced 200ms). Matches on **test name only**. Changes trigger `handleFilterChange()` which re-filters `allMatchingTests` and prunes `selectedTests`.
   - Run aggregation drop-down (median/mean/min/max). Changes re-render from cache via `renderFromSelection()`.
   - Sample aggregation drop-down (median/mean/min/max). Changes re-render from cache via `renderFromSelection()`.
   - Baselines panel (label: "Baselines", button: "+ Add baseline"). An expandable form with cascading dropdowns: Suite → Machine → Order. Added baselines appear as removable chips. Adding or removing a baseline calls `updateUrlState()` and re-renders.

2. **Data flow — explicit test selection with on-demand loading**:
   - On `doPlot()` (called when machine list or metric changes):
     1. Fetch scaffolds for all machines (same as before).
     2. Discover ALL test names for all machines × metric via `cache.getTestNames()` — union, sorted alphabetically. No cap.
     3. Clear `selectedTests` (nothing plotted by default). Update `allMatchingTests`.
     4. `renderFromSelection()` — shows the test selection table with all tests (none selected), chart empty with scaffold.
   - When the user selects tests (click, shift-click, double-click):
     1. `handleSelectionChange(newSelected)` is called by the table component.
     2. Abort previous selection fetch (`selectionAbort`). Update `selectedTests`.
     3. Find tests needing data fetch (check `cache.isComplete()` per machine).
     4. Add to `loadingTests`, call `renderFromSelection()` to show loading state.
     5. Batch fetch via `cache.ensureTestData()` per machine (POST /query with OR'd test names). During fetch, `onProgress` calls `renderChartOnly()` (not `renderFromSelection()` — avoids rebuilding the full table on every progress tick).
     6. After fetch: fetch baseline data for selected tests. Remove from `loadingTests`. Call `renderFromSelection()` for final render.
   - **Marker symbol assignment**: A fixed ordered list of Plotly marker symbols (`MACHINE_SYMBOLS = ['circle', 'triangle-up', 'square', 'diamond', 'x', 'cross', 'star', ...]`). The i-th machine in the `machines` list gets `MACHINE_SYMBOLS[i % MACHINE_SYMBOLS.length]`.
   - **Color assignment**: Colors are assigned by the test's index in `allMatchingTests` (sorted alphabetically). This ensures stable colors across selection changes — adding or removing a selection does not shuffle existing colors. The same test on different machines shares the same color.

3. **Test selection table** (`components/test-selection-table.ts`):
   - Replaces the old `legend-table.ts`. One row per test name (not per test×machine).
   - `TestSelectionEntry`: testName, selected, color? (only when selected), symbolChar?, loading?
   - Checkbox column for selection state. Colored marker symbol shown only for selected tests.
   - **Click** (200ms delay for double-click disambiguation): toggle selection, call `onSelectionChange`.
   - **Shift-click** (immediate, no 200ms delay — modifier key is unambiguous): select range from last-clicked test to clicked test (additive). `lastClickedIndex` stored as test name (not position) to survive `update()` rebuilds; resolved to current index on shift-click. Reset when the stored name is pruned by a filter change.
   - **Double-click** (cancels pending single-click): if this is the only selected test → select all visible tests (restore). Otherwise → select only this test (isolate).
   - **Header "check all" checkbox**: A `<thead>` row with a tri-state checkbox. Unchecked when no tests selected, indeterminate when some selected, checked when all selected. Clicking it: if not all selected → select all visible tests; if all selected → deselect all. No 200ms delay (unambiguous target outside tbody). State updated via `updateHeaderCheckbox()` in `buildRows()`.
   - Hover dispatches `GRAPH_TABLE_HOVER` with bare test name.
   - `highlightRow(testName)` matches on `data-test` attribute (bare test names).
   - `update()` rebuilds all rows via `tbody.replaceChildren()`.

4. **`renderFromSelection` — the main render function**:
   - Builds `TestSelectionEntry[]` from `allMatchingTests`. Colors assigned by test index in `allMatchingTests` (stable across selection changes).
   - Updates the test selection table (`tableHandle.update(entries, message)`).
   - Message: `"3 of 1200 tests selected"` or `"3 of 1200 tests selected, loading..."`.
   - Builds chart traces only from `selectedTests` using `buildTraces()` per machine per test. `buildTraces` applies two-step aggregation: first `sampleAgg` within each run (grouping by `run_uuid`), then `runAgg` across runs. This matches the Compare page's `aggregateSamplesWithinRun` + `aggregateAcrossRuns` pipeline.
   - Deferred chart update via `requestAnimationFrame` with generation counter.

5. **`renderChartOnly` — progressive chart update without table rebuild**:
   - Called from `onProgress` during data fetch. Reads cached data for selected tests, builds traces, updates chart. Does NOT touch the table (avoids rebuilding many rows per progress tick).

6. **Hover sync** (wired in `mount()`):
   - **Table→Chart**: `GRAPH_TABLE_HOVER` carries a bare test name. Listener maps to `traceName(testName, machines[0])` and calls `chartHandle.hoverTrace()`. For multi-machine, highlights the first machine's trace only (acceptable limitation without modifying time-series-chart.ts).
   - **Chart→Table**: `GRAPH_CHART_HOVER` carries a trace name (`testName · machine`). Listener extracts test name via `testNameFromTrace(tn)` and calls `tableHandle.highlightRow(testName)`.

7. **`GraphDataCache` — centralized data access layer** (unchanged class):
   - Same `GraphDataCache` class in `pages/graph-data-cache.ts`. All methods unchanged.
   - `filterTestNames` standalone function is **deleted** — no longer needed. The graph page inlines the text filter logic (simple `.filter()` call).
   - Cache persists across navigation. `cache.clear()` called on suite change.

8. **Baselines — asynchronous fetch with aggregation**:
   - Baseline data is fetched only for **selected** tests (not all discovered tests).
   - `addCurrentBaseline` uses `[...selectedTests]` when calling `cache.getBaselineData()`.
   - Aggregation consistency: same as before (runAgg applied per test).

9. **Module-level state**:
   - `allMatchingTests: string[]` — all test names matching the current filter (no cap). **Preserved across unmount/remount**.
   - `selectedTests: Set<string>` — user's explicit selection. **Preserved across unmount/remount** (like `cache`), so back-nav restores previous chart.
   - `loadingTests: Set<string>` — tests with in-flight data fetches. Reset on unmount.
   - `tableHandle: TestSelectionTableHandle | null` — destroyed on unmount, recreated on mount.
   - `selectionAbort: AbortController | null` — aborted on each new `handleSelectionChange` and on unmount.
   - Removed: `discoveredTests`, `discoveredTruncated`, `manuallyHidden`, `currentVisibleTraceNames`, `legendHandle`, `MAX_DISPLAYED_TESTS`, `computeActiveTests`.

10. **URL state**:
   - `?suite={name}&machine={name}&machine={name2}&metric={name}&test_filter={text}&run_agg={fn}&sample_agg={fn}&baseline={suite}::{machine}::{order}`
   - Selected tests are **NOT** in the URL (names can be very long). They are ephemeral page state preserved via module-scope variables across SPA navigation.
   - `updateUrlState()` called from all interactive handlers.

### 3.4 Phase 3 Testing

**Tests for `time-series-chart.ts`** (`__tests__/time-series-chart.test.ts`):
- Unchanged — all existing tests remain valid.

**Tests for `test-selection-table.ts`** (`__tests__/components/test-selection-table.test.ts`):
- Renders all entries as rows with checkboxes; selected rows have checked checkboxes and colored symbol; unselected rows have unchecked checkboxes
- Single click toggles selection, calls `onSelectionChange` after 200ms delay
- Shift-click selects range immediately (no 200ms delay), calls `onSelectionChange` with batch
- Shift-click with stale `lastClickedIndex` (test name no longer in entries) — treated as normal click
- Double-click isolates (select only this test) or restores all (if already the sole selection)
- Loading entries show loading indicator
- Hover dispatches `GRAPH_TABLE_HOVER` with bare test name
- `highlightRow` adds/removes `.row-highlighted` class matching on `data-test` (bare test name)
- `update()` replaces content
- `destroy()` cleans up

**Tests for `pages/graph.ts`** (`__tests__/pages/graph.test.ts`):
- Remove `computeActiveTests` tests (function removed)
- Update mock from `legend-table` to `test-selection-table` (`createTestSelectionTable`)
- `buildTraces` tests: unchanged (pure function)
- `buildBaselinesFromData` tests: unchanged (pure function)
- Mount tests: update expectations, update mock references
- Add test: hover sync mapping — `GRAPH_TABLE_HOVER` with test name triggers `hoverTrace` with trace name; `GRAPH_CHART_HOVER` with trace name triggers `highlightRow` with test name

**Tests for `pages/graph-data-cache.ts`** (`__tests__/pages/graph-data-cache.test.ts`):
- Remove `filterTestNames` tests (function deleted)
- All `GraphDataCache` class tests: unchanged

---
## Phase 4: Compare Integration

**Goal**: Absorb the existing Compare page into the SPA as a page module, add geomean summary row, support pre-selected side A from URL params, and enable cross-suite comparison (each side independently selects a test suite).

### 4.0 Existing Implementation (what's already built)

The Compare page was the first v5 frontend page and is already functional as a standalone SPA. This section summarizes what exists before Phase 4 changes. See `docs/design/ui/compare.md` for the full design.

**Modules**:
- `comparison.ts` — Core comparison logic: aggregation (within-run, across-runs), delta/ratio/status computation, `bigger_is_better` handling, zero-baseline and null-metric edge cases
- `selection.ts` — Renders the selection panel: per-side suite `<select>`, order/machine comboboxes, runs checkbox list, run/sample aggregation dropdowns, metric selector, noise threshold, test filter, hideNoise checkbox
- `table.ts` — Renders the comparison table: columns (Test, Value A/B, Delta, Delta %, Ratio, Status), sortable headers, color-coded status, noise de-emphasis, missing-test section, chart-zoom filtering
- `chart.ts` — Sorted ratio chart via Plotly: X=tests sorted by ratio, Y=log2(ratio) on a **log2 scale** with adaptive percentage tick labels (+/-1%, +/-5%, +/-50%, etc.) auto-selected from "nice" values to fit the data range, bar chart, noise band reference lines (converted to log2 space), hover tooltips, zoom/drag-select that filters the table
- `combobox.ts` — Searchable dropdown widget used for order and machine selection, with typeahead filtering
- `state.ts` — URL state management: encode/decode all selection params (`suite_a`, `suite_b`, `order_a`, `machine_a`, `runs_a`, `run_agg_a`, etc.), `replaceState`-based URL sync
- `events.ts` — Custom event system for chart-table sync (`CHART_ZOOM`, `CHART_HOVER`, `TABLE_HOVER`, `SETTINGS_CHANGE`, `TEST_FILTER_CHANGE`)

**Suite-agnostic architecture**: The Compare page is served at `/v5/compare` (not `/v5/{ts}/compare`). Each side has its own suite `<select>` dropdown. `SideSelection` includes a `suite: string` field. URL state includes `suite_a` and `suite_b` params. Fields and orders are fetched per-side via `fetchSideData(side, suite)`. Samples are fetched using each side's suite (side A runs use side A's suite, side B runs use side B's suite).

**Data flow**: On load, calls `initSelection(testsuites, doCompare)` (replacing the old `setCachedData()`). Each side's suite `<select>` triggers `fetchSideData(side, suite)` which fetches metric metadata (`GET test-suites/{suite}`) and all orders (`GET orders`, cursor-paginated) for that side independently. On order+machine change per side, fetches runs. On comparison trigger, fetches samples per run using that side's suite (`GET runs/{uuid}/samples` against the correct suite). All subsequent interactions (filter, sort, zoom) are client-side.

### 4.1 Refactoring Existing Modules

The existing Compare code is spread across `comparison.ts`, `selection.ts`, `table.ts`, `chart.ts`, `combobox.ts`, `state.ts`, and `events.ts`. These modules are well-structured and mostly decoupled from `main.ts`.

**Strategy**: The existing modules remain as-is (they are shared utilities), with adjustments to `selection.ts`, `chart.ts`, and `state.ts`:

**`state.ts` changes:**
- `setState()`, `setSideA()`, and `setSideB()` automatically call `replaceUrl()` after mutating state, so the URL always reflects the current UI state immediately — callers don't need to manage URL updates explicitly. All URL updates use `replaceState` (never `pushState`) so the browser Back button navigates between pages, not between individual setting changes within a page.
- `swapSides()` exchanges `sideA` and `sideB` in the global state and calls `replaceUrl()`. Used by the swap button in the selection panel.

**`selection.ts` changes:**
1. **`initSelection(testsuites, doCompare)` replaces `setCachedData()`**: Instead of receiving pre-fetched fields and orders for a single suite, the selection module receives the list of available test suites and a compare callback. Per-side data is fetched lazily via `fetchSideData(side, suite)` when the user selects a suite.
2. **Per-side suite `<select>`**: Each side panel renders a suite dropdown populated from the `testsuites` list. Changing a side's suite calls `fetchSideData(side, newSuite)` to fetch fields and orders for that suite, then re-renders the selection panel. Per-side cached data (`cachedOrdersA`/`cachedOrdersB`, `cachedFieldsA`/`cachedFieldsB`) and staleness counters (`suiteLoadVersionA`/`suiteLoadVersionB`) prevent stale responses from overwriting data when suites change rapidly. Clearing the suite clears the per-side cached fields and orders so stale metrics/orders don't linger.
3. **`fetchSideData(side, suite)`**: Fetches fields and orders for a side in parallel, updates per-side caches, and re-renders the metric selector with the union of both sides' fields. Reads `metricContainerRef` after the await (not a passed-in container) so it targets the current DOM element even if the panel was re-rendered during the fetch.
4. **Remove the Settings panel** (toggle button + token input) from `renderSelectionPanel()` — the SPA nav bar already provides the Settings panel with the API token input, so duplicating it on the Compare page is unnecessary. Also **remove the Compare button** — comparison is now auto-triggered via `tryAutoCompare()` whenever state is valid (both sides have runs + metric selected). `tryAutoCompare()` is called from: `createRunsPanel` (runs loaded or checkbox changed), metric select change, run agg change, sample agg change.
5. **Always select all runs by default** in `createRunsPanel()`: all available runs are checked by default. The only exception is URL state restoration: if the URL contains `runs_a` or `runs_b` UUIDs that match available runs, that selection is restored (allowing shared URLs to preserve a specific run subset). When no URL runs match (fresh load, order change), all runs are selected. Each run row shows its timestamp in a `<label>` and a short UUID as an `<a>` link to the Run Detail page (using `getBasePath()` to build the URL). Before an order is selected, the runs panel shows a single hint: "Select an order first" (the dependency chain guarantees suite and machine are already set).
6. **Metric selector uses shared component**: Replace the inline `createMetricSelect()` with the shared `renderMetricSelector` from `components/metric-selector.ts` (with `placeholder: true`). The `getMetricFields()` function returns the union of both sides' fields, using `filterMetricFields()` from the shared component to filter by `type === 'real'` (consistent with all other pages). The `onChange` callback calls `setState({ metric })` then `tryAutoCompare()`. When no fields are loaded yet (no suite selected on either side), the metric area shows a `"Select a suite to load metrics..."` hint instead of an empty selector.
7. **Swap sides button**: A circular button between the two side panels in the `.sides-row`. Clicking it calls `swapSides()` from `state.ts`, re-renders the selection panel, and triggers `tryAutoCompare()`. This lets users quickly reverse the baseline/new direction.

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
10. **`ComboboxContext` uses per-side accessors**: Instead of a single `testsuite`/`cachedOrderValues`/`orderTags`, the context provides `getSuiteName(side: 'a' | 'b')` (returns the suite for that side) and `getOrderData(side: 'a' | 'b')` (returns `{ cachedOrderValues, orderTags }` for that side). This supports cross-suite comparison where each side may have different orders and tags.
11. **Order tags in dropdown**: The order dropdown displays tags alongside values (e.g., "abc123 (release-18)") and the text filter matches against both the order value and the tag.
12. **Machine-filtered orders**: When a machine is selected but its orders haven't loaded yet (`machineOrders` is null), the dropdown shows "Loading orders..." instead of unfiltered results. On combobox creation, if a machine is pre-selected from URL state, `fetchMachineOrders` is called immediately so the dropdown is correctly filtered from the start. `fetchMachineOrders(side, machine, testsuite)` takes an explicit `testsuite` parameter (from `getSuiteName(side)`) rather than reading from a shared context.
13. **Per-side abort controllers**: `fetchMachineOrders` uses per-side abort controllers (`machineOrdersControllerA`/`B`) instead of a single shared one, so fetching orders for side B doesn't abort side A's in-flight request.
14. **Abort controllers in reset**: `resetComboboxState()` aborts in-flight `machineOrdersControllerA`/`B` requests. (The former `machineSearchController` has been removed — machine comboboxes now fetch once and filter locally, so there are no per-keystroke search requests to abort.)
15. **Input validation (red halo)**: Both `createMachineCombobox` and `createOrderPicker` show a `.combobox-invalid` class (red border + box-shadow halo) whenever the suggestion dropdown is empty and the input has text. Acceptance (Enter, change event) is blocked while invalid. Both machine and order comboboxes filter locally and update the halo synchronously in `showDropdown()` on every keystroke. When `getMachineOrders()` returns `'loading'`, the halo is suppressed. An Enter key handler is added to both `createOrderPicker` and `createMachineCombobox` (previously they only accepted via dropdown click or the `change` event on blur). For `createOrderPicker`, the Enter and change handlers additionally require an **exact match** against available order values (via an `isValidOrder(raw)` helper that checks `opts.getOrderData()` filtered by `opts.getMachineOrders()`). A partial substring match (e.g. "789" when the order is "566789") is rejected with the halo even though suggestions are visible — the user must either click a suggestion or type the full value.
15a. **Machine combobox fetches once, filters locally**: `createMachineCombobox` fetches the full machine list via `getMachines(suite, { limit: 500 })` once on creation (if a suite is selected) and stores it in a closure variable. On each keystroke, `showDropdown()` filters the cached list by case-insensitive substring match on `machine.name` — no debounce, no per-keystroke API calls. If the fetch hasn't completed, a "Loading machines..." hint is shown. All matching machines are displayed (no cap). The module-level `machineSearchController` is removed.
16. **Order input disabled until machine selected**: On the Compare page, `createOrderCombobox` disables the order input with placeholder "Select a machine first" when `selection.machine` is empty. `createMachineCombobox` enables the order input in `onMachineSelect` and re-disables it when the machine is cleared (empty text on `change` event). On the Graph page baseline form, `renderMachineCombobox` supports an optional `onClear` callback (fired when the user clears the input and blurs) which destroys the order picker. `renderMachineCombobox` also has a `blur` handler (closes the dropdown) and a `change` handler (fires `onClear` on empty text only — does NOT call `onSelect` on blur, keeping the chip-adder unaffected).
17. **Clearing order clears downstream runs**: In `createOrderCombobox`, the `onSelect` callback uses `setSide(value ? { order: value } : { order: '', runs: [] })` — when the order is empty, the runs array is also cleared so the runs panel resets.
18. **Machine input disabled until suite selected**: On the Compare page, `createMachineCombobox` disables the machine input with placeholder "Select a suite first" when `ctx.getSuiteName(side)` is empty. When the suite changes, the entire selection panel is re-rendered, so the machine combobox is freshly created with the new suite context.

**File**: `lnt/server/ui/v5/frontend/src/pages/compare.ts`

The compare page module implements:
- `mount()`: Renders a page header (`<h2>Compare</h2>`), restores URL state (including `suite_a`/`suite_b`), calls `initSelection(testsuites, doCompare)` to initialize the selection module with available suites and the compare callback, renders selection panel, wires event listeners (`CHART_ZOOM`, `CHART_HOVER`, `TABLE_HOVER`, `SETTINGS_CHANGE`, `TEST_FILTER_CHANGE`). If suites are pre-selected from URL state, `fetchSideData()` is called to load fields and orders for each side. Auto-compare via `tryAutoCompare()` in selection.ts. The chart container is initialized with a "No data to chart." message (consistent with the Graph page's empty state), which is replaced on the first comparison.
- `unmount()`: Removes event listeners, aborts fetches, clears sample cache and `manuallyHidden`, calls `destroyChart()` and `resetTable()`
- `doCompare()`: Checks sample cache, fetches only uncached runs (using each side's suite — side A runs call `getSamples(state.sideA.suite, uuid, ...)`, side B runs call `getSamples(state.sideB.suite, uuid, ...)`), evicts stale cache entries, calls `recomputeFromCache()`
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

When navigating from Machine Detail or Run Detail to Compare with a pre-selected machine and order on side A, the URL will contain `?suite_a={suite}&machine_a={name}&order_a={value}`. Since Graph and Compare are now suite-agnostic, the nav bar's Compare link in suite context generates `?suite_a={currentSuite}` to pre-fill the suite.

This already works with the existing state management: `applyUrlState` in `state.ts` decodes `suite_a`, `machine_a`, and `order_a` from the URL and populates `state.sideA`. The selection panel renders with these values pre-filled, and `fetchSideData('a', suite)` is called to load fields and orders for the pre-selected suite. The user can then fill in side B and the comparison auto-triggers.

### 4.4 Remove Old Compare Files

After Phase 4 is complete and verified:

1. Delete `v5_compare.html` (the old standalone template that extended `layout.html`)
2. Delete `static/comparison/` directory (the old standalone build output)
3. Remove the Compare link from the v4 navbar in `layout.html` — Compare is now only accessible via the v5 SPA at `/v5/compare`

Note: The old `v5_compare` route no longer exists — the suite-agnostic `v5_global()` route in `views.py` serves `/v5/compare` directly.

### 4.5 Phase 4 Testing

**Tests for `computeGeomean`** (`__tests__/comparison.test.ts`):
- Returns null for empty rows, missing rows, na rows
- Computes correct ratio geomean, geomeanA, geomeanB, delta, deltaPct
- Ignores rows with null ratio or a_only/b_only
- Single row: geomean equals the values
- All ratios = 1.0: ratio geomean = 1.0, delta = 0

**Tests for Compare page module** (`__tests__/pages/compare.test.ts`):
- Mount calls `initSelection(testsuites, doCompare)` instead of `setCachedData()`
- Mount restores `suite_a`/`suite_b` from URL state and calls `fetchSideData` for pre-selected suites
- Shows error when fetch fails
- Renders selection panel after data loads
- Per-side sample fetching uses each side's suite
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
- `getSuiteName(side)` returns the correct suite per side
- `getOrderData(side)` returns per-side order values and tags
- Tags shown in dropdown items
- Filter matches by tag text and by order value
- Loading hint when machine set but orders not loaded
- `setSide` called with order value (not tag) on selection
- Tag shown in input after selection
- Tag shown in input on URL restore
- Plain value shown when order has no tag
- `fetchMachineOrders` uses correct per-side abort controller

---

## Phase 5: Stub Pages

**Goal**: Add placeholder pages for Regression Detail and Field Change Triage.
The regression list is not a standalone page -- it is rendered inline as the
Regressions tab of the Test Suites page by `renderRegressionTab()` in
`pages/regression-list.ts`.

### 5.1 Stub Pattern

Each stub follows the same pattern:

```typescript
import type { PageModule, RouteParams } from '../router';
import { el } from '../utils';

export const regressionDetailPage: PageModule = {
  mount(container: HTMLElement, params: RouteParams): void {
    container.append(
      el('div', { class: 'page-placeholder' },
        el('h2', {}, 'Regression Detail'),
        el('p', {}, 'Not implemented yet.'),
      )
    );
  },
};
```

### 5.2 Stub Pages to Create

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

The admin page is served by the existing `v5_global()` route at `/v5/admin` (alongside `/v5/graph` and `/v5/compare`). No additional Flask route is needed — the same `v5_global()` function serves the SPA shell with `g.testsuite_name = ''`. The TypeScript router in the suite-agnostic context matches `/admin` and mounts the admin page module.

### 6.2 SPA Bootstrap

**File**: `lnt/server/ui/v5/frontend/src/main.ts`

When `data-testsuite` is empty (suite-agnostic context), the SPA sets `basePath = /v5` and registers the admin, graph, and compare routes. The admin page is one of the three suite-agnostic pages.

**File**: `lnt/server/ui/v5/frontend/src/components/nav.ts`

The Admin link always points to `/v5/admin`. In suite context, it triggers a full-page navigation (since `/v5/admin` is outside the suite-scoped basePath). In suite-agnostic context, it uses SPA navigation via `navigate('/admin')`. This is already handled by the three-category nav link architecture described in section 1.6.

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
- JSON textarea for the full schema definition (metrics, commit_fields, machine_fields)
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

Add a standalone "v5 UI" link in the top-right of the nav bar (before the "System" dropdown), not inside any dropdown menu. The link is wrapped in `{% if g.testsuite_name is defined %}` since it requires a test suite context to construct the URL.

```html
{% if g.testsuite_name is defined %}
<ul class="nav pull-right">
    <li><a href="/v5/{{ g.testsuite_name }}/">v5 UI</a></li>
</ul>
{% endif %}
```

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
lnt/server/ui/v5/frontend/src/components/sparkline-card.ts
lnt/server/ui/v5/frontend/src/pages/home.ts
lnt/server/ui/v5/frontend/src/pages/test-suites.ts
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
lnt/server/ui/v5/frontend/src/__tests__/sparkline-card.test.ts
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
lnt/server/ui/v5/frontend/src/main.ts             — SPA bootstrap with suite-scoped vs suite-agnostic branching
lnt/server/ui/v5/frontend/src/api.ts              — New API functions
lnt/server/ui/v5/frontend/src/types.ts            — New interfaces, SideSelection.suite field
lnt/server/ui/v5/frontend/src/utils.ts            — spaLink helper
lnt/server/ui/v5/frontend/src/comparison.ts       — computeGeomean (GeomeanResult with A/B values)
lnt/server/ui/v5/frontend/src/table.ts            — Geomean row, row toggling, summary message, resetTable()
lnt/server/ui/v5/frontend/src/chart.ts            — Text filter, destroyChart(), preserveZoom, removed hideNoise
lnt/server/ui/v5/frontend/src/selection.ts        — Per-side suite selects, initSelection(testsuites, doCompare), fetchSideData, removed Settings panel and Compare button, auto-select runs, tryAutoCompare(), swap sides button
lnt/server/ui/v5/frontend/src/state.ts           — swapSides() function, suite_a/suite_b URL params, SideSelection.suite field
lnt/server/ui/v5/frontend/src/combobox.ts         — getSuiteName/getOrderData per-side accessors, order tags, machine filtering, per-side abort controllers
lnt/server/ui/v5/frontend/src/style.css           — Nav bar + new page styles, row-hidden, table-message
lnt/server/ui/v5/views.py                         — v5_global() for /v5/admin, /v5/graph, /v5/compare; v5_app() catch-all for suite-scoped routes
lnt/server/ui/templates/layout.html               — v5 UI link in v4 nav, removed Compare link, nonav support
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
