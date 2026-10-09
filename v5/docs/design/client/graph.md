# v5 Web UI: Graph Page

Page specification for the Graph (time series) page at `/graph`.


## Graph (Time Series) -- `/graph?suite={ts}&machine={name}&metric={name}`

The primary performance-over-time visualization. This page is suite-agnostic:
the suite is a query parameter, not a path segment.


### GR1: Controls and Chart

- **Suite selector**: A required dropdown at the top of the page, populated from
  the test suites defined on the instance. All other controls (machine, metric,
  test filter, aggregation, baselines) are disabled until a suite is selected.
  Changing the suite clears the machine list, all caches, and the chart. When
  the page is loaded with `suite=` in the URL, the dropdown is pre-selected.

- **Machine chip input**: The machine selector is a chip-based multi-select
  input: the user adds a machine by picking it from a combobox (see AR2), and
  each added machine appears as a chip with an x button to remove it. Multiple
  machines can be added to overlay their data on the same chart. Removing the
  last machine clears the chart. The metric selector is shared across all
  machines -- the same metric is plotted for every machine.
  The full machine list is fetched once when the combobox is created and
  filtered locally by case-insensitive substring as the user types (instant, no
  per-keystroke API calls). A "Loading machines..." hint is shown until the
  initial fetch completes.

- **Explicit test selection**: There is no "Plot" button or auto-plot. When at
  least one machine and a metric are selected, the test table is populated with
  ALL matching tests (no cap). **Nothing is plotted by default** -- the chart
  starts empty with the x-axis scaffold. The user explicitly selects which tests
  to plot by clicking rows in the test table, unless the URL already names some
  (see GR14). Data is fetched on-demand when tests are selected. The metric
  selector initially shows a "-- Select metric --" placeholder (no metric
  pre-selected).
  It lists only numeric metrics (see D3), since non-numeric metrics cannot be
  plotted on a value axis.

- **Multi-machine trace naming and symbols**: Each trace is named
  `{test name} - {machine name}` (test name first for natural sorting). Machines
  are visually distinguished by marker symbols: the first machine uses circles
  (default), the second triangles, then squares, diamonds, etc. Colors represent
  test identity, assigned by the test's position in the alphabetically sorted
  full test list (not just the selected subset). This ensures stable colors --
  adding or removing a selection does not shuffle existing colors. The same test
  on different machines shares the same color but has a different marker shape.

- **Test filter**: A text filter (like the Compare page) that controls which
  tests appear in the test table. The filter matches on **test name only** (not
  machine name), and has regex mode (see AR2). Changing the filter prunes
  selected tests that no longer match -- their traces are removed from the
  chart. Clearing the filter restores the full test list (previously selected
  tests remain selected if they match).

- **X-axis is always commit** (not date -- commits are not necessarily
  correlated to dates).

- Line chart: metric value vs commit, one trace per selected test and machine

- **Aggregation controls** (consistent with Compare page):
  - Run aggregation: how to combine multiple runs at the same commit
    (median/mean/min/max)
  - Sample aggregation: how to combine multiple samples within a run
    (median/mean/min/max)


### GR2: Lazy Loading with Progressive Rendering

Data is fetched on-demand when tests are selected (not eagerly on discovery).
For each selected test, data is fetched via `POST /query` with OR'd test names
and rendered incrementally. When shift-clicking to select a range, the batch of
tests is fetched in a single query. The chart progressively fills in data as
pages arrive via cursor-based pagination. This avoids blocking the UI on large
datasets.


### GR3: X-axis Scaffolding

To prevent the x-axis from resizing/shifting as lazy-loaded pages arrive, the
graph page pre-fetches the complete list of commit values for each selected
machine via paginated calls to `GET commits?machine={name}&sort=ordinal`. This
returns commits in ordinal order, excluding commits without ordinals (which have
no meaningful position in a time series). When multiple machines are selected,
the scaffold is the **union** of all machines' commit values, sorted by ordinal,
so the x-axis spans the full range across all machines. Traces naturally have
gaps where their machine has no data at a given commit. Each machine's scaffold
is fetched and cached independently; the union is recomputed when machines are
added or removed. If a scaffold fetch fails for one machine, that machine's
commits are simply not included in the union -- the chart still works.


### GR4: Incremental Chart Updates

The chart is updated in-place as new pages of data arrive, rather than being
destroyed and re-created.


### GR5: Zoom Preservation During Progressive Loading

If the user zooms into the chart while data is still loading, the zoom is
preserved across incremental updates. The x-axis range is always preserved (it
was established by the scaffold or by user zoom). The y-axis range is preserved
only when the user has explicitly zoomed; otherwise, it auto-ranges to
accommodate new data as it arrives. Double-clicking the chart resets the zoom to
the full range as usual.


### GR6: Test Selection Table

Below the chart, a table lists ALL tests matching the current filter, sorted
alphabetically by test name. One row per test name (not per test x machine
combination -- selecting a test plots it on all active machines). The table is
part of the normal page flow (no scrollable container). A message line above the
rows says how many of the table's rows are selected, e.g. "3 of 1200 tests
selected", followed by ", loading..." while selected tests' data is loading.
When the test filter is set, it counts the rows the filter keeps and also
gives the unfiltered total: "3 of 42 matching tests selected (1200 total)".
The selection is always among those rows, since the filter prunes it, and the
message follows the filter as it changes. Each row has: a checkbox cell (checked =
selected/plotted), a symbol cell (colored marker character
(circle/triangle/square) only when selected, empty otherwise), and the test
name. The test filter narrows the table; tests that no longer match are pruned
from the selection.


### GR7: Selection Interactions

A header "check all" checkbox in the table header selects or deselects all
visible tests (tri-state: unchecked, indeterminate when some selected, checked
when all selected). Clicking a row toggles its selection (and triggers data
fetch if selecting). Shift-clicking selects a contiguous range from the
last-clicked row (additive -- adds to existing selection). Double-clicking
isolates that test (deselects all others); double-clicking the sole selected
test restores all (selects every visible test). Selected tests with data still
loading show a loading indicator. The chart has no legend of its own; the
table serves as one. Bidirectional hover highlighting: hovering a table row
highlights the corresponding chart trace(s); hovering a chart trace highlights
the table row. A selection of up to 10 tests is kept in the URL, along with
the rest of the page's state (see GR14).


### GR8: Client-Side Caching and State Persistence

Test names, data points, scaffolds, and baseline data are cached locally. Test
names are fetched once per machine/metric combination (all names, no server-side
filter) and filtered client-side. Changing the test filter or aggregation mode
re-renders instantly from cache without any additional API calls. Adding a
second machine starts its own fetch pipeline while the first machine's data is
already displayed. The cache and the matching test list are kept when the user
navigates away, so that going back to the page renders the previous chart
instantly from cache. The previous selection is restored with them when the
URL names no tests; tests the URL names replace it. All caches and selections
are cleared on suite change.


### GR9: Baselines

Users can overlay one or more baselines as horizontal dashed lines on the chart.
Each baseline is a (suite, machine, commit) tuple, allowing cross-suite
comparisons. The selector is an expandable panel with cascading selectors: Suite
(populated from the test suites defined on the instance) -> Machine (populated from the selected
suite's machines endpoint) -> Commit (populated from the selected machine's
commits via `GET commits?machine={name}&sort=-first_seen`; see AR2). Added
baselines appear as removable chips labeled `{suite}/{machine}/{display_value}`,
where `display_value` is the commit's display value (see AR2). A baseline
loaded from the URL is looked up like a commit given to the commit picker:
through `GET commits?machine={machine}&commit={commit}` in the baseline's
suite, which returns the commit, with its display value, only if the machine
has runs at it. If that lookup succeeds without returning it, the baseline is
unusable, and is dropped (see AR2 "State"). The "+" button keeps its own size
rather than stretching to the width of the chips.
Baseline data is fetched from the baseline's suite via `POST /api/suites/{suite}/query`
with `{machine, metric, commit, test}` in the JSON body. Each baseline renders
as a horizontal dashed line per test trace, spanning the full chart width,
colored to match the corresponding test's main trace. The baseline's Y value for
each test is computed using the same run aggregation function as the main trace
(e.g., median of all runs at that commit), so the dashed line aligns exactly
with the trace point at that commit. Hovering a dashed line shows a tooltip
with: the baseline suite, machine, commit, test name, and metric value.
Baselines are encoded in the URL query string for shareability as
`{suite}/{machine}/{commit}` (e.g.
`&baseline=nts/machine1/abc123&baseline=other_suite/machine2/def456`). None of
the three can contain a `/` (see D4 and I1). Baseline data is fetched
asynchronously after the first render, so it does not block initial chart
display.


### GR10: Concurrent Background Fetches

Each machine x metric fetch is cancellable on its own, so navigating away or
removing a machine cancels its in-flight requests cleanly without affecting
other machines' fetches.


### GR11: Hover Behavior

Hover a data point: tooltip showing test name, machine name, commit,
aggregated metric value, run count. The tooltip only appears when the cursor
is within a few pixels of a data point, so that tooltips are not sticky. When
hovering over an aggregated point that represents multiple runs, the individual
pre-aggregation values are shown as a scatter of markers at the same x-position,
in the same trace color but faded (opacity 0.3). This scatter is computed lazily
on hover and removed on unhover.


### GR12: Empty State

When no traces match the current filter/settings, the chart displays an overlay
"No data to plot" centered on the chart area, preserving the x-axis scaffold so
the user can see the commit range.


### GR13: API Calls

- `POST query` with JSON body `{machine, metric, test, sort, limit, cursor}`
  (one fetch pipeline per machine, targeted to discovered tests via multi-value `test`)
- `GET tests?machine=...&metric=...` (test name discovery)
- `GET commits?machine={name}&sort=ordinal` (x-axis scaffold, per machine)
- `GET commits?machine={name}&sort=-first_seen&search=...` (baseline commit picker)
- `GET commits?machine={name}&commit={value}` (baselines loaded from the URL)
- `GET machines` (machine combobox)
- `GET suites` (suite selector, and the selected suite's metrics)
- `POST regressions/indicators/query` and `GET regressions` (regression
  annotations; see GR15)


### GR14: URL State

`?suite={ts}&machine={name}&machine={name2}&metric={name}&test_filter={text}&test_filter_regex=1&test={name}&test={name2}&run_agg={fn}&sample_agg={fn}&regressions={mode}&baseline={suite}/{machine}/{commit}&baseline={suite2}/{machine2}/{commit2}`

`test` is present only while at most 10 tests are selected: with more, the URL
holds no `test` at all, and the page warns that the selection is not part of the
URL and so cannot be shared. `test_filter_regex=1` turns on the test filter's
regex mode (see AR2), and is omitted otherwise. On load, `test_filter` filters
the test table as if it had been typed, and a `test` that the test list for the
selected machines and metric does not hold, or that does not match the filter,
is dropped.


### GR15: Regression Annotations

A dropdown toggle "Regressions: Off | Active | All" (default Off) in the
controls panel. "Active" covers the regressions still being worked on
(`detected` and `active`), and "All" covers every state. When enabled, a
vertical dashed line is drawn at the commit of each regression with an
indicator naming one of the plotted machines, the plotted metric, and one of
the selected tests. Lines are color-coded by state: red for `active`, yellow
for `detected`, and gray for the resolved states (`not_to_be_fixed`, `fixed`
and `false_positive`). Hover shows the regression title and which of
the selected tests it affects; click navigates to the regression detail page.
A regression with no commit, or whose commit is not on the x-axis scaffold
(GR3), has no position on the chart and is not drawn. The selected mode is
persisted in the URL as `regressions={off|active|all}`; `off` is omitted.

The matching indicators come from the indicator lookup
(`POST /regressions/indicators/query`; see E8), given the plotted machines, the
metric, the selected tests and the mode's states. That lookup names each
regression by UUID only; their title, state and commit come from the regression
list (`GET /regressions`), joined on the UUID.
