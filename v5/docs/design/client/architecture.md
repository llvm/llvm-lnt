# v5 Web UI: Architecture

This document covers the SPA architecture, client-side routing, backend routes,
and navigation bar. For individual page specifications, see the other documents
in this directory.


## AR1: Context

LNT v4's web UI is built on Flask/Jinja2 server-rendered pages. It is dated and
difficult to use. The v5 REST API provides full access to the underlying data
contained in a LNT v5 instance. This SPA uses it to provide a more dynamic experience.


## AR2: Single-Page Application

One SPA with client-side routing. Every route in the page hierarchy below is
served by the same application; there is no point at which navigating within
the UI causes a full page reload.

- **Routing**: Simple path-based client-side router. No full page reload when
  navigating within the SPA. Modified clicks (Cmd+Click, Ctrl+Click,
  Shift+Click, middle-click) bypass the SPA router and let the browser handle
  them natively (e.g. open in a new tab).
- **Serving**: The server returns the SPA's `index.html` for any path that is
  not `/api/...`, `/llms.txt`, `/healthz`, or a static asset. This catch-all is
  what makes deep links and hard refreshes work -- pasting
  `/suites/nts/runs/{uuid}` or reloading on it must resolve to that route rather
  than 404. Unmatched `/api/...` paths are a genuine 404 and must answer with
  the API's JSON error envelope (see I4) rather than falling through to the
  SPA.
- **Code splitting**: Routes are lazy-loaded so the initial bundle stays small
  (external dependencies are fetched on demand).
- **State**: URL query params for shareable deep-links; local storage for auth
  token

**Design consistency**: All pages should share a consistent look and feel --
comboboxes, metric selectors, table styling, progress/error feedback, color
scheme, and layout spacing. The same components are reused across pages rather
than reinvented per-page. Pages with selection controls (dropdowns, filters,
aggregation settings) wrap them in a shared controls panel -- a lightly shaded
box with a border -- so the settings area is visually distinct from the page
content.

**Text filtering**: All client-side text filter and search inputs share a
unified filtering behavior. Plain text performs case-insensitive substring
matching. Prefixing the input with `re:` (case-sensitive literal prefix)
switches to case-insensitive regex matching. When regex mode is active (the
input starts with `re:`), a small inline "regex" badge appears at the right edge
of the input. The badge is blue for valid regex and red for invalid regex
syntax. Invalid regex patterns also show a red halo on the input border. This
convention applies uniformly to all text filter inputs across the UI: test name
filters, machine name filters, regression title searches, indicator filters,
combobox suggestion filters, and function name filters. The `re:` prefix is not
consumed or hidden -- the user sees it in the input and it is included in URL
state. Commit pickers are the exception: their typeahead is a server-side
`search=`, which matches plain substrings only (see O4 and "Commit pickers"
below).

**Text filtering performance**: All pages with large tables (Compare, Graph)
must keep filter typing responsive even with thousands of rows. Typing in a
filter input must produce a visible table update within a single animation
frame. Chart updates may be deferred to avoid blocking the input.

**Commit pickers**: Every combobox that selects a commit -- on the Compare and
Profiles pages, for Graph baselines, and for a regression's commit -- lists its
suggestions most recently seen first, as `GET commits?sort=-first_seen` returns
them with the picker's filters (see E3). That order keeps commits without an
ordinal (ad-hoc A/B experiment commits; see D1) selectable, placed by recency
among the ordered ones, whereas `sort=-ordinal` would drop them. A picker loads
only the first page when it opens, and narrows it as the user types by asking
the server again with `search=` (debounced), rather than fetching every commit
and filtering locally: a machine can have tens of thousands of commits. The
suggestions always reflect the text currently in the input; a response for text
the user has since changed is discarded. The search covers the display value
the suggestions show only if the schema marks the display field `searchable`
(see O4).

A page of matches need not hold every matching commit, so a typed value is
accepted only if it is exactly a commit the picker offers, which the picker
checks by looking that commit up under its filters (e.g.
`GET runs?machine={name}&commit={value}&limit=1`) rather than by finding it
among the suggestions: a short value can be a substring of more commits than
fit on a page. Likewise, a commit the picker is given rather than chosen --
restored from the URL, for instance -- need not be on the first page, so its
display value is resolved through `POST commits/resolve`.

**Authentication**: The v5 API allows unauthenticated reads, except for
the API key endpoints, which require `admin` scope even to read (see I5). No
configuration can gate reads, so the SPA never needs a token merely to browse.
The SPA navigation bar includes a Settings panel with a Bearer token input
(stored in local storage) for the Admin page and other write-capable pages
(regression triage, etc.).


## AR3: Page Hierarchy

```
/                                     Dashboard (landing page -- sparkline trend overview)
/suites                               Test Suites (suite picker, no suite selected)
/suites/{ts}                          Test Suites (browsing tabs for the selected suite)
/suites/{ts}/machines/{name}          Machine Detail
/suites/{ts}/runs/{uuid}              Run Detail
/suites/{ts}/commits/{value}          Commit Detail
/suites/{ts}/regressions/{uuid}       Regression Detail
/graph?suite={ts}&machine=...         Graph (time series) -- suite-agnostic
/compare?suite_a={ts}&...             Compare -- suite-agnostic
/profiles?suite_a={ts}&...            Profiles (A/B profile viewer) -- suite-agnostic
/admin                                Admin (API keys, schemas -- suite-agnostic)
```


## AR4: Navigation Bar

```
[LNT] [Test Suites] [Graph] [Compare] [Profiles] [API]  <---->  [Admin] [Settings]
```

All navbar links use SPA navigation. There is no full page reload anywhere in
the app: every route in the page hierarchy above belongs to the same
application, so navigating between a suite-scoped page and a suite-agnostic
one is an ordinary client-side transition. The single exception is [API],
which opens the interactive API documentation viewer at `/api/docs` (see I8) in
a new tab -- that is a separate document, not an SPA route.

Graph, Compare, and Profiles links append `?suite={ts}` / `?suite_a={ts}` when
navigated from a suite-scoped page, pre-filling the current suite. The Test
Suites link targets `/suites/{ts}` to preserve the suite context.
