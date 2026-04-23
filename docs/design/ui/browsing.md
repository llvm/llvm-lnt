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
| Machines | Searchable machine list with offset pagination | `GET machines?search=...&limit=25&offset=...` | Prefix match |
| Runs | Run list with cursor pagination | `GET runs?machine=...&sort=-start_time&limit=25` | Machine name (exact) |
| Commits | Commit list with cursor pagination | `GET commits?search=...&limit=25` | Search (prefix match on commit, tag, searchable fields) |
| Regressions | Full regression triage interface (see below) | `GET regressions?state=...&limit=25` | State chips, machine combobox, metric selector, has_commit checkbox, title search |

**Columns per tab:**
- **Recent Activity**: Machine, Commit (primary value), Start Time, UUID (truncated, linked)
- **Machines**: Name (linked), Info (key-value summary)
- **Runs**: UUID (truncated, linked), Machine, Commit (primary value), Start Time
- **Commits**: Commit Value (primary field, linked), Tag
- **Regressions**: Title (linked to regression detail), State (badge), Commit
  (display value, linked to commit detail), Machine count, Test count, Bug (external link),
  Delete button (auth-gated)

"Primary value" / "primary field" means the display-field-resolved value:
if the schema defines a commit_field with ``display: true`` and the commit
has a non-null value for that field, show it instead of the raw commit
string (see D4 in db/data-model.md).  When no display field is defined,
or the field is not populated for a given commit, fall back to the raw
commit string.  Links always use the raw commit string in the URL.

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
| Run History | Paginated table of runs (newest first) -- commit column shows display value (primary value) | `GET machines/{name}/runs?sort=-start_time` |

**Action links**: "View Graph" (pre-filled machine), "Compare" (pre-selected
machine), and "Delete Machine" button. Clicking "Delete Machine" shows a
confirmation prompt (below the action row) requiring the user to type the machine
name. Deletion requires a valid API token with `manage` scope. On success,
navigates to the test suites page. While the delete is in progress, a message
reassures the user that deletion may take a while for machines with many runs.

**Links out**: Run Detail, Commit Detail, Graph (with machine pre-filled),
Compare (with machine pre-selected), Regression Detail.

**Active regressions**: Below the action links, a section showing non-resolved
regressions (state: detected, active) with at least one indicator on this
machine. Each links to its regression detail page. A "Show all" link navigates
to the regressions tab pre-filtered by this machine.


## Run Detail -- `/v5/{ts}/runs/{uuid}`

All data from a single test execution.

| Section | Shows | API Calls |
|---------|-------|-----------|
| Metadata | Machine, commit (display value), start/end time, parameters | `GET runs/{uuid}` |
| Metric Selector | Drop-down to choose which metric to display (like Compare page) | `GET test-suites/{ts}` (fields from `schema.metrics`) |
| Test Filter | Text input for substring matching on test names | (client-side) |
| Samples Table | All samples + selected metric value, sorted by test name by default | `GET runs/{uuid}/samples` |

The metric selector drop-down controls which metric column is shown in the
samples table, consistent with how the Compare page handles metric selection.

Samples are loaded progressively -- the table renders immediately with the
first page and grows as more pages arrive, with a progress indicator showing
the count. Multiple samples for the same test (repetitions) appear as separate
rows.

**Action links**: "Compare with..." (pre-selects this run's machine and commit
on side A) and "Delete Run" button. Clicking "Delete Run" shows a confirmation
prompt (below the action row) requiring the user to type the first 8 characters
of the run UUID. Deletion requires a valid API token with `manage` scope. On
success, navigates to the machine detail page.

**Profile links**: Tests with profiles show a "Profile" link/icon in the
samples table. Profile presence is determined by calling
`GET /runs/{uuid}/profiles` (fetched once on page load, cached). The link
navigates to `/v5/profiles?suite_a={ts}&run_a={uuid}&test_a={test}`.

**Links out**: Machine Detail, Commit Detail, Graph (test pre-filled),
Profiles (pre-populated with run + test), Compare (side A pre-selected).


## Commit Detail -- `/v5/{ts}/commits/{value}`

The "what happened at this commit?" page. Key investigation page for developers.

- **Heading** shows the raw commit string (not the display value), since
  this page identifies a specific commit by its raw identity.

- Commit field values displayed prominently
- **Tag display + editing**: Show the commit's tag (if set) prominently (e.g., "Tag: release-18.1"). An inline edit button allows setting or clearing the tag via ``PATCH /commits/{value}``. Editing requires an API token with `manage` scope (from Settings); show an auth error if the token is missing or insufficient. The tag also appears in the display value throughout the UI as ``<display_value> (tag)``.
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

**Page header**: Shows "Regression: {title}" when a title is set, or
"Regression: {uuid_short}" as fallback. Updates dynamically when the title is
edited.

**Header section** (editable fields):
- Title: inline-editable text. Enter key saves.
- State: dropdown selector (detected, active, not_to_be_fixed, fixed, false_positive)
- Bug: URL input (opens in new tab when set). Enter key saves.
- Commit: display value shown (linked to commit detail page). Combobox with API search for editing (shows display values in dropdown). Nullable.
- Notes: text display with Edit button. Edit mode shows textarea + Save/Cancel. Ctrl/Cmd+Enter saves. Display preserves line breaks (pre-wrap).

**Delete regression**: Button with type-to-confirm prompt. Requires `triage`
scope. On success, navigates to the regressions tab.

**Add indicators panel**:
- Metric: dropdown selector
- Machines: checkbox list with filter input (multi-select, shift+click range)
- Tests: checkbox list with filter input (multi-select, shift+click range), filtered by selected machines and metric
- Preview: "This will add N indicators" (machines × tests cross-product)
- "Add" button creates all (machine × test × metric) indicator combinations
- Duplicates (same machine+test+metric already on this regression) are silently ignored

**Indicators table**:
- Heading: "Indicators (X tests across Y machines across Z metrics)" —
  unique counts computed from the indicators, excluding null machine/test
  values (from deleted entities). Shows plain "Indicators" when empty.
  When a filter is active: "Indicators (showing N of X tests across ...)".
- Filter: text input above the table for substring matching on machine
  name, test name, or metric (OR logic, case-insensitive). Filters the
  table rows client-side. Not shown when there are no indicators.
- Columns: select checkbox, Machine, Test, Metric, "View on graph" link, remove button (×)
- Select-all checkbox in header (with indeterminate state for partial selection)
- Shift+click range selection on checkboxes
- Batch "Remove selected" button
- "View on graph" link per indicator: opens Graph page pre-populated with the indicator's machine, test, metric, and the regression's commit as context

Auth: requires `triage` scope for all modifications.
