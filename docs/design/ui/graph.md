# v5 Web UI: Graph Page

Page specification for the Graph (time series) page at `/v5/graph`.

For the SPA architecture and routing, see [`architecture.md`](architecture.md).
Related pages: [Compare](compare.md), [Regressions](regressions.md),
[Browsing Pages](browsing.md).


## Graph (Time Series) -- `/v5/graph?suite={ts}&machine={m}&metric={f}`

The primary performance-over-time visualization. Replaces v4's graph page. This
page is suite-agnostic -- the suite is a query parameter, not a path segment.

- **Suite selector**: A required dropdown at the top of the page, populated from the `data-testsuites` HTML attribute. All other controls (machine, metric, test filter, aggregation, baselines) are disabled until a suite is selected. Changing the suite clears the machine list, all caches, and the chart. When the page is loaded with `suite=` in the URL, the dropdown is pre-selected.

- **Machine chip input**: The machine selector is a chip-based multi-select input. The user types a machine name (with typeahead suggestions) and presses Enter to add it. Each added machine appears as a chip with an x button to remove it. Multiple machines can be added to overlay their data on the same chart. Removing the last machine clears the chart. The metric selector is shared across all machines -- the same metric is plotted for every machine. The full machine list is fetched once when the combobox is created and filtered locally by case-insensitive substring as the user types (instant, no per-keystroke API calls). A "Loading machines..." hint is shown until the initial fetch completes.

- **Input validation**: Machine and commit comboboxes show a red halo (`.combobox-invalid` -- red border + box-shadow) whenever the suggestion dropdown is empty, meaning no machine or commit matches the typed text. Acceptance (Enter key, blur/change) is blocked while the halo is showing. The halo updates in real-time on every keystroke. Clicking a dropdown suggestion always clears the halo and accepts the value. For commit comboboxes, acceptance via Enter or blur additionally requires an exact match against available commit values -- a partial substring match (e.g. typing "789" when the commit is "566789") is rejected with the red halo even though suggestions are visible. All comboboxes support ArrowDown/ArrowUp keyboard navigation through suggestions, with Enter to select the focused item.

- **Explicit test selection**: There is no "Plot" button or auto-plot. When at least one machine and a metric are selected, the test table is populated with ALL matching tests (no cap). **Nothing is plotted by default** -- the chart starts empty with the x-axis scaffold. The user explicitly selects which tests to plot by clicking rows in the test table. Data is fetched on-demand when tests are selected. The metric selector initially shows a "-- Select metric --" placeholder (no metric pre-selected), consistent with the Compare page.

- **Multi-machine trace naming and symbols**: Each trace is named `{test name} - {machine name}` (test name first for natural sorting). Machines are visually distinguished by marker symbols: the first machine uses circles (default), the second triangles, then squares, diamonds, etc. Colors represent test identity, assigned by the test's position in the alphabetically sorted full test list (not just the selected subset). This ensures stable colors -- adding or removing a selection does not shuffle existing colors. The same test on different machines shares the same color but has a different marker shape.

- **Test filter**: A text filter (like the Compare page) that controls which tests appear in the test table. The filter matches on **test name only** (not machine name) via case-insensitive substring. Changing the filter prunes selected tests that no longer match -- their traces are removed from the chart. Clearing the filter restores the full test list (previously selected tests remain selected if they match).

- **X-axis is always commit** (not date -- commits are not necessarily correlated to dates)

- Plotly line chart: metric value vs commit, one trace per matching test

- **Aggregation controls** (consistent with Compare page):
  - Run aggregation: how to combine multiple runs at the same commit (median/mean/min/max)
  - Sample aggregation: how to combine multiple samples within a run (median/mean/min/max)


### Lazy Loading with Progressive Rendering

Data is fetched on-demand when tests are selected (not eagerly on discovery).
For each selected test, data is fetched via `POST /query` with OR'd test names
and rendered incrementally. When shift-clicking to select a range, the batch
of tests is fetched in a single query. The chart progressively fills in data as
pages arrive via cursor-based pagination. This avoids blocking the UI on large
datasets.


### X-axis Scaffolding

To prevent the x-axis from resizing/shifting as lazy-loaded pages arrive, the
graph page pre-fetches the complete list of commit values for each selected
machine via paginated calls to `GET commits?machine={name}&sort=ordinal`.
This returns commits in ordinal order, excluding commits without ordinals
(which have no meaningful position in a time series). When multiple machines
are selected, the scaffold is the **union** of all machines' commit values,
sorted by ordinal, so the x-axis spans the full range across all machines.
Traces naturally have gaps where their machine has no data at a given commit.
Each machine's scaffold is fetched and cached independently; the union is
recomputed when machines are added or removed. If a scaffold fetch fails for
one machine, that machine's commits are simply not included in the union --
the chart still works.


### Incremental Chart Updates

The chart component exposes a `ChartHandle` API (via `createTimeSeriesChart`)
that supports incremental updates through `Plotly.react()` -- the chart is
updated in-place as new pages of data arrive, rather than being destroyed and
re-created.


### Zoom Preservation During Progressive Loading

If the user zooms into the chart while data is still loading, the zoom is
preserved across incremental updates. The x-axis range is always preserved (it
was established by the scaffold or by user zoom). The y-axis range is preserved
only when the user has explicitly zoomed; otherwise, it auto-ranges to
accommodate new data as it arrives. Double-clicking the chart resets the zoom to
the full range as usual.


### Test Selection Table

Below the chart, a table lists ALL tests matching the current filter, sorted
alphabetically by test name. One row per test name (not per test x machine
combination -- selecting a test plots it on all active machines). The table is
part of the normal page flow (no scrollable container). A message line above
the rows shows counts (e.g., "3 of 1200 tests selected" or "3 of 1200 tests
selected, loading..."). Each row has: a checkbox cell (checked =
selected/plotted), a symbol cell (colored marker character (circle/triangle/square) only when
selected, empty otherwise), and the test name. The test filter narrows the
table; tests that no longer match are pruned from the selection.


### Selection Interactions

A header "check all" checkbox in the table header selects or deselects all
visible tests (tri-state: unchecked, indeterminate when some selected, checked
when all selected). Clicking a row toggles its selection (and triggers data
fetch if selecting). Shift-clicking selects a contiguous range from the
last-clicked row (additive -- adds to existing selection). Double-clicking
isolates that test (deselects all others); double-clicking the sole selected
test restores all (selects every visible test). Selected tests with data still
loading show a loading indicator. Plotly's built-in legend is disabled; the
table replaces it. Bidirectional hover highlighting: hovering a table row
highlights the corresponding chart trace(s); hovering a chart trace highlights
the table row. Selected tests are NOT persisted in the URL (test names can be
very long); the filter, suite, machine, metric, aggregation, and baselines
remain in the URL.


### Client-Side Caching and State Persistence

Test names, data points, scaffolds, and baseline data are cached locally. Test
names are fetched once per machine/metric combination (all names, no
server-side filter) and filtered client-side. Changing the test filter or
aggregation mode re-renders instantly from cache without any additional API
calls. Adding a second machine starts its own fetch pipeline while the first
machine's data is already displayed. The cache, the selected test set, and the
matching test list are all preserved across page unmount/remount, so navigating
away and pressing browser back renders the previous selection and chart
instantly from cache. All caches and selections are cleared on suite change.


### Baselines

Users can overlay one or more baselines as horizontal dashed lines on the
chart. Each baseline is a (suite, machine, commit) tuple, allowing cross-suite
comparisons. The selector is an expandable panel with cascading dropdowns:
Suite (populated from `data-testsuites`) -> Machine (populated from the
selected suite's machines endpoint) -> Commit (populated from the selected
machine's commits). Added baselines appear as removable chips labeled
`{suite}/{machine}/{commit} ({tag})`. Baseline data is fetched from the
baseline's suite via `POST /api/v5/{suite}/query` with `{machine, metric,
commit, test}` in the JSON body. Each baseline renders as a horizontal dashed
line per test trace, spanning the full chart width, colored to match the
corresponding test's main trace. The baseline's Y value for each test is
computed using the same run aggregation function as the main trace (e.g.,
median of all runs at that commit), so the dashed line aligns exactly with the
trace point at that commit. Hovering a dashed line shows a tooltip with: the
baseline suite, machine, commit value, tag (if set), test name, and metric
value. Baselines are encoded in the URL query string for shareability (e.g.,
`&baseline=nts::machine1::abc123&baseline=other_suite::machine2::def456`).
Baseline data is fetched asynchronously after the first render, so it does not
block initial chart display.


### Concurrent Background Fetches

Each machine x metric fetch uses its own AbortController, so navigating away or
removing a machine cancels its in-flight requests cleanly without affecting
other machines' fetches.


### Hover Behavior

Hover a data point: tooltip showing test name, machine name, commit value,
aggregated metric value, run count. Hover distance is reduced
(`hoverdistance: 5`, less sticky tooltips) so the tooltip only appears when the
cursor is close to a data point. When hovering over an aggregated point that
represents multiple runs, the individual pre-aggregation values are shown as a
scatter of markers at the same x-position, in the same trace color but faded
(opacity 0.3). This scatter is computed lazily via a callback and displayed as
a temporary Plotly trace that is added on hover and removed on unhover.


### Empty State

When no traces match the current filter/settings, the chart displays a Plotly
annotation overlay ("No data to plot") centered on the chart area, preserving
the x-axis scaffold so the user can see the commit range.


### API Calls

- `POST query` with JSON body `{machine, metric, test, sort, limit, cursor}` (one fetch pipeline per machine, targeted to discovered tests via multi-value `test`)
- `GET tests?machine=...&metric=...&name_contains=...` (test name discovery)
- `GET commits?machine={name}&sort=ordinal` (x-axis scaffold, per machine)
- `GET commits` (tags for baseline suggestions)
- `GET machines` (machine combobox)
- `GET test-suites/{ts}` (fields/metrics)


### URL State

`?suite={ts}&machine={name}&machine={name2}&metric={name}&test_filter={text}&run_agg={fn}&sample_agg={fn}&baseline={suite}::{machine}::{commit}&baseline={suite2}::{machine2}::{commit2}`

The `machine` parameter is repeated for each selected machine; the `baseline`
parameter is repeated for each baseline. Selected tests are NOT included in the
URL (names can be very long); they are ephemeral page state preserved across
SPA navigation but lost on page reload.

**Links out**: Compare, Regression Detail


### Regression Annotations

A dropdown toggle "Regressions: Off | Active | All" (default Off) in the
controls panel. When enabled, vertical dashed lines are drawn at the
regression's commit position for regressions with indicators matching the
current graph's test/machine/metric. Lines are color-coded by state
(red=active, yellow=detected, gray=resolved). Hover shows the regression title
and affected tests; click navigates to the regression detail page.
