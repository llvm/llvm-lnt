# v5 Web UI: Graph Page

Page specification for the Graph (time series) page at `/graph`.


## Graph (Time Series) -- `/graph?suite={ts}&machine={name}&metric={name}`

The primary performance-over-time visualization. This page is suite-agnostic:
the suite is a query parameter, not a path segment.


### GR1: Controls and Chart

- **Suite selector**: A required dropdown at the top of the page, populated from
  the test suites defined on the instance. All other controls (machine, metric,
  test filter, aggregation, baselines) are disabled until a suite is selected.
  Changing the suite clears the machines, the metric, the selected tests and
  the chart. The test filter, the aggregation, the regression annotation mode
  (GR15) and the baselines (GR9) are kept: a baseline names its own suite.
  When the page is loaded with `suite=` in the URL, the dropdown is
  pre-selected.

- **Machine chip input**: The machine selector is a chip-based multi-select
  input: the user adds a machine by picking it from a combobox (see AR14), and
  each added machine appears as a chip with an x button to remove it. The
  combobox does not offer the machines already added. Multiple machines can be
  added to overlay their data on the same chart. Removing the last machine
  clears the chart and the selected tests. The metric selector is shared across
  all machines -- the same metric is plotted for every machine. The suite's full
  machine list is fetched once and filtered locally by case-insensitive
  substring as the user types (instant, no per-keystroke API calls). A "Loading
  machines..." hint is shown until the initial fetch completes.

- **Explicit test selection**: There is no "Plot" button or auto-plot. When at
  least one machine and a metric are selected, the test table is populated with
  ALL matching tests (no cap). **Nothing is plotted by default** -- the chart
  starts empty with the x-axis scaffold. The user explicitly selects which tests
  to plot by clicking rows in the test table, unless the URL already names some
  (see GR14). Data is fetched on-demand when tests are selected. The metric
  selector initially shows a "-- Select metric --" placeholder (no metric
  pre-selected).
  It lists only numeric metrics (see D3), since non-numeric metrics cannot be
  plotted on a value axis. A suite with no numeric metric says so in place of
  the selector.

- **Selection across changes**: Changing the metric or the machines keeps the
  selected tests that the new test list holds, and deselects the others, but
  only once every machine's test list has loaded: a list that is still loading,
  or has failed to load, deselects nothing.

- **Multi-machine trace naming and symbols**: Each trace is named `{test name} -
  {machine name}` (test name first for natural sorting). Machines are visually
  distinguished by marker symbols, assigned in the order of their chips: the
  first machine uses circles (default), the second triangles, then squares,
  diamonds, etc., so that removing a machine shifts the symbols of the machines
  after it. Each chip shows its machine's symbol. Colors represent test
  identity: a test's color is derived from its name alone, so that it is the
  same whatever the machines, the metric, the selection or the filter, and on
  every visit to the page. Two tests may therefore share a color. The same test
  on different machines shares the same color but has a different marker
  shape.

- **Test filter**: A text filter (like the Compare page) that controls which
  tests appear in the test table. The filter matches on **test name only** (not
  machine name), and has regex mode (see AR9). Changing the filter prunes
  selected tests that no longer match -- their traces are removed from the
  chart. A pruned test is not selected again when the filter changes back.

- **X-axis is always commit** (not date -- commits are not necessarily
  correlated to dates). Commits are placed in ordinal order, at the positions
  the x-axis scaffold gives them (GR3), and are labelled with their display
  value (see AR6). Each commit has its own position, even when two commits
  share a display value.

- Line chart: metric value vs commit, one trace per selected test and machine.
  A trace's line runs straight across the commits where it has no value.

- **Aggregation controls**: a point is the value of one test on one machine at
  one commit, computed as Compare computes a side's value (see CP2
  "Aggregation pipeline"): the sample aggregation combines the test's samples
  within each run into a per-run value, and the run aggregation combines the
  per-run values of the runs at that commit. Each is median, mean, min or max,
  and defaults to median.


### GR2: Lazy Loading with Progressive Rendering

Data is fetched on-demand when tests are selected (not eagerly on discovery).
Each selected test's data on each machine is fetched on its own via
`POST /query`, and the chart progressively fills in each trace as its pages
arrive via cursor-based pagination. This avoids blocking the UI on large
datasets. So that a large selection does not flood the server, only a few
requests are in flight at once; the others wait for their turn.

Deselecting a test stops loading its data, and removing a machine stops loading
that machine's, without disturbing the rest. Leaving the page stops all
loading.


### GR3: X-axis Scaffolding

To prevent the x-axis from resizing/shifting as lazy-loaded pages arrive, the
graph page pre-fetches the complete list of commit values for each selected
machine via paginated calls to `GET commits?machine={name}&sort=ordinal`. This
returns commits in ordinal order, excluding commits without ordinals (which have
no meaningful position in a time series). When multiple machines are selected,
the scaffold is the **union** of all machines' commit values, sorted by ordinal,
so the x-axis spans the full range across all machines. A trace has no value at
the commits where its machine has no data for its test. Data on a commit that
is not on the scaffold, such as one without an ordinal, has no position and is
not plotted. Each machine's scaffold is fetched and cached independently; the
union is recomputed when machines are added or removed.

If a machine's scaffold cannot be fetched, the page says so (GR4), and that
machine's traces are not drawn until its scaffold has loaded, since their
commits would have no position on the x-axis.


### GR4: Errors

When something the page needs cannot be fetched -- the suites, the machine
list, a test list, a scaffold, the data of the selected tests, a baseline, or
the regression annotations -- the page says what could not be loaded, with a
way to try again, as AR7 describes for a table, and keeps showing what it
already has: traces that are drawn stay drawn, and other machines are
unaffected.


### GR5: Zoom Preservation During Progressive Loading

The chart is updated in place as new pages of data arrive. If the user zooms
into the chart while data is still loading, the zoom is preserved across
incremental updates. The x-axis range is always preserved (it was established by
the scaffold or by user zoom), until the scaffold itself changes, because a
machine was removed or a machine's scaffold has arrived, which resets the zoom.
The y-axis range is preserved only when the user has explicitly zoomed, and
only until the metric changes, since another metric has another scale;
otherwise, it auto-ranges to accommodate new data as it arrives. Double-clicking
the chart resets the zoom to the full range as usual.


### GR6: Test Selection Table

Below the chart, a table lists ALL tests matching the current filter, sorted
alphabetically by test name. One row per test name (not per test x machine
combination -- selecting a test plots it on all active machines). The table is
part of the normal page flow (no scrollable container). A message line above the
rows says how many of the table's rows are selected, e.g. "3 of 1200 tests
selected", followed by ", loading..." while selected tests' data is loading.
When the test filter is set, it counts the rows the filter keeps and also gives
the unfiltered total: "3 of 42 matching tests selected (1200 total)". The
selection is always among those rows, since the filter prunes it, and the
message follows the filter as it changes. Each row has: a checkbox cell (checked
= selected/plotted), a color cell (a swatch of the test's color, only when
selected, empty otherwise; it has no shape, since shapes stand for machines),
and the test name. The test filter narrows the table; tests that no longer match
are pruned from the selection.


### GR7: Selection Interactions

A header "check all" checkbox in the table header selects or deselects all
visible tests (tri-state: unchecked, indeterminate when some selected, checked
when all selected). Clicking a row toggles its selection (and triggers data
fetch if selecting). Shift-clicking selects a range of rows (see AR10).
Double-clicking isolates that test (deselects all others); double-clicking the
sole selected test restores all (selects every visible test). Selected tests
with data still loading show a loading indicator. The chart has no legend of its
own; the table and the machine chips (GR1) serve as one. Bidirectional hover
highlighting: hovering a table row highlights the corresponding chart trace(s);
hovering a chart trace highlights the table row. A selection of up to 10 tests
is kept in the URL, along with the rest of the page's state (see GR14).

At most 100 tests can be selected at once: well before that, the chart is
unreadable, and the data of thousands of tests is more than the page can load.
Once 100 tests are selected, the rows not selected cannot be selected, and the
header checkbox cannot select every visible test when that would select more
than 100. Each says why on hover. A shift-click range or a double-click that
would select more than 100 tests does nothing.


### GR8: Client-Side Caching

While the page is open, it keeps what it has fetched: in the selected suite,
test names per machine and metric (all of them, filtered client-side), data per
machine, metric and test, and scaffolds per machine; and the data of each
baseline. In particular:

- Changing the test filter or the aggregation redraws the traces from the data
  already loaded, without fetching any again.
- Adding a machine fetches only that machine's data, while the other machines'
  traces stay displayed.


### GR9: Baselines

Users can overlay one or more baselines as horizontal dashed lines on the chart.
Each baseline is a (suite, machine, commit) tuple, allowing cross-suite
comparisons. The selector is an expandable panel with cascading selectors: Suite
(populated from the test suites defined on the instance) -> Machine (populated from the selected
suite's machines endpoint) -> Commit (populated from the selected machine's
commits via `GET commits?machine={name}&sort=-first_seen`; see AR15). Added
baselines appear as removable chips labeled `{suite}/{machine}/{display_value}`,
where `display_value` is the commit's display value (see AR6). A baseline
loaded from the URL is looked up like a commit given to the commit picker:
through `GET commits?machine={machine}&commit={commit}` in the baseline's
suite, which returns the commit, with its display value, only if the machine
has runs at it. If that lookup succeeds without returning it, the baseline is
unusable, and is dropped (see AR2 "State"). The "+" button keeps its own size
rather than stretching to the width of the chips.
Baseline data is fetched from the baseline's suite via `POST /api/suites/{suite}/query`
with `{machine, metric, commit}` in the JSON body: every test's data at that
commit, so that selecting tests needs no request, and a test that the
baseline's suite does not have is simply absent. Each baseline renders
as a horizontal dashed line per selected test, spanning the full chart width,
colored to match that test's traces. The baseline's Y value for each test is
computed with the same sample and run aggregation as the traces (GR1), so that
when the baseline's suite and machine are plotted and its commit is on the
x-axis, the dashed line meets that machine's trace at the baseline commit. A
baseline draws no line for a test it has no data for, and draws nothing at all
when its suite does not declare the plotted metric as a numeric metric with the
same `unit` (an unset unit matching only an unset one), as CP1 requires of a
metric compared across suites.
Hovering a dashed line shows a tooltip with: the baseline suite, machine,
commit, test name, and metric value.
Baselines are encoded in the URL query string for shareability as
`{suite}/{machine}/{commit}` (e.g.
`&baseline=nts/machine1/abc123&baseline=other_suite/machine2/def456`). None of
the three can contain a `/` (see D4 and I1). Loading a baseline never delays
drawing the traces.


### GR10: Hover Behavior

Hover a data point: tooltip showing test name, machine name, commit,
aggregated metric value, run count, and a last line saying that clicking the
point shows its details (GR11). The tooltip only appears when the
cursor is within a few pixels of a data point, so that tooltips are not sticky.
When hovering over a point that represents multiple runs, its per-run values
(see GR1) are shown as a scatter of markers at the same x-position, in the
same trace color but faded (opacity 0.3). This scatter is computed lazily on
hover and removed on unhover.


### GR11: Point Details

Clicking a data point opens a popover anchored to it, which takes the focus and
stays open as the pointer moves, so that its links can be followed. It shows:

- the test name;
- the machine, linking to its Machine Detail page;
- the commit, linking to its Commit Detail page;
- the point's value and run count;
- the point's runs, each with its submission time, its shortened UUID linking to
  its Run Detail page, and its per-run value as the hover scatter shows it
  (GR10). The list scrolls when it is long;
- "Compare with previous": a link to the Compare page set up to compare this
  point with the previous point of the same trace. Side A is the previous
  point's commit, side B this point's commit, both in this suite and on this
  machine with all their runs, with the plotted metric, and with the Graph's
  sample and run aggregation, so that Compare's Value A and Value B are the two
  points' values. The previous point is the one at the nearest lower commit on
  the x-axis where this trace has a value, so that unlike the previous commit of
  Run Detail's "Compare with previous commit" (DT2), it always has data for the
  test. The link is disabled (see AR8) at the first point of a trace, and while
  the trace's data is still loading or could not all be loaded.

While it is open, the popover follows its point and updates its contents as
more data arrives. It closes on Escape, on its close button, on a click outside
it, and on any change to the chart other than data arriving, such as a zoom or
pan, or a change to the selected tests, machines, metric, filter or
aggregation. A click on another point opens that point's popover instead.
Clicking anything else on the chart does what its own section says (GR15), or
nothing.


### GR12: Empty State

When the chart has no point to draw, while no scaffold or data of the selected
tests is loading or has failed to load -- before a machine and a metric are
chosen, when no test is selected, or when the selected tests have no data on the
selected machines -- the chart displays an overlay "No data to plot" centered on
the chart area, preserving the x-axis scaffold, if there is one, so the user can
see the commit range.


### GR13: API Calls

- `POST query` with JSON body `{machine, metric, test, sort, limit, cursor}`
  (one per selected test and machine, `test` naming that test)
- `POST query` in a baseline's suite, with JSON body `{machine, metric, commit}`
  (baseline data; see GR9)
- `GET tests?machine=...&metric=...` (test name discovery)
- `GET commits?machine={name}&sort=ordinal` (x-axis scaffold, per machine)
- `GET commits?machine={name}&sort=-first_seen&search=...` (baseline commit picker)
- `GET commits?machine={name}&commit={value}` (baselines loaded from the URL)
- `GET machines` (machine combobox, and the baseline panel's machines)
- `GET suites` (suite selector, and the selected suite's metrics)
- `POST regressions/indicators/query` and `GET regressions` (regression
  annotations; see GR15)


### GR14: URL State

`?suite={ts}&machine={name}&machine={name2}&metric={name}&test_filter={text}&test_filter_regex=true&test={name}&test={name2}&run_agg={fn}&sample_agg={fn}&regressions={mode}&baseline={suite}/{machine}/{commit}&baseline={suite2}/{machine2}/{commit2}`

`test` is present only while at most 10 tests are selected: with more, the URL
holds no `test` at all, and the page says that the URL does not reflect the
selection. `test_filter_regex=true` turns on the test filter's
regex mode (see AR9). On load, `test_filter` filters the test table as if it had
been typed, and a `test` that the test list for the selected machines and metric
does not hold, or that does not match the filter, is dropped. Of a URL naming
more than 100 tests, which the page never writes, only the first 100 are
selected (see GR7), before any of them is dropped.


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
persisted in the URL as `regressions={off|active|all}`.

The matching indicators come from the indicator lookup
(`POST /regressions/indicators/query`; see E8), given the plotted machines, the
metric, the selected tests and the mode's states. That lookup names each
regression by UUID only; their title, state and commit come from the regression
list (`GET /regressions`), joined on the UUID.
