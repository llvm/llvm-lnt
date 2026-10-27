# v5 Web UI: Graph Page

Page specification for the Graph (time series) page at `/graph`.


## Graph (Time Series) -- `/graph?suite={ts}&machine={name}&metric={name}`

The primary performance-over-time visualization. This page is suite-agnostic:
the suite is a query parameter, not a path segment.


### GR1: Controls and Chart

- **Suite selector**: A required dropdown at the top of the page, populated from
  the test suites defined on the instance. All other controls (machine, metric,
  test filter, aggregation, regression annotations, baselines) are disabled
  until a suite is selected.
  Changing the suite clears the machines, the metric, the selected tests, the
  highlighted commits (GR16) and the chart. The test filter, the aggregation,
  the regression annotation mode (GR15) and the baselines (GR9) are kept: a
  baseline names its own suite.
  When the page is loaded with `suite=` in the URL, the dropdown is
  pre-selected.

- **Machine chip input**: The machine selector is a chip-based multi-select
  input: the user adds a machine by picking it from a combobox (see AR14), and
  each added machine appears as a chip with an x button to remove it. The
  combobox does not offer the machines already added, and lists the others as
  every machine picker does (see AR18). Multiple machines can be
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
  selected tests that the new test list holds, and deselects the others, once
  every machine's test list has loaded (see AR2 "State").

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
  shape. While the points have no markers (see the line chart below), the
  traces of a test on different machines therefore look alike: the tooltip
  (GR10) names the machine, and zooming in brings the markers back.

- **Test filter**: A text filter (like the Compare page) that controls which
  tests appear in the test table. The filter matches on **test name only** (not
  machine name), and has regex mode (see AR9). It only narrows the table: it
  never changes the selection, so tests can be selected under one filter, then
  others under another, and the chart plots every selected test whether the
  filter shows its row or not.

- **X-axis is always commit** (not date -- commits are not necessarily
  correlated to dates). Commits are placed in ordinal order, at the positions
  the x-axis scaffold gives them (GR3), and are labelled with their display
  value (see AR6). Each commit has its own position, even when two commits
  share a display value.

- Line chart: metric value vs commit, one trace per selected test and machine.
  A trace's line runs straight across the commits where it has no value. Each
  point has a marker, as long as at most 200 commits of the x-axis (GR3) are in
  view: beyond, markers are too close together to tell apart, and the traces
  are drawn as lines alone, until a zoom brings 200 or fewer into view again. A
  trace with a single point keeps its marker, without which it would not show.
  A point without a marker can still be hovered and clicked (GR10, GR11).

- **Aggregation controls**: a point is the value of one test on one machine at
  one commit. Its samples are the samples of that test on that machine at that
  commit that have a value for the plotted metric (a run with N such samples
  contributes N of them), and its runs are the runs they belong to. Its value
  is computed from its samples as Compare computes a side's value (see CP2
  "Aggregation pipeline"): the sample aggregation combines the samples within
  each run into a per-run value, and the run aggregation combines the per-run
  values of the point's runs. Each is median, mean, min or max, and defaults to
  median.


### GR2: Lazy Loading with Progressive Rendering

Data is fetched on-demand when tests are selected (not eagerly on discovery).
Each selected test's data on each machine is fetched on its own via
`GET /series`, and each trace is drawn once all of its data has arrived, never
in part, so that the chart fills in as the traces arrive rather than waiting
for the whole selection.
So that a large selection does not flood the server, only a few requests are in
flight at once; the others wait for their turn.

Deselecting a test stops loading its data, and removing a machine stops loading
that machine's, without disturbing the rest. Leaving the page stops all
loading.


### GR3: X-axis Scaffolding

To prevent the x-axis from resizing/shifting as the traces' data arrives, the
graph page pre-fetches the complete list of commit values for each selected
machine via paginated calls to
`GET commits?machine={name}&has_ordinal=true&sort=ordinal`. This returns
commits in ordinal order, excluding commits without ordinals (which have no
meaningful position in a time series). When multiple machines are selected,
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
way to try again (see AR7), and keeps showing what it
already has: traces that are drawn stay drawn, and other machines are
unaffected.


### GR5: Zoom Preservation During Progressive Loading

The chart is updated in place as the traces' data arrives. If the user zooms
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
selected". When the test filter is set, it counts the rows the filter keeps and
also gives the unfiltered total: "3 of 42 matching tests selected · 1200 tests
in total". When some selected tests do not match the filter, it also says how
many: "2 of 42 matching tests selected · 1200 tests in total · 5 more hidden by
the filter". When the URL does not reflect the selection (see GR14), it then
says so, and why on hover and to assistive technology: "11 of 11 tests
selected · too many to reflect in the URL". Last, while selected tests' data is
loading, it says so: "3 of 1200 tests selected · loading...". The message
follows the filter as it changes. Each row has: a checkbox cell (checked =
selected/plotted), a color cell (a swatch of the test's color, only when
selected, empty otherwise; it has no shape, since shapes stand for machines),
and the test name.


### GR7: Selection Interactions

A header "check all" checkbox in the table header selects or deselects all
visible tests (tri-state over the visible tests: unchecked, indeterminate when
some are selected, checked when all are). Clicking a row toggles its selection
(and triggers data fetch if selecting). Shift-clicking selects a range of rows
(see AR10). Double-clicking a row isolates that test among the visible ones: it
deselects the other visible tests. Double-clicking the only selected visible
test selects every visible test again. None of these interactions ever changes
a test that the filter hides. Selected tests with data still loading show a
loading indicator. The chart has no legend of its own; the table and the
machine chips (GR1) serve as one. Bidirectional hover highlighting: hovering a
table row highlights the corresponding chart trace(s); hovering a chart trace
highlights the test's row, if the filter shows it. A test's baseline lines
(GR9) count as its traces for both. A selection of up to 10 tests is kept in
the URL, along with the rest of the page's state (see GR14).

At most 100 tests can be selected at once, including those the filter hides:
well before that, the chart is unreadable, and the data of thousands of tests is
more than the page can load. Once 100 tests are selected, the rows not selected
cannot be selected, and the header checkbox cannot select every visible test
when that would select more than 100. Each says why on hover. A click on a row,
a Shift-click range or a double-click that would select more than 100 tests
does nothing, not even moving the anchor (AR10). Instead, it says why beside
the row clicked, where the user is looking, and to assistive technology: how
many tests would then be selected, and that at most 100 can be. This takes
neither the focus nor the clicks on what it covers, and stays shown until the
next click anywhere or Escape, or until the selection or the rows shown
change.

Unlike the interactions above, "Deselect all" at the end of the message line
(GR6) deselects every selected test, those the filter hides included. It reads
as part of the message, and is shown while the message counts any selected
test. Unlike the header checkbox, it is available however many tests the table
lists, since deselecting is never refused. Once it is used, the focus moves to
the table, without scrolling the page.


### GR8: Client-Side Caching

While the page is open, it keeps what it has fetched: in the selected suite,
test names per machine and metric (all of them, filtered client-side), data per
machine, metric and test, and scaffolds per machine; and the data of each
baseline. In particular:

- Changing the aggregation redraws the traces from the data already loaded,
  without fetching any again. Changing the test filter changes only the test
  table (GR1).
- Adding a machine fetches only that machine's data, while the other machines'
  traces stay displayed.


### GR9: Baselines

Users can overlay one or more baselines as horizontal dashed lines on the chart.
Each baseline is a (suite, machine, commit) tuple, allowing cross-suite
comparisons. The selector is a panel, opened by a "+" button beside the
"Baselines" label, with cascading selectors: Suite
(populated from the test suites defined on the instance) -> Machine (populated from the selected
suite's machines endpoint, see AR18) -> Commit (populated from the selected machine's
commits via `GET commits?machine={name}&sort=-ordinal`; see AR15). Picking
a commit adds the baseline and closes the panel; "+" closes it too. Added
baselines appear as removable chips labeled `{suite}/{machine}/{display_value}`,
where `display_value` is the commit's display value (see AR6), or the commit
string until the display value is known. A baseline loaded from the URL is
looked up like a commit given to the commit picker: through
`GET commits?machine={machine}&commit={commit}` in the baseline's suite, which
returns the commit, with its display value, only if the machine has runs at it.
If that lookup succeeds without returning it, the baseline is unusable, and is
dropped (see AR2 "State"). A baseline can also be added from a point's details
(GR11): the point's suite, machine and commit. Like a commit picked in the
panel, it is not looked up (AR15): its point shows that the machine has runs at
the commit.
Baseline data is fetched from the baseline's suite via
`GET /api/suites/{suite}/series?machine={machine}&metric={metric}&commit={commit}`:
every test's data at that commit, so that selecting tests needs no request, and
a test that the baseline's suite does not have is simply absent. These requests
do not wait for the traces' turns (GR2), so that a large selection does not hold
back a baseline. Each baseline renders
as a horizontal dashed line per selected test, spanning the full chart width,
colored to match that test's traces. The baseline's Y value for each test is
computed with the same sample and run aggregation as the traces (GR1), so that
when the baseline's suite and machine are plotted and its commit is on the
x-axis, the dashed line meets that machine's trace at the baseline commit. A
baseline draws nothing until all its data has arrived. The y-axis range includes
the baseline's lines. A
baseline draws no line for a test it has no data for, and draws nothing at all
when its suite does not declare the plotted metric as a numeric metric with the
same `unit` (an unset unit matching only an unset one), as CP1 requires of a
metric compared across suites.
Hovering a dashed line shows a tooltip with: the baseline suite, machine,
commit, test name, and metric value. A point on a dashed line keeps its tooltip
and details (GR10, GR11).
Baselines are encoded in the URL query string for shareability as
`{suite}/{machine}/{commit}` (e.g.
`&baseline=nts/machine1/abc123&baseline=other_suite/machine2/def456`). None of
the three can contain a `/` (see D4 and I1). If the URL names a baseline twice,
it is added once. Loading a baseline never delays drawing the traces.


### GR10: Hover Behavior

Hover a data point: tooltip showing test name, machine name, commit,
aggregated metric value, run count, and a last line saying that clicking the
point shows its details (GR11). The tooltip only appears when the
cursor is within a few pixels of a data point, so that tooltips are not sticky.
When hovering over a point that has more than one sample, its samples (see
GR1) are shown, before any aggregation, as a scatter of markers at the point's
x-position, in the same trace color but faded (opacity 0.3). This scatter is
computed lazily on hover and removed on unhover, unless the point's details are
open (see below). Showing it does not rescale the chart: a sample outside the
y-axis range is not shown.

While a point's details are open (GR11), its scatter stays shown, wherever the
pointer is, and is removed when they close. Hovering another point meanwhile
shows that point's scatter as well, as above. Hovering a marker of the open
point's scatter shows a tooltip with that sample's value and its run: the run's
measurement time and shortened UUID, as the details list them.


### GR11: Point Details

Clicking a data point opens a popover beside it, without covering its scatter
(GR10), which takes the focus and stays open as the pointer moves, so that its
links can be followed. It takes the place of the point's tooltip, which is
hidden until the pointer moves again. It shows:

- the test name;
- the machine, linking to its Machine Detail page;
- the commit, linking to its Commit Detail page, followed by "View on {label}"
  (see AR20);
- the point's value and run count;
- the point's runs, in the order they were measured, each with its measurement
  time, its shortened UUID linking to its Run Detail page, and the values of its
  samples (GR1), in ascending order and on one line. The list scrolls when it is
  long or wide;
- "Compare with previous commit": a link to the Compare page set up to compare
  this point with the previous point of the same trace. Side A is the previous
  point's commit, side B this point's commit, both in this suite and on this
  machine with all their runs, with the plotted metric, and with the Graph's
  sample and run aggregation, so that Compare's Value A and Value B are the two
  points' values. The previous point is the one at the nearest lower commit on
  the x-axis where this trace has a value, so that unlike the previous commit of
  Run Detail's "Compare with previous commit" (DT2), it always has data for the
  test. The link is disabled (see AR8) at the first point of a trace.
- "View changes on {label}" (see AR20): a link to the changes between the two
  commits that "Compare with previous commit" compares, the previous point's
  filling in `{from}` and this point's `{to}`. Like that link, it is disabled
  at the first point of a trace.
- "Highlight this commit": a button that adds the point's commit to the
  highlighted commits (GR16). It is disabled, with the reason, when the maximum
  number of commits is already highlighted. When the point's commit is already
  highlighted, the button is "Remove the highlight" instead, and removes it. In
  both cases, the popover stays open and the button keeps the focus.
- "Add as baseline": a button that adds the point's suite, machine and commit
  as a baseline (GR9). When it is already a baseline, the button is "Remove the
  baseline" instead, and removes it. In both cases, the popover stays open and
  the button keeps the focus.
- "Create regression": a button opening a form below it that creates a
  regression in this suite, attributed to the point's commit, with a single
  indicator naming the point's machine and test and the plotted metric. The
  form asks only for the regression's title, which may be left empty: the
  regression otherwise has E8's default state, and can be completed on its
  Regression Detail page (DT4). The form opens with the focus in its empty
  input, and is used as an inline edit is (AR12): whitespace at either end of
  the title is ignored, so that a title of only whitespace is none; Enter or
  its Create button creates the regression; nothing in the form can be used
  while it is being created; and Escape or its Cancel button closes the form,
  forgetting its title, gives the focus back to "Create regression", and
  leaves the popover open. It is a form (see AR2 "State"). Creating the
  regression needs `triage` scope (see AR17). Once it is created, the form
  gives way to "Regression created: " followed by a link to its Regression
  Detail page, whose text is its title, or its shortened UUID when it has
  none, and which takes the focus. When regression annotations are shown, the
  chart marks it at once (GR15), whether or not the popover is still open. If
  creating it fails, the form says why and keeps the title typed, and the
  focus stays where it was.

While it is open, the popover follows its point -- as more data arrives or a
baseline changes the y-axis range, the chart is resized or the page scrolls --
and updates its contents as the data arrives. It closes on Escape, unless
pressed in its "Create regression" form, on its close button, on a click
anywhere but on it or a marker of its point's scatter, and on any change to the
chart other than data arriving, such as a zoom or pan, or a change to the
selected tests, machines, metric, aggregation or regression annotation mode, and
once its point is no longer drawn. A change to the baselines (GR9) or the
highlighted commits (GR16) does not close it: neither changes which point it is
about.
Moving the focus out of it does not close it. A click on another point opens
that point's popover instead.
Clicking anything else on the chart does what its own section says (GR15), or
nothing.


### GR12: Empty State

When the chart has no point to draw, while no scaffold or data of the selected
tests is loading or has failed to load -- before a machine and a metric are
chosen, when no test is selected, or when the selected tests have no data on the
selected machines -- the chart displays an overlay "No data to plot" centered on
the chart area, preserving the x-axis scaffold, if there is one, so the user can
see the commit range. Baseline lines (GR9), regression annotations (GR15) and
the highlighted commits (GR16) are not points.


### GR13: API Calls

- `GET series?machine={name}&metric=...&test={test}&has_ordinal=true` (one per
  selected test and machine)
- `GET series?machine={name}&metric=...&commit={value}` in a baseline's suite
  (baseline data; see GR9)
- `GET tests?machine=...&metric=...` (test name discovery)
- `GET commits?machine={name}&has_ordinal=true&sort=ordinal` (x-axis scaffold,
  per machine)
- `GET commits?machine={name}&sort=-ordinal&search=...` (baseline commit picker)
- `GET commits?machine={name}&commit={value}` (baselines loaded from the URL)
- `GET machines` (machine combobox, and the baseline panel's machines)
- `GET suites` (suite selector, and the selected suite's metrics)
- `POST regressions/indicators/query` and `GET regressions` (regression
  annotations; see GR15)
- `POST regressions` (creating a regression from a point; see GR11)


### GR14: URL State

`?suite={ts}&machine={name}&machine={name2}&metric={name}&test_filter={text}&test_filter_regex=true&test={name}&test={name2}&run_agg={fn}&sample_agg={fn}&regressions={mode}&baseline={suite}/{machine}/{commit}&baseline={suite2}/{machine2}/{commit2}&highlight={commit}&highlight={commit2}`

`test` is present only while at most 10 tests are selected: with more, the URL
holds no `test` at all, and the page says that the URL does not reflect the
selection. `test_filter_regex=true` turns on the test filter's regex mode (see
AR9). On load, `test_filter` filters the test table as if it had been typed, and
a `test` that the test list for the selected machines and metric does not hold
is dropped. A `test` that does not match the filter stays selected (see GR1). Of
a URL naming more than 100 tests, which the page never writes, only the first
100 are selected (see GR7), before any of them is dropped.


### GR15: Regression Annotations

A dropdown toggle "Regressions: Off | Active | All" (default Off) in the
controls panel. "Active" covers the regressions still being worked on
(`detected` and `active`), and "All" covers every state. When enabled, a
vertical dashed line is drawn at the commit of each regression with an
indicator naming one of the plotted machines, the plotted metric, and one of
the selected tests. Lines are color-coded by state: red for `active`, yellow
for `detected`, and gray for the resolved states (`not_to_be_fixed`, `fixed`
and `false_positive`). The line itself is not hovered, so that the points along
it can be: each line has a marker of its color at its top, stacked downwards
when several regressions share a commit. Hovering a marker shows the regression
title and which of the selected tests it affects (the first ten, and how many
others), and a last line saying that clicking the marker shows the regression's
details. Clicking it opens a popover beside it, which behaves as a point's does
(GR11): it shows the regression's title, its UUID (shortened, see AR6, and
linking to its Regression Detail page), its state (as a colored badge), its
commit (linking to its Commit Detail page), its bug (see AR6), or `--` when it
has none, when it was created, and the selected tests it affects. One popover is
open at a time, a point's or a regression's.
A regression with no commit, or whose commit is not on the x-axis scaffold
(GR3), has no position on the chart and is not drawn. The selected mode is
persisted in the URL as `regressions={off|active|all}`.

The matching indicators come from the indicator lookup
(`POST /regressions/indicators/query`; see E8), given the plotted machines, the
metric, the selected tests and the mode's states. That lookup names each
regression by UUID only; their title, state and commit come from the regression
list (`GET /regressions`), joined on the UUID.


### GR16: Highlighted Commits

Highlighting a commit shows where it is in the history. A commit is highlighted
from a point's details (GR11), or by a link from another page, such as Compare's
"View on graph" (CP3). At most 10 commits are highlighted at once. They are kept
in the URL as `highlight={commit}`, one parameter per commit, in the order they
were highlighted.

Each highlighted commit is marked by:

- A see-through vertical band at the commit, spanning the plot under the
  traces. All bands have the same color, which no regression annotation uses
  (GR15). The band's width is a fixed number of pixels, so that it stays visible
  both at the full range of a long history and when zoomed in. A regression's
  line at the same commit is drawn over it.
- An open circle around each drawn trace's point at the commit, in the trace's
  color, so that the point stands out when the band covers several commits. A
  trace with no value at the commit has no circle. The circles fade with their
  trace when a test row is hovered (GR7).

The bands and circles don't react to hover or click: the points under them keep
their tooltips and details (GR10, GR11). A commit's band and circles are drawn
only while the commit is on the x-axis (GR3), like regression annotations.
Highlighted commits are not points: they don't affect the empty state (GR12),
and contribute no values to the y-axis range.

While a suite is selected, the controls show a removable chip for each
highlighted commit: "Highlighted: {display value}". The display value comes from
the x-axis, so while the commit is not on the x-axis, the chip shows the commit
string instead.

Highlighted commits are kept as given, without being looked up, even if the
suite has no such commit. This is an exception to AR2 "State": whether a commit
is drawn depends on the x-axis, which changes with the machines. The highlighted
commits change only through their chips, a point's details (GR11), or a suite
change (GR1). If the URL names a commit twice, it is highlighted once. If it
names more than 10 commits, which the page never does itself, only the first 10
are highlighted.
