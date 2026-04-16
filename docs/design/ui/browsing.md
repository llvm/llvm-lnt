# v5 Web UI: Browsing Pages

Page specifications for the data browsing pages: Test Suites, Machine Detail,
Run Detail, and Commit Detail.

For the SPA architecture and routing, see [`architecture.md`](architecture.md).
Related pages: [Graph](graph.md), [Compare](compare.md).


## Test Suites -- `/v5/test-suites?suite={ts}&tab=...`

The primary entry point for browsing test suite data. Suite-agnostic page with
an internal suite picker and tabbed content.

**Suite picker**: A row of prominent card/button elements, one per test suite
(from `data-testsuites`). Clicking a card selects it (highlighted) and shows
the tab bar below. When no suite is selected, only the suite picker is visible.

**Tabs**: [Recent Activity] [Machines] [Runs] [Commits] [Regressions]. Default
tab is Recent Activity.

**URL state**: `?suite={ts}&tab=machines&search=foo&offset=0` -- all state is
in query params. On mount, reads params to restore state. On changes, updates
URL via `replaceState`.

| Tab | Content | API | Search/Filter |
|-----|---------|-----|---------------|
| Recent Activity | Last 25 runs sorted by time; "Load more" for next page | `GET runs?sort=-start_time&limit=25` | None |
| Machines | Searchable machine list with offset pagination | `GET machines?name_contains=...&limit=25&offset=...` | Name substring |
| Runs | Run list with cursor pagination | `GET runs?machine=...&sort=-start_time&limit=25` | Machine name (exact) |
| Commits | Commit list with cursor pagination | `GET commits?tag_prefix=...&limit=25` | Tag prefix |
| Regressions | Full regression triage interface (see below) | `GET regressions?state=...&limit=25` | State chips, machine combobox, metric selector, has_commit checkbox, title search |

**Columns per tab:**
- **Recent Activity**: Machine, Commit (primary value), Start Time, UUID (truncated, linked)
- **Machines**: Name (linked), Info (key-value summary)
- **Runs**: UUID (truncated, linked), Machine, Commit (primary value), Start Time
- **Commits**: Commit Value (primary field, linked), Tag
- **Regressions**: Title (linked to regression detail), State (badge), Commit
  (linked to commit detail), Machine count, Test count, Bug (external link),
  Delete button (auth-gated)

**Regressions tab details**:

The Regressions tab embeds the full regression triage UI directly in the Test
Suites page (there is no standalone Regression List page).

**Filters** (control panel above table):
- State: multi-select chips (detected, active, not_to_be_fixed, fixed,
  false_positive) -- toggleable, all deselected by default
- Machine: combobox with typeahead
- Metric: dropdown
- Has commit: checkbox (surfaces regressions with unset commit)
- Free-text search on title (client-side, debounced)

**Actions**:
- "New Regression" button (auth-gated) -> toggles an inline create form with
  title, bug, state, commit fields. On successful creation, navigates to the
  new regression's detail page.
- Row click -> navigates to regression detail page.
- Delete: per-row button with confirmation prompt (auth-gated).

**Pagination**: Cursor-based, consistent with other list tabs.

**Detail navigation**: Clicking an item navigates to the full suite-scoped
detail page (e.g., `/v5/{ts}/machines/{name}`) via full page navigation. This
crosses from suite-agnostic context to suite-scoped context.

**Suite root redirect**: `/v5/{ts}/` redirects to `/v5/test-suites?suite={ts}`.

**Links out**: Machine Detail, Run Detail, Commit Detail.


## Machine Detail -- `/v5/{ts}/machines/{name}`

Deep dive into a single machine. Machine names are guaranteed unique.

| Section | Shows | API Calls |
|---------|-------|-----------|
| Metadata | Machine info key-value pairs | `GET machines/{name}` |
| Run History | Paginated table of runs (newest first) | `GET machines/{name}/runs?sort=-start_time` |
| Delete | Delete button with confirmation prompt | `DELETE machines/{name}` (requires `manage` scope) |

The delete section appears at the bottom. Clicking "Delete Machine" shows a
confirmation prompt requiring the user to type the machine name. Deletion
requires a valid API token with `manage` scope (set via the Settings panel in
the nav bar). On success, navigates to the machine list. On auth failure
(401/403), shows an error message reminding the user to set an API token with
sufficient permissions. While the delete is in progress, a message reassures
the user that deletion may take a while for machines with many runs.

**Links out**: Run Detail, Commit Detail, Graph (with machine pre-filled),
Compare (with machine pre-selected), Regression Detail.

**Active regressions**: Below the run history, a section showing non-resolved
regressions (state: detected, active) with at least one indicator on this
machine. Each links to its regression detail page. A "Show all" link navigates
to the Regression List pre-filtered by this machine.


## Run Detail -- `/v5/{ts}/runs/{uuid}`

All data from a single test execution.

| Section | Shows | API Calls |
|---------|-------|-----------|
| Metadata | Machine, commit, start/end time, parameters | `GET runs/{uuid}` |
| Metric Selector | Drop-down to choose which metric to display (like Compare page) | `GET test-suites/{ts}` (fields from `schema.metrics`) |
| Test Filter | Text input for substring matching on test names | (client-side) |
| Samples Table | All samples + selected metric value, sorted by test name by default | `GET runs/{uuid}/samples` |
| Delete | Delete button with confirmation prompt | `DELETE runs/{uuid}` (requires `manage` scope) |

The metric selector drop-down controls which metric column is shown in the
samples table, consistent with how the Compare page handles metric selection.

Samples are loaded progressively -- the table renders immediately with the
first page and grows as more pages arrive, with a progress indicator showing
the count. Multiple samples for the same test (repetitions) appear as separate
rows.

A "Compare with..." button navigates to the Compare page with this run's
machine and commit pre-selected on side A, leaving side B open for the user to
fill in.

The delete section appears at the bottom. Clicking "Delete Run" shows a
confirmation prompt requiring the user to type the first 8 characters of the
run UUID. Deletion requires a valid API token with `manage` scope. On success,
navigates to the machine detail page.

**Links out**: Machine Detail, Commit Detail, Graph (test pre-filled), Profile,
Compare (side A pre-selected), Regression Detail.

**Regressions**: Below the samples table, a section showing regressions where
the regression's commit matches the run's commit AND at least one indicator
matches the run's machine. Each links to its regression detail page.


## Commit Detail -- `/v5/{ts}/commits/{value}`

The "what happened at this commit?" page. Key investigation page for developers.

- Commit field values displayed prominently
- **Tag display + editing**: Show the commit's tag (if set) prominently next to the commit field values (e.g., "Tag: release-18.1"). An inline edit button allows setting or clearing the tag. Editing requires an API token with `manage` scope (from Settings); show an auth error if the token is missing or insufficient.
- **Navigation**: Prev/Next buttons (using the API's `previous_commit`/`next_commit` from the commit detail response)
- **Summary**: N runs across M machines
- **Machine filter**: Text input for substring matching on machine names, filters the runs table. The summary updates to reflect filtered counts (e.g., "5 of 12 runs across 2 of 8 machines").
- **Runs table**: Columns: machine (link to Machine Detail), run UUID (link to Run Detail), start time
- API: `GET commits/{value}`, `PATCH commits/{value}` (tag editing), `GET runs?commit={value}`
- **Links out**: Run Detail, Machine Detail, Regression Detail

**Regressions at this commit**: Below the runs table, a section listing
regressions where `commit` matches this commit's value. Each links to its
regression detail page.


## Regression Detail -- `/v5/{ts}/regressions/{uuid}`

Investigation and management page for a single regression.

**Header section** (editable fields):
- Title: inline-editable text
- State: dropdown selector (detected, active, not_to_be_fixed, fixed, false_positive)
- Bug: URL input (opens in new tab when set)
- Commit: combobox with typeahead (nullable -- the suspected introduction point). Linked to commit detail page when set.
- Notes: expandable textarea for investigation findings, A/B results, root cause analysis, etc.

**Indicators table**:
- Columns: Machine, Test, Metric, remove button (x)
- Multi-select rows for batch remove
- "View on graph" link per indicator: opens Graph page pre-populated with the indicator's machine, test, metric, and the regression's commit as context

**Add indicators panel** (below table):
- Three multi-select comboboxes with typeahead: Metric, Machine, Test
- Test list filtered by selected machines and metrics (only shows tests with data for the selected combination)
- Preview: "This will add N indicators" with expandable list
- "Add" button creates all (machine x test x metric) indicator combinations
- Duplicates (same machine+test+metric already on this regression) are silently ignored

**Actions**:
- Delete regression button (with confirmation)

Auth: requires `triage` scope for all modifications.
