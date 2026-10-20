# v5 Web UI: Compare Page

Page specification for the Compare page at `/compare`.


## Compare -- `/compare?suite_a={ts}&...`

Side-by-side comparison of two commits, or of some of their runs. This page is
suite-agnostic: each side selects its own suite. Layout:

```
# Compare

+-- Side A (Baseline) ----------------+       +-- Side B (New) -------------- [Pin as shadow] +
| Suite            [libcxx         v] |       | Suite            [libcxx                   v] |
| Machine          [linux-x86_64     ] | (<->) | Machine          [linux-x86_64               ] |
| Commit           [0f985af790f8     ] |       | Commit           [014621ede7c1               ] |
| Runs             [-] Run            |       | Runs             [x] Run                      |
|                  +----------------+ |       |                  +--------------------------+ |
|                  | [x] 08-25 ...  | |       |                  | [x] 2026-08-31, 3:03 PM  | |
|                  +----------------+ |       |                  +--------------------------+ |
+-------------------------------------+       +-----------------------------------------------+

Metric [Execution Time v]  Run aggregation [median v]  Sample aggregation [median v]
[ ] Hide noise  [Noise filtering v]
[Filter tests...] [ ] Regex

> Add to regression

<progress and errors>
[● Shadow: libcxx/linux-x86_64/0f69d2804b9b  x]
[▲ Shadow: libcxx/linux-x86_64/014621ede7c1 (1 of 2 runs)  x]
<chart>

o Improved 120 (40%)  o Regressed 30 (10%)  o Noise 0 (0%)  o Unchanged 150 (50%)  o Only in A 2  o Only in B 0  o Zero baseline 1

301 of 303 tests shown                                                [Columns] [Copy as CSV]
[-]  Test                 Value A    Value B    Delta     Delta %   Ratio     Status
     Geomean              ...
[x]  BM_find_if/1024      1.264      1.31       0.04575   +3.62%    1.0362    Regressed
[ ]  BM_sort/4096         ...
```


### CP1: Selection Panel

Each side has its own controls:

- **Suite**: a dropdown over the test suites defined on the instance. Changing
  the suite clears the side's machine, commit and runs.
- **Machine**: a combobox (see AR14) over the selected suite's machines (see
  AR18). The suite's full machine list is fetched once and filtered locally (see
  AR9). Disabled until a suite is selected, showing "Select a suite first". When
  the user picks another machine, the side keeps its commit if the new machine
  has runs at that commit (checked as AR15 describes), and selects all of those
  runs. Otherwise, the commit is cleared. Clearing the machine clears the
  commit and the runs.
- **Commit**: a commit picker (see AR15) over the commits at which the selected
  machine has runs. Disabled until a machine is selected, showing "Select a
  machine first". Clearing the commit clears the runs.
- **Runs**: a checkbox list of the selected machine's runs at the selected
  commit, in the order they were measured, in a box of its own that scrolls
  when they are many. Each run shows its measurement time and its shortened UUID
  linking to its Run Detail page. Every run is selected when a commit is
  picked, unless the URL names some of them (see CP7). Rows are selected one at
  a time, a range at a time with Shift, or all at once from the header (see
  AR10). Before a commit is selected, the list says "Select a commit first".

A **Swap sides** button between the two sides exchanges their suite, machine,
commit and runs, each side keeping the runs it had selected. No samples need to
be fetched again. The shadows are kept (see CP8).

Global controls, shared by both sides:

- **Metric**: a dropdown; one metric at a time, for both the table and the
  chart. Only numeric metrics (see D3) are offered, since Delta, Ratio and the
  geomean are undefined for `text` and `datetime`. When the two sides select
  different suites, a metric is offered only if both suites declare it, with
  the same `bigger_is_better` and the same `unit` (an unset unit matching only
  an unset one). While only one side has a suite, that suite's metrics are
  offered. The dropdown shows "-- Select metric --" until a metric is selected,
  and again if a side's suite changes so that the selected metric is no longer
  offered. It is disabled until a suite is selected. When the selected suites
  offer no metric, the page says so in place of the dropdown.
- **Run aggregation**: how each side's selected runs' values are combined (see
  CP2 "Aggregation pipeline"): median, mean, min or max, median by default. It
  is the same for both sides, so that Value A and Value B measure the same
  thing.
- **Sample aggregation**: how a test's samples within one run are combined (see
  CP2 "Aggregation pipeline"): median, mean, min or max, median by default.
- **Hide noise**: a checkbox that removes the rows classified as noise from the
  table and the chart.
- **Noise filtering**: a button opening a panel below it, over the page, which
  holds three independent knobs, one per row, and closes on Escape or a click
  outside it. Each knob has a checkbox to enable it (off by default) and a
  value. While a knob is disabled, so is its value's input: a value can only be
  typed once the knob is enabled. Closing the panel keeps the values typed in
  it, and a disabled knob keeps its value for when it is enabled again. A test
  is classified as **noise** if any enabled knob triggers for it. When every
  knob is disabled, no test is noise. Each knob's label has a help tooltip
  saying what the knob does.
  - **Delta % below** (1 by default, at least 0): triggers when |Delta %| is
    below the value.
  - **P-value above** (0.05 by default, between 0 and 1): triggers when the
    p-value of Welch's t-test between the two sides' samples for the test (see
    CP2 "Computation Reference") exceeds the value, i.e. the difference is not
    statistically significant. Skipped when either side has fewer than 2
    samples. If both sides have zero variance, the knob is skipped when their
    means are equal. When they differ, the change is deterministic, so the knob
    does not trigger (its p-value is taken as 0).
  - **Absolute below** (0 by default, at least 0): triggers when
    max(|Value A|, |Value B|) is below the value, which is in the metric's raw
    unit. For measurements too small to be meaningful.

  If the user enters a value that is not a number, or is out of range, the
  input shows the red halo (see AR11), and the knob keeps using its last valid
  value.
- **Test filter**: a text filter on test names, with regex mode (see AR9).

There is no Compare button. The comparison is computed automatically once both
sides have at least one run selected, a metric is selected, and the samples of
every selected run have loaded (see CP6). After that, it updates whenever the
controls change.


### CP2: Comparison Table

**Rows.** The comparison has one row for each test that has a value for the
selected metric on at least one side. Tests are matched by name, even when the
two sides use different suites. The table shows the rows that match the test
filter. When "Hide noise" is checked, it also leaves out the rows classified as
noise. The geomean summary row is always first, whatever the sort, and is left
out when the table has no other row.

| Column   | Description                                              |
|----------|----------------------------------------------------------|
| Test     | Test name, after the row's checkbox                      |
| Value A  | Aggregated metric value from side A, or N/A when it has none |
| Value B  | Aggregated metric value from side B, or N/A when it has none |
| Delta    | `vB - vA`                                                |
| Delta %  | `(vB - vA) / \|vA\| * 100`; see Computation Reference for sign convention and edge cases |
| Ratio    | `vB / vA`; same quantity plotted on the chart as `log2(Ratio)` |
| Status   | Improved / Regressed / Unchanged / Noise / N/A; see Computation Reference for classification rules |

**Hidden tests.** Each row has a checkbox, checked by default. Unchecking it
hides the test: the row stays in the table, greyed out and in the same
position, but the test no longer counts in the comparison's results (see
"Compared rows" below). There is no limit on how many tests can be shown.
Clicking a row, Shift-clicking (see AR10) and the header checkbox work as in
the Graph's test table (see GR7), on the rows currently in the table.
Double-clicking a row hides all the other rows in the table. Double-clicking it
again, when it is the only row shown, shows all of them again. Tests that are
not in the table, because of the filter or "Hide noise", are never affected.

The test filter and "Hide noise" don't change which tests are hidden: when the
filter is cleared, the rows it removed come back with the checkboxes they had.
When the comparison changes (another commit, other runs, another metric), a
hidden test that is still in the comparison stays hidden, and new tests are
shown. Hidden tests that are no longer in the comparison are forgotten, but
only once the new comparison has fully loaded (see AR2 "State").

**Compared rows** are the rows in the table whose checkbox is checked. The chart
(see CP3), the geomean summary row, Copy as CSV and Add to Regression (see CP9)
all use these rows.

- **Geomean summary row**: no checkbox; see Computation Reference.
- **Sorting**: by any column but the checkboxes and Profile, by clicking its
  header. The default is Delta % descending. N/A sorts last in both
  directions. Status sorts improved, regressed, noise, unchanged, then N/A.
  Ties are broken by test name, ascending.
- **Status colors**: green for improved, red for regressed. Noise rows show a
  grey "noise" label, whose tooltip lists each knob that triggered, with the
  test's value and the knob's threshold.
- **Sample count tooltips**: Value A and Value B have a tooltip saying how many
  samples and runs the value was computed from, e.g. "6 samples across 2
  runs". Delta, Delta % and Ratio show both sides: "A:
  6 samples across 2 runs, B: 4 samples across 1 run". A side with no value,
  and the geomean summary row, have no tooltip.
- **Summary message**: above the rows, a message says how many of the table's
  rows are shown, as the Graph's test table does (see GR6): "120 of 150 tests
  shown", or with the test filter set, "30 of 42 matching tests shown (150
  total)". Rows removed by "Hide noise" are not counted. When too many tests
  are hidden for the URL to record them (see CP7), the message says so.
- **Copy as CSV**: a clipboard button at the end of the summary message row
  copies the compared rows as CSV, in the current sort order, with the geomean
  summary row first. The columns are the table's: Test, Value A, Value B,
  Delta, Delta %, Ratio, the optional columns shown, and Status. Numbers are
  written at full precision, and an N/A cell is left empty. The button briefly
  shows whether the copy succeeded. It is hidden when there is no compared row.
- **Optional columns**: a "Columns" button on the summary message row opens a
  menu of checkboxes, one per key below, adding statistics columns to the
  table, all off by default:

  | Column   | Key            | Per side | Value                                        | N/A when                          |
  |----------|----------------|----------|----------------------------------------------|-----------------------------------|
  | Samples  | `samples`      | yes      | The number of samples                        | Never (0 on a side with none)     |
  | Mean     | `mean`         | yes      | The arithmetic mean                          | The side has no samples           |
  | Median   | `median`       | yes      | The median                                   | The side has no samples           |
  | Min, Max | `min`, `max`   | yes      | The smallest and largest sample              | The side has no samples           |
  | Std dev  | `stddev`       | yes      | The sample standard deviation (`n - 1`)      | Fewer than 2 samples              |
  | CV %     | `cv`           | yes      | `Std dev / \|Mean\| * 100`                   | Std dev is N/A, or Mean is 0      |
  | P-value  | `pvalue`       | no       | Welch's t-test p-value, as for the P-value knob, whether or not the knob is enabled; 0 where the knob treats the change as deterministic | The knob would be skipped |

  Statistics are computed over the side's samples for the test (see
  Computation Reference), from all its selected runs together, before any
  aggregation: the sample and run aggregation settings do not affect them. A
  line above the Columns menu's items says that they are computed over all
  samples without aggregation. A p-value is shown as AR6 shows a measured
  `real` value, so a tiny one in exponent notation (`2.012e-29`).

  A per-side statistic adds an A and a B column. Optional columns sit between
  Ratio and Status, in the order above, A before B. They are empty on the
  geomean summary row. They are sortable. If the column the table is sorted by
  is removed, the table goes back to its default sort.
- **Profile column**: when either side has a profile for a test in its
  selected runs, a "Profile" link leads to the Profiles page, pre-populated as
  PF1 describes. The column comes last, and cannot be sorted by. It is shown
  while any test of the comparison has a profile, whatever the test filter,
  "Hide noise" and the hidden tests.
- **Width**: when the columns don't fit in the page's width, the table scrolls
  horizontally in a box of its own rather than squeezing the Test column. The
  rest of the page, the summary message row included, stays in place. The
  checkboxes and the Test column stay in view while the other columns scroll.


#### Computation Reference

**A side's samples for a test** are all the samples of that test, across the
side's selected runs, that have a value for the selected metric. A run with N
such samples contributes N values. The P-value knob, the optional statistics
columns and the sample count tooltips all use these samples, before any
aggregation.

**Aggregation pipeline.** The values `vA` and `vB` shown in the table are
produced by a two-stage aggregation pipeline:
1. **Sample aggregation** (within each run): when a test appears multiple times
   in a run's samples, the sample aggregation function (median/mean/min/max)
   reduces them to one value per test per run.
2. **Run aggregation** (across selected runs): each side's per-run values are
   reduced by the run aggregation function (median/mean/min/max) to produce the
   final `vA` and `vB`.

Only samples with a value for the metric are used. A run with no such sample
for a test is left out of that test's run aggregation.

**Per-test derived columns** (given `vA`, `vB` as defined above):

| Quantity   | Formula                    | Domain                           |
|------------|----------------------------|----------------------------------|
| Delta      | `vB - vA`                  | always defined                   |
| Delta %    | `(vB - vA) / \|vA\| * 100` | undefined (N/A) when `vA = 0`    |
| Ratio      | `vB / vA`                  | undefined (N/A) when `vA = 0`    |

Notes:
- Delta % uses `|vA|` (not `vA`) in the denominator so its sign always matches
  the sign of Delta, even when the baseline is negative. Without the absolute
  value, a negative baseline would flip the percentage sign.
- For positive baselines, `Delta % = (Ratio - 1) * 100`, so Delta % and Ratio
  carry the same information in different forms.

**N/A.** When a side has no value for a test, Delta, Delta %, Ratio and Status
are N/A. When `vA = 0` (a zero baseline), Delta is computed, but Delta %, Ratio
and Status are N/A. Noise knobs are not evaluated for these tests.

**Status classification** (for tests whose status is not N/A, checked in this
order):
1. If any enabled noise knob triggers -> `noise`
2. If `Delta = 0` -> `unchanged`
3. If `bigger_is_better` and `Delta > 0` -> `improved`
4. If `bigger_is_better` and `Delta < 0` -> `regressed`
5. If not `bigger_is_better` and `Delta < 0` -> `improved`
6. If not `bigger_is_better` and `Delta > 0` -> `regressed`

Status uses the sign of Delta (not Ratio) combined with `bigger_is_better`.

**Geomean summary row.** Computed over the N compared rows where both sides
have a value and both values are non-zero:

| Quantity        | Formula                                     |
|-----------------|---------------------------------------------|
| Geomean A       | `exp(mean(ln(\|vA_i\|)))` for i = 1..N      |
| Geomean B       | `exp(mean(ln(\|vB_i\|)))` for i = 1..N      |
| Ratio (geomean) | `exp(mean(ln(\|ratio_i\|)))` for i = 1..N   |
| Delta           | `Geomean B - Geomean A`                     |
| Delta %         | `(Delta / \|Geomean A\|) * 100`             |

Absolute values are taken before computing the geometric mean so that negative
metric values do not produce undefined logarithms. Since all three are taken
over the same N tests, the geometric mean of the ratios equals
`Geomean B / Geomean A`.

The row's Status is classified from its Delta by steps 2 to 6 above: it is
never `noise`. When N is 0, the row shows N/A throughout.

**Chart Y-axis.** The chart plots `log2(Ratio)` = `log2(vB / vA)`. The log2
scale makes equal multiplicative changes symmetric: a 2x speedup (ratio = 0.5)
and a 2x slowdown (ratio = 2.0) appear at -1 and +1 respectively, equidistant
from zero.

A compared row is left off the chart when any of these conditions hold:
- Only one side has a value
- `vA = 0` (ratio undefined)
- Ratio <= 0 (log2 undefined -- occurs when `vA` and `vB` have opposite signs,
  or when `vB = 0`)

**Noise band on chart.** When the Delta % knob is enabled, horizontal dashed
lines are drawn at the log2-space equivalents of the threshold:
- Upper line: `log2(1 + threshold/100)`
- Lower line: `log2(1 - threshold/100)` when threshold < 100%; otherwise
  `-log2(1 + threshold/100)` (forced symmetric, because `log2(1 - t/100)` is
  undefined when `t >= 100%`)

For small thresholds these lines are approximately symmetric (e.g. 5% maps to
+0.070 / -0.074). The asymmetry grows with larger thresholds. A test whose bar
falls inside the band has `|Delta %| < threshold`.


### CP3: Chart

A bar chart of the compared rows (see CP2), sorted by ratio. Rows that cannot be
plotted are left out (see Computation Reference).
- **X-axis**: tests, sorted by ratio, ascending
- **Y-axis**: `log2(Ratio)` -- see Computation Reference. Tick labels show the
  equivalent percentage change at "nice" values (+/-1%, +/-5%, +/-10%,
  +/-50%, +/-100%, etc.), adapted to the range shown, so that zooming into a
  narrow range shows finer ticks
- Rendered as bars, one per test, colored by status (see CP2)

Interactivity:
- **Hover**: tooltip showing test name, exact ratio, the values of both sides,
  and Delta %. It also highlights the bar's table row (see CP5).
- **Zoom**: dragging zooms into part of the chart, and double-clicking resets
  the zoom. The user's zoom is kept when settings change, but is reset when the
  comparison is replaced: a different suite, machine, commit or runs on either
  side, swapping the sides, or a different metric. When the user hasn't
  zoomed, both axes fit everything plotted: the bars, the shadows' lines and the
  noise band. Zooming does not filter the table.
- **Noise band**: see Computation Reference for how the Delta % threshold is
  converted to log2 space. The p-value and absolute floor knobs do not have
  chart-level visualization.
- **Empty state**: when there is a comparison but neither the bars nor any
  shadow's line (see CP8) have anything to plot, the chart area displays "No
  data to plot", as on the Graph page (see GR12). CP6 says what is shown while
  there is no comparison.


### CP4: Comparison Summary Bar

A horizontal summary bar between the chart and the comparison table counts the
tests in each category, with percentages for comparable categories. Every test
counts in exactly one category:

| Category      | Counts tests that                                |
|---------------|--------------------------------------------------|
| Improved      | have Status Improved (see CP2)                   |
| Regressed     | have Status Regressed                            |
| Noise         | have Status Noise                                |
| Unchanged     | have Status Unchanged                            |
| Only in A     | have a value on side A only                      |
| Only in B     | have a value on side B only                      |
| Zero baseline | have a value on both sides, with a zero baseline |

Each category shows a colored dot, its label and its count. The dot is green
for Improved and red for Regressed (the status colors of CP2), and grey for the
others.

**Comparable categories** (Improved, Regressed, Noise, Unchanged) also show a
percentage, whose denominator is the sum of comparable categories only.
Percentages use one decimal place, except whole numbers drop the trailing `.0`
(e.g. `25%` not `25.0%`). When there are no comparable tests, they show just
the count. A tooltip on each percentage explains its denominator.

**What is counted**: every test in the comparison that matches the test
filter, including hidden tests and noise tests, even when "Hide noise" is
checked.

Categories with a count of zero are shown muted rather than hidden, so that the
bar's layout stays stable. When there is no comparison, the bar renders nothing.


### CP5: Chart-Table Sync

The chart shows the compared rows (see CP2), so the test filter, "Hide noise"
and the hidden tests affect the chart and the table in the same way. Hovering a chart bar highlights its table
row, and hovering a table row highlights its chart bar. Neither scrolls the
page or the table.


### CP6: Data Flow

- Each side's metrics come from its suite's schema, as listed by `GET suites`.
- A suite's machines come from `GET machines`. They are fetched once per suite,
  and shared by both sides and the shadows. A side's commit picker
  searches `GET commits?machine={name}&sort=-ordinal` (see AR15).
- A side's runs come from `GET runs?machine={name}&commit={value}`, every page
  of it. The side has no runs to compare until the whole list has loaded.
- The samples of each selected run come from `GET runs/{uuid}/samples`, every
  page of it, in as few requests as the API allows. Once fetched, a run's
  samples are kept for as long as the run belongs to one of the sides' or the
  shadows' commits. This way, changing the metric, an aggregation, the noise
  settings, the run selection or the hidden tests, swapping the sides, or
  pinning a shadow never fetches them again. If a run stops belonging to any of
  those commits while its samples are loading, its loading stops, without
  affecting the other runs.
- The Profile column needs to know which tests of each side have a profile. For
  each side, `GET runs?machine={name}&commit={value}&has_profiles=true` lists
  the runs that have profiles, and `GET runs/{uuid}/profiles` lists the
  profiles of each of them that is selected. This never delays the
  comparison.
- When the page is loaded from a URL, it sends all the requests that the URL's
  values call for at once, without first checking that the values are usable.
  There are exceptions: the page waits for the list of suites before it
  fetches the suite's machines or looks up the commit (see AR15), because both
  need the suite's schema. The commit's display value, for example, comes from
  the schema. A shadow's commit is looked up only once its suite's machines are
  listed and hold its machine (see CP8). A side whose URL names no runs can only
  ask for samples once its runs are listed, and a shadow only asks for its runs'
  samples once they are listed. If a value turns out to be unusable, the page discards what
  it fetched for that value and does not report its failures (see AR2
  "State").

While the samples are loading, a progress indicator shows how many of the
selected runs have loaded, in place of the comparison. The page never shows a
comparison that does not match the current controls.

When the page cannot fetch something it needs -- the suites, a suite's machines,
a side's runs, a commit lookup, a selected run's samples or profiles, a
shadow's runs or samples -- it says so (see AR7). If the samples of any selected
run cannot be fetched, no comparison is shown, rather than one silently based on
fewer runs. If profiles cannot be fetched, only the Profile links are missing.

**Empty states.** Until the comparison can be computed, the page says in its
place what is still missing: a suite, a machine, a commit, a selected run on a
side, or the metric. Once there is a comparison, the table says
`No test has a value for this metric.` when it holds no row,
`No tests match the filter.` when the filter keeps none, and
`Every matching test is classified as noise.` when "Hide noise" removes every
row the filter keeps.


### CP7: URL State

All selection state is encoded as query parameters for shareability:
- `suite_a`, `machine_a`, `commit_a`, `runs_a`
- `suite_b`, `machine_b`, `commit_b`, `runs_b`
- `metric`, `run_agg`, `sample_agg`
- `noise_pct`, `noise_pval`, `noise_floor`: present only while the knob is
  enabled, holding the value the knob uses (see CP1). A disabled knob's value
  is not saved in the URL.
- `hide_noise=true`
- `test_filter`, and `test_filter_regex=true` when its regex mode is on (see
  AR9)
- `hidden_test`: the hidden tests (see CP2), present only while at most 10 tests
  are hidden. With more, the URL holds no `hidden_test` at all, and the page
  says so (see CP2 "Summary message").
- `columns`: the keys of the optional columns shown (see CP2)
- `sort`: the comparison table's sort column (`test`, `value_a`, `value_b`,
  `delta`, `delta_pct`, `ratio` or `status`, or the key of an optional column
  shown, suffixed with `_a` or `_b` for a per-side one), prefixed with `-` for
  descending
- `shadow`: the shadows (see CP8)

`runs_a`, `runs_b`, `hidden_test`, `columns` and `shadow` repeat their
parameter once per value (see AR2 "State"). `runs_a` and `runs_b` are left out when all of the
side's runs are selected, which is the default. They are left out too when none
is, since the URL cannot say so: loading such a URL selects every run.

A value the page cannot use is dropped (see AR2 "State"):
- a suite or machine that does not exist, a commit the side's commit picker
  would not offer (see AR15), or a machine named without a suite or a commit
  without a machine, along with whatever CP1 clears when that control is
  cleared;
- a run that is not in the side's run list; if this leaves no run, all of the
  side's runs are selected;
- a metric the page does not offer;
- a noise value that is not a number or is out of range; the knob is then
  disabled;
- a `sort` on a column that is not shown; the default sort is used instead;
- a hidden test that is not in the comparison.


### CP8: Shadow Traces (Comparison Overlays)

A shadow overlays a pinned comparison on the chart, allowing the user to
visually compare how a ratio profile changed between versions of side B against
a shared baseline (side A). For example: pin GCC vs LLVM20, then change side B
to LLVM21 to see both comparisons overlaid, pin that too, and change side B to
LLVM22 to see all three.

A shadow is a pinned specification: a suite, a machine, a commit, and the runs
selected among the commit's runs, as side B had them when pinned. It keeps them
whatever happens to side B afterwards. Its runs are kept as the URL holds them
(see CP7): when every run of side B was selected, the shadow selects every run
of its commit.

**Pinning.** A "Pin as shadow" button, in the header of side B's panel, pins
side B as it is as a new shadow, after those already pinned. It is shown while
there is a comparison. It is disabled, saying why on hover and to assistive
technology, while side B as it is -- the same suite, machine, commit and runs --
is pinned already, and once 5 shadows are pinned: beyond that, the chart is
unreadable. A shadow just pinned gives the focus to its chip's dismiss button.

**Chips.** Each shadow has a chip above the chart, in the order they were
pinned: "Shadow: {suite}/{machine}/{commit}", where `{commit}` is the commit's
display value (see AR6), or the commit string until it is known, followed by
" ({k} of {n} runs)" when the shadow selects only some of its commit's runs,
once they are listed. The chip shows the shadow's color and marker (see
"Rendering"), and has a dismiss (×) button. Dismissing a shadow gives the focus
to the dismiss button of the chip after it, or else before it, or to the pin
button once none is left; while there is no comparison, and so no pin button,
it goes back to the page. Chips are shown whether or not there is a comparison,
so that shadows can always be dismissed.

**Rendering:**
- Each shadow's comparison is computed the same way as the main one, between
  side A and the shadow's runs. Its line plots the compared rows (see CP2) that
  can be plotted in the shadow's comparison, each at its ratio there. A test can
  have a point without a bar, or a bar without a point.
- Each line is sorted by its own ratios, so a test's point on a line is not
  necessarily above its bar. The X-axis is wide enough for whichever of the
  bars and the lines has the most tests. The lines are drawn over the bars, in
  the order the shadows were pinned.
- Each shadow has a color and a marker of its own, given by its position among
  the shadows, so that dismissing a shadow changes those of the shadows after
  it. The colors differ from each other, from the status colors of the bars and
  from the outline of a bar whose row is hovered (see CP5), and have a contrast
  of at least 3:1 against the page's background. Colors alone cannot keep five
  lines apart for every reader, which the markers do. The chart has no legend:
  the chips serve as one.
- Hovering a point of a line shows the same information as a main bar, with a
  line naming its shadow as its chip does. Table-to-chart hover highlighting
  targets the main bars only, and hovering a point of a line highlights no row.
- If side A's suite and a shadow's suite don't both offer the selected metric,
  under CP1's rule for comparing a metric across suites, that shadow draws
  nothing.

**Scope:** chart only -- no table columns, no summary bar counts. Add to
Regression (see CP9) operates on the main comparison only.

**What they follow.** The shadows follow changes to the metric, the run and
sample aggregations, the compared rows, and side A. Changing side A's suite,
machine, commit or runs, clearing them, or swapping the sides keeps the
shadows, whose lines are computed again against the new side A. While there is
no comparison, as when side A has no commit, nothing is drawn, but the shadows
are kept. A swap drops no shadow: one equal to the new side A draws a flat line
at 0%, and one equal to the new side B lies on the bars.

**Data:** a shadow's runs are listed, and its selected runs' samples fetched,
as a side's are (see CP6). Its commit is looked up as a commit given to a
commit picker is (see AR15), once its suite's machines are listed and hold its
machine. The main comparison never waits for the shadows. A shadow's line is
drawn only once all its samples have loaded. If something a shadow needs cannot
be fetched, its line is not drawn, and the page says that a shadow could not be
loaded, offering to try again everything that failed (see AR7). A failure for a
run that a side selects too is reported as the side's.

**URL encoding:** the URL holds each shadow as a `shadow` parameter (see CP7),
in the order they were pinned: `{suite}/{machine}/{commit}`, followed by
`/{run},{run}...` when it selects only some of its commit's runs, named by
their UUIDs, each once, in ascending order. None of the names can contain a `/`
(see I1), and only the runs are told apart by commas, which a machine or a
commit may contain. A value with fewer than three parts or more than four, or
with an empty part or run, is malformed. As soon as the URL is read, malformed
values are dropped, then repeated ones, then any beyond the first 5. A shadow is
dropped once its suite or machine turns out not to exist, or its commit to be
one its machine's commit picker would not offer (see AR15); the other shadows
are kept. Once its runs are listed, those it names that are not among them are
dropped. If that leaves none, or it names every run, it selects every run, which
the URL holds by naming none.


### CP9: Add to Regression

A box of its own, below the controls shared by both sides, creates regression
indicators from the comparison. Its header, "Add to regression", expands and
collapses it, with an arrow saying which it does; the box starts collapsed. It
works on side B: each indicator
names side B's machine, the selected metric, and a test. One indicator is
created for each compared row (see CP2) that has a value on side B. Rows
without one are skipped: the test was not measured on side B, and side B's
suite may not even have it. The regression belongs to side B's suite.

The header requires `triage` scope (see AR17). While the box is collapsed, the
header is disabled, with an explanation, when there would be no indicators, or
more than one request can carry (I2's maximum page size; see E8). While it is
expanded, the header collapses it, except while a request is under way.

When expanded, the box first lists what the indicators are, a line each: how
many tests compared they cover (Covers), side B's suite (Test Suite), the
metric, side B's machine, and side B's commit, shown by its display value (see
AR6), which a new regression is attributed to. Below, it says how many tests
compared are left out for having no value on side B, if any are. It follows
the compared rows as they change. Then it offers:
- "Create new regression" -- a title input, which may be left empty, and a
  button that creates a regression in side B's suite, attributed to side B's
  commit, with those indicators.
- "Add to existing" -- a regression picker over side B's suite, and a button
  that adds the indicators to the regression picked. The picker searches the
  server (see AR9), starting from the first page of
  `GET regressions?sort=-created_at`, and matches the title or a prefix of the
  UUID. Each suggestion shows the regression's title, or `(untitled)` and its
  shortened UUID when it has none. While the picker holds text that was not
  picked, the button does nothing, and the panel says so, as for a commit
  picker (see AR15).

The box is a form (see AR2 "State"). When there would be no indicators, or
too many, its buttons are disabled, and it says why. Changing side B's suite,
or swapping the sides, clears the picked regression. If creating the
regression or adding the indicators fails, the box stays open and says why.

Collapsing the box clears its title and picked regression. Once the regression
is created, or the indicators added, the box collapses, its header takes the
focus, and a message beside the header says what was done, until the box is
opened again:
- "Regression created: " followed by a link to the new regression's detail
  page;
- "Added N indicators to " followed by a link to the regression's detail page,
  where N is the number of new indicators. If some already existed, the message
  also says how many (as in DT4).

Each link's text is the regression's title, or its shortened UUID when it has
none.
