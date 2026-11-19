# v5 Web UI: Compare Page

Page specification for the Compare page at `/compare`.


## Compare -- `/compare?project_a={p}&suite_a={s}&...`

Side-by-side comparison of two commits, or of some of their runs. This page is
suite-agnostic: each side selects its own suite. Layout:

```
# Compare

+-- Side A (Baseline) ----------------+       +-- Side B (New) -------------- [Pin as shadow] +
| Suite            [libc++ › Ben…  v] |       | Suite            [libc++ › Benchmarks      v] |
| Machine          [linux-x86_64     ] | (<->) | Machine          [linux-x86_64               ] |
|                                   ⓘ |       |                                              ⓘ |
| Commit           [0f985af790f8    ] |       | Commit           [014621ede7c1              ] |
| Runs             [-] Run            |       | Runs             [x] Run                      |
|                  +----------------+ |       |                  +--------------------------+ |
|                  | [x] 08-25 ...  | |       |                  | [x] 2026-08-31, 3:03 PM  | |
|                  +----------------+ |       |                  +--------------------------+ |
+-------------------------------------+       +-----------------------------------------------+
Diff on GitHub: 0f985af790f8 → 014621ede7c1

Metric [Execution Time v]  Run aggregation [median v]  Sample aggregation [median v]
[Filter tests...] [ ] Regex
Margin [5] %  Confidence [90% v]  [ ] Hide unchanged  [ ] Hide inconclusive  [Filters v]

> Add to regression

<progress and errors>
[● Shadow: libc++ › Benchmarks › linux-x86_64 › 0f69d2804b9b · 298 tests  x]
[▲ Shadow: libc++ › Benchmarks › linux-x86_64 › 014621ede7c1 (llvmorg-21.1.0) · 1 of 2 runs · 301 tests  x]
<chart>

o Improved 120 (40%)  o Regressed 30 (10%)  o Unchanged 100 (33.3%)  o Inconclusive 50 (16.7%)  o Only in A 2  o Only in B 0  o Zero baseline 1

301 of 303 tests shown                                                [Columns] [Copy as CSV]
[-]  Test                 Value A    Value B    Delta     Delta %   Ratio     Status
     Geomean              ...
[x]  BM_find_if/1024      1.264      1.31       0.04575   +3.62%    1.0362    Inconclusive
[ ]  BM_sort/4096         ...
```


### CP1: Selection Panel

Each side has its own controls:

- **Suite**: a dropdown over the test suites defined on the instance, grouped by
  project (see AR22). Changing
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
  machine first". Clearing the commit clears the runs. Once the side has a
  commit, a small ⓘ gives its card (see AR21), from the end of the picker's
  label line: beside the label rather than in it, so that it is no part of the
  picker's name. It is named `Commit` followed by the commit's display value, as
  the picker shows it.
- **Runs**: a checkbox list of the selected machine's runs at the selected
  commit, in the order they were measured, in a box of its own that scrolls
  when they are many. Each run shows its measurement time and its shortened UUID
  linking to its Run Detail page. Every run is selected when a commit is
  picked, unless the URL names some of them (see CP7). Rows are selected one at
  a time, a range at a time with Shift, or all at once from the header (see
  AR10). Before a commit is selected, the list says "Select a commit first".

Each side's controls span its box, and the two sides share the width equally,
so that nothing moves as a side's selections change, such as when its runs are
listed.

Below the two sides, "Diff on {label}" (see AR20), followed by the two commits'
display values, as in `Diff on GitHub: 0f985af790f8 → 014621ede7c1`, links the
changes from side A's commit, which fills in `from`'s placeholders, to side
B's, which fills in `to`'s, even when B's is the older. It is shown only while
both sides have a commit in the same suite, since suites may have different
templates, and the commits can fill its template in (see CP6): it is not shown
disabled. When it appears, it pushes what is below it down a line, as a side's
runs do when they are listed.

A **Swap sides** button between the two sides exchanges their suite, machine,
commit and runs, each side keeping the runs it had selected. No samples need to
be fetched again. The shadows are kept (see CP8).

Global controls, shared by both sides:

- **Metric**: a dropdown; one metric at a time, for both the table and the
  chart. Only numeric metrics (see D3) are offered, since Delta, Ratio and the
  geomean are undefined for `text` and `datetime`. When the two sides select
  different suites, a metric is offered only if both suites declare it, with
  the same `bigger_is_better` and the same `unit` (an unset unit matching only
  an unset one). These metrics are listed in side A's schema order (see AR6).
  While only one side has a suite, that suite's metrics are offered. The
  dropdown shows "-- Select metric --" until a metric is selected, and again if
  a side's suite changes so that the selected metric is no longer offered. It
  is disabled until a suite is selected. When the selected suites offer no
  metric, the page says so in place of the dropdown.
- **Run aggregation**: how each side's selected runs' values are combined (see
  CP2 "Aggregation pipeline"): median, mean, min or max, median by default. It
  is the same for both sides, so that Value A and Value B measure the same
  thing.
- **Sample aggregation**: how a test's samples within one run are combined (see
  CP2 "Aggregation pipeline"): median, mean, min or max, median by default.
- **Test filter**: a text filter on test names, with regex mode (see AR9).
- **Margin**: a percentage `m`, at least 0, 5 by default: how large a change
  has to be to matter, as a ratio: beyond a factor of `1 + m` either way, so
  that 5% means above ×1.05 or below ÷1.05 (-4.76%) (see CP2 "Status
  classification").
- **Confidence**: a dropdown of the confidence levels of the intervals that
  classify the tests: 80%, 90%, 95% or 99%, 90% by default.
- **Hide unchanged**, **Hide inconclusive**: checkboxes that remove the rows
  whose status is Unchanged, or Inconclusive, from the table and the chart.
- **Filters**: a button opening a panel below it, over the page, which holds
  three filters, one per row, and closes on Escape or a click outside it. The
  button says how many filters apply, as in `Filters (2)`, while any does.
  Each filter has a checkbox to enable it (off by default) and a value. While a
  filter is disabled, so is its value's input: a value can only be typed once
  the filter is enabled. Closing the panel keeps the values typed in it, and a
  disabled filter keeps its value for when it is enabled again.
  - **|Delta %| at least** (1 by default, at least 0): |Delta %| is at least
    the value.
  - **P-value at most** (0.05 by default, between 0 and 1): the test's p-value
    (see CP2 "Computation Reference") is at most the value. A test without a
    p-value fails it. While a side has fewer than 2 selected runs, no test can
    have one: the filter's checkbox and value are then disabled, saying why on
    hover and to assistive technology, and the filter does not apply. It keeps
    its setting, in the URL too.
  - **Absolute at least** (0 by default, at least 0): max(|Value A|,
    |Value B|), in the metric's unit, is at least the value. For measurements
    too small to be meaningful.

  A test passes the filters when it passes every one that applies. A test whose
  status is N/A passes every filter. The filters never change a test's status:
  they only narrow the tests looked at (see CP2 "Rows" and CP4).

The labels of the margin, the confidence and each filter have a help tooltip
saying what they do. The margin and the filters' values are typed. A value is
applied once typing pauses, or as the Filters panel closes, if that is sooner.
If the text is not a number, is out of range, or is empty, the input shows the
red halo (see AR11), and the last valid value stays in use.

There is no Compare button. The comparison is computed automatically once both
sides have at least one run selected, a metric is selected, and the samples of
every selected run have loaded (see CP6). After that, it updates whenever the
controls change.


### CP2: Comparison Table

**Rows.** The comparison has one row for each test that has a value for the
selected metric on at least one side. Tests are matched by name, even when the
two sides use different suites. The table shows the rows that match the test
filter and pass the filters (see CP1). When "Hide unchanged" or "Hide
inconclusive" is checked, it also leaves out the rows with that status. The
geomean summary row is always first, whatever the sort, and is left out when
the table has no other row.

| Column   | Description                                              |
|----------|----------------------------------------------------------|
| Test     | Test name, after the row's checkbox                      |
| Value A  | Aggregated metric value from side A, or N/A when it has none |
| Value B  | Aggregated metric value from side B, or N/A when it has none |
| Delta    | `vB - vA`                                                |
| Delta %  | `(vB - vA) / \|vA\| * 100`; see Computation Reference for sign convention and edge cases |
| Ratio    | `vB / vA`; same quantity plotted on the chart as `log2(Ratio)` |
| Status   | Improved / Regressed / Unchanged / Inconclusive / N/A; see Computation Reference for classification rules |

**Hidden tests.** Each row has a checkbox, checked by default. Unchecking it
hides the test: the row stays in the table, greyed out and in the same
position, but the test no longer counts in the comparison's results (see
"Compared rows" below). There is no limit on how many tests can be shown.
Clicking a row, Shift-clicking (see AR10) and the header checkbox work as in
the Graph's test table (see GR7), on the rows currently in the table.
Double-clicking a row hides all the other rows in the table. Double-clicking it
again, when it is the only row shown, shows all of them again. Tests that are
not in the table, because of the test filter, the filters, "Hide unchanged" or
"Hide inconclusive", are never affected.

None of those change which tests are hidden: when the test filter is cleared,
say, the rows it removed come back with the checkboxes they had.
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
  directions. Status sorts improved, regressed, unchanged, inconclusive, then
  N/A. Ties are broken by test name, ascending.
- **Status colors**: green for improved, red for regressed, amber for
  inconclusive, and grey otherwise. The four colors differ from each other, and
  amber has a contrast of at least 3:1 against the page's background.
- **Status tooltip**: a test's status, unless N/A, gives on hover the bounds of
  its confidence interval, as the CI column shows them, and what they do
  against the margin, as in `90% CI is [-1.20%, +7.60%]: may or may not exceed
  the 5% margin` (`over` for improved and regressed, `under` for unchanged);
  or why there is none: `Only 1 run on side A: a CI needs at least 2 runs on
  each side` (or side B, or each side), or that a run's value is 0 or negative,
  which it says when both apply. The geomean summary row's status has no
  tooltip.
- **Sample count tooltips**: Value A and Value B have a tooltip saying how many
  samples and runs the value was computed from, e.g. "6 samples across 2
  runs". Delta, Delta % and Ratio show both sides: "A:
  6 samples across 2 runs, B: 4 samples across 1 run". A side with no value,
  and the geomean summary row, have no tooltip.
- **Summary message**: above the rows, a message says how many of the table's
  rows are shown, as the Graph's test table does (see GR6): "120 of 150 tests
  shown", or while the test filter is set or a filter applies, "30 of 42
  matching tests shown · 150 tests in total". Rows removed by "Hide unchanged"
  and "Hide inconclusive" are not counted. When too many
  tests are hidden for the URL to record them (see CP7), the message then says
  so, and why on hover and to assistive technology: "30 of 42 matching tests
  shown · 150 tests in total · too many hidden to reflect in the URL".
- **Copy as CSV**: a clipboard button at the end of the summary message row
  copies the compared rows as CSV, in the current sort order, with the geomean
  summary row first. The columns are the table's: Test, Value A, Value B,
  Delta, Delta %, Ratio, the optional columns shown, and Status, except that
  the CI column is written as three: `CI estimate %`, then `{c}% CI low %` and
  `{c}% CI high %`, where `{c}` is the confidence level, each a percentage
  change. Numbers are written at full precision, a CI bound too large to be
  represented as `Infinity`, and an N/A cell is left empty.
  The button briefly shows whether the copy succeeded. It is hidden when there
  is no compared row.
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
  | CI       | `ci`           | no       | The confidence interval of the change (see Computation Reference), at the confidence level chosen, which the header names, as in `90% CI` | The test has no interval |
  | P-value  | `pvalue`       | no       | The p-value of the change (see Computation Reference) | The test has no interval |

  The statistics from Samples to CV % are computed over the side's samples for
  the test (see Computation Reference), from all its selected runs together,
  before any aggregation: the sample and run aggregation settings do not affect
  them. The CI and the p-value come from the runs' values (see Computation
  Reference). A line above the Columns menu's items says so. A CI is shown as its
  estimate followed by its bounds in brackets, each a percentage change shown as
  Delta % is, as in `+58.12% [-16.03%, +197.40%]`. A bound too large to be
  represented is shown as `+∞%`. A CI sorts by its estimate. A p-value is shown
  as AR6 shows a measured `real` value, so a tiny one in exponent notation
  (`2.012e-29`).

  A per-side statistic adds an A and a B column. Optional columns sit between
  Ratio and Status, in the order above, A before B. They are empty on the
  geomean summary row. They are sortable. If the column the table is sorted by
  is removed, the table goes back to its default sort.
- **Profile column**: when both sides have a profile of a test in their
  selected runs, a "Profile" link leads to the Profiles page, comparing the two
  as PF1 describes. The column comes last, and cannot be sorted by. It is shown
  while any test of the comparison has a link, whatever the test filter, the
  filters, "Hide unchanged", "Hide inconclusive" and the hidden tests.
- **Width**: when the columns don't fit in the page's width, the table scrolls
  horizontally in a box of its own rather than squeezing the Test column. The
  rest of the page, the summary message row included, stays in place. The
  checkboxes and the Test column stay in view while the other columns scroll.


#### Computation Reference

**A side's samples for a test** are all the samples of that test, across the
side's selected runs, that have a value for the selected metric. A run with N
such samples contributes N values. The optional statistics columns from Samples
to CV %, and the sample count tooltips, use these samples, before any
aggregation.

**Aggregation pipeline.** The values `vA` and `vB` shown in the table are
produced by a two-stage aggregation pipeline:
1. **Sample aggregation** (within each run): when a test appears multiple times
   in a run's samples, the sample aggregation function (median/mean/min/max)
   reduces them to one value per test per run: the run's value of the test.
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
and Status are N/A.

**Confidence interval of the change.** The run is the independent unit: each
side contributes its runs' values of the test (see "Aggregation pipeline"),
`a_1..a_n` and `b_1..b_m`, rather than its samples. When `n >= 2`, `m >= 2` and
every one of these values is positive, the change has a confidence interval,
computed in log space with Welch's method:

| Quantity | Formula |
|----------|---------|
| `d`      | `mean(ln b_j) - mean(ln a_i)` |
| `s_A²`, `s_B²` | The sample variances (`n - 1`) of the `ln a_i` and of the `ln b_j` |
| `se`     | `sqrt(s_A² / n + s_B² / m)` |
| `df`     | `se⁴ / ((s_A² / n)² / (n - 1) + (s_B² / m)² / (m - 1))` (Welch-Satterthwaite) |
| `t`      | The two-sided critical value of Student's t-distribution with `df` degrees of freedom at the confidence level `c`: the `t` for which `P(\|T\| > t) = 1 - c` |
| Interval | `[exp(d - t * se), exp(d + t * se)]`, an interval of the ratio B / A |
| Estimate | `exp(d)`, the ratio of the geometric means of the runs' values, which may differ from Ratio |
| P-value  | The two-tailed p-value of `d / se` in Student's t-distribution with `df` degrees of freedom |

When `se = 0`, neither side varies: the interval is the estimate alone, and the
p-value is 0 when `d` is not 0, and 1 when it is. A p-value below `1 - c`
means that the interval at `c` does not hold 1.

**Status classification** (for tests whose status is not N/A). The margin `m`,
as a fraction, gives the band `[1 / (1 + m), 1 + m]` of ratios, symmetric in
log space, edges included:

| Status       | Rule |
|--------------|------|
| `improved`   | The interval lies entirely beyond an edge of the band, without touching it, on the side that is better given `bigger_is_better`: above `1 + m` if bigger is better, below `1 / (1 + m)` otherwise |
| `regressed`  | Likewise, on the other side |
| `unchanged`  | The interval lies entirely within the band |
| `inconclusive` | The interval holds an edge of the band and reaches beyond it, or the change has no interval: a side has fewer than 2 runs with a value, or a run's value is 0 or negative |

A margin of 0 makes this a plain significance test: a test is improved or
regressed when its interval does not hold 1, and unchanged only when neither
side varies and the two are equal.

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

The row has no interval: its Status classifies its Ratio as an interval of a
single point would be, so that it is never `inconclusive`. When N is 0, the row
shows N/A throughout.

**Chart Y-axis.** The chart plots `log2(Ratio)` = `log2(vB / vA)`. The log2
scale makes equal multiplicative changes symmetric: a 2x speedup (ratio = 0.5)
and a 2x slowdown (ratio = 2.0) appear at -1 and +1 respectively, equidistant
from zero.

A compared row is left off the chart when any of these conditions hold:
- Only one side has a value
- `vA = 0` (ratio undefined)
- Ratio <= 0 (log2 undefined -- occurs when `vA` and `vB` have opposite signs,
  or when `vB = 0`)


### CP3: Chart

A bar chart of the compared rows (see CP2), sorted by ratio. Rows that cannot be
plotted are left out (see Computation Reference).
- **X-axis**: tests, sorted by ratio, ascending
- **Y-axis**: `log2(Ratio)` -- see Computation Reference. Tick labels show the
  equivalent percentage change at "nice" values (+/-1%, +/-5%, +/-10%,
  +/-50%, +/-100%, etc.), adapted to the range shown, so that zooming into a
  narrow range shows finer ticks
- Rendered as bars, one per test, colored by status (see CP2). The chart draws
  no band for the margin: a bar is the change's Ratio, not its interval, and
  may exceed the margin while its test is inconclusive.

Interactivity:
- **Hover**: tooltip showing test name, exact ratio, the values of both sides,
  Delta %, the status with its confidence interval or why it has none, and a
  last line saying that clicking the bar shows its details. It also highlights
  the bar's table row (see CP5).
- **Details**: clicking a bar opens a popover beside it, which behaves as a
  Graph point's does (GR11), and whose accessible name is the test name. Where
  the bar is too wide to leave room beside it, as when it is the only one, the
  popover may cover part of it. It shows:
  - the test name;
  - Value A, Value B, Delta, Delta %, Ratio and Status, as the table's row
    shows them (CP2), with their tooltips;
  - for each side, the runs its samples for the test (see CP2 "Computation
    Reference") come from, as GR11 lists a point's runs, in a list of their own
    whose accessible name says the side;
  - "View on graph": a link to the Graph page in side B's context: side B's
    suite and machine, the branch of side B's commit, the selected metric, this
    test selected, and Compare's run and sample aggregations. When side B
    selects all its runs, the Graph's point at side B's commit is therefore
    Value B. The link also highlights commits (GR16): side B's commit, and side
    A's commit if side A has the same suite and machine, and its commit is on
    the same branch. A commit is highlighted only once it is known to have an
    ordinal: without one, it is not on the Graph's x-axis (GR3). The link is
    disabled (see AR8) while side B's commit is being looked up (CP6), and when
    that commit has no ordinal. If a lookup fails, that commit is not
    highlighted, but the link stays enabled. If side B's fails, the link has no
    branch, and side A's commit is not highlighted either, since its branch
    cannot be compared with side B's;
  - the test's Profile link, when its row has one (CP2).

  It closes on Escape, on its close button, on a click anywhere but on it, on
  a zoom or pan, and on any change to the compared rows, such as another
  comparison, metric or aggregation, margin or confidence, the test filter, a
  filter, "Hide unchanged", "Hide inconclusive" or a hidden test. Changes to
  the shadows do not close it. A click on another bar opens that bar's popover
  instead. A shadow's point (CP8) has no details: clicking it opens nothing.
- **Zoom**: dragging zooms into part of the chart, and double-clicking resets
  the zoom. The user's zoom is kept when settings change, but is reset when the
  comparison is replaced: a different suite, machine, commit or runs on either
  side, swapping the sides, or a different metric. When the user hasn't
  zoomed, both axes fit everything plotted: the bars and the shadows' lines.
  Zooming does not filter the table.
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
| Unchanged     | have Status Unchanged                            |
| Inconclusive  | have Status Inconclusive                         |
| Only in A     | have a value on side A only                      |
| Only in B     | have a value on side B only                      |
| Zero baseline | have a value on both sides, with a zero baseline |

Each category shows a colored dot, its label and its count. The dot is green
for Improved, red for Regressed and amber for Inconclusive (the status colors
of CP2), and grey for the others.

**Comparable categories** (Improved, Regressed, Unchanged, Inconclusive) also
show a percentage, whose denominator is the sum of comparable categories only.
Percentages use one decimal place, except whole numbers drop the trailing `.0`
(e.g. `25%` not `25.0%`). When there are no comparable tests, they show just
the count. A tooltip on each percentage explains its denominator.

**What is counted**: every test in the comparison that matches the test
filter and passes the filters (see CP1), including hidden tests, and the tests
"Hide unchanged" and "Hide inconclusive" remove from the table.

Categories with a count of zero are shown muted rather than hidden, so that the
bar's layout stays stable. When there is no comparison, the bar renders nothing.


### CP5: Chart-Table Sync

The chart shows the compared rows (see CP2), so the test filter, the filters,
"Hide unchanged", "Hide inconclusive" and the hidden tests affect the chart and
the table in the same way. Hovering a chart bar highlights its table
row, and hovering a table row highlights its chart bar. Neither scrolls the
page or the table.


### CP6: Data Flow

- Each side's metrics come from its suite's schema, as listed by
  `GET /api/projects`.
- A suite's machines come from `GET machines`. They are fetched once per suite,
  and shared by both sides and the shadows. A side's commit picker
  searches `GET commits?machine={name}&sort=-ordinal` (see AR15).
- A side's runs come from `GET runs?machine={name}&commit={value}`, every page
  of it. The side has no runs to compare until the whole list has loaded.
- The samples of each selected run come from `GET runs/{uuid}/samples`, every
  page of it, in as few requests as the API allows. Once fetched, a run's
  samples are kept for as long as the run belongs to one of the sides' or the
  shadows' commits. This way, changing the metric, an aggregation, the margin,
  the confidence, the filters, the run selection or the hidden tests, swapping
  the sides, pinning a shadow, or opening a bar's details (CP3) never fetches
  them again.
  If a run stops belonging to any of those commits while its samples are
  loading, its loading stops, without affecting the other runs.
- The Profile column needs to know which tests of each side have a profile. For
  each side, `GET runs?machine={name}&commit={value}&has_profiles=true` lists
  the runs that have profiles, and `GET runs/{uuid}/profiles` lists the
  profiles of each of them that is selected. This never delays the
  comparison.
- A bar's details look up the ordinal and the branch of side B's commit, and of
  side A's when side A has the same suite and machine, through
  `POST commits/resolve` (see CP3). The details don't wait for these lookups;
  only their link to the Graph does.
- A side's commit card (AR21), and the field values "Diff on" needs (CP1), are
  those of the commit as its picker looked it up or listed it when it was
  picked. Only while the picker has it neither way, such as while its lookup is
  pending or after it failed, does the card fetch it, through
  `POST commits/resolve`, once first shown; "Diff on" goes without.
- When the page is loaded from a URL, it sends all the requests that the URL's
  values call for at once, without first checking that the values are usable.
  There are exceptions: the page waits for the list of suites before it
  fetches the suite's machines or looks up the commit (see AR15), because both
  need the suite's schema. The commit's display value, for example, comes from
  the schema. A shadow's commit is looked up only once its suite's machines are
  listed and hold its machine (see CP8). A side whose URL names no runs can only
  ask for samples once its runs are listed, and a shadow only asks for its runs'
  samples once they are listed. If a value turns out to be unusable, the page
  discards what it fetched for that value and does not report its failures (see
  AR2 "State").

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
side, or the metric. Once there is a comparison, a table without rows says
why, checking in this order:
- `No test has a value for this metric.` when the comparison has no row;
- `No tests match the filter.` when the test filter keeps none;
- `No test passes the filters.`, or `No matching test passes the filters.`
  while the test filter is set, when the filters keep none of those;
- `Every matching test is unchanged.`, `Every matching test is inconclusive.`
  or `Every matching test is unchanged or inconclusive.` when "Hide unchanged",
  "Hide inconclusive" or both remove every row left.


### CP7: URL State

All selection state is encoded as query parameters for shareability:
- `project_a`, `suite_a`, `machine_a`, `commit_a`, `runs_a`
- `project_b`, `suite_b`, `machine_b`, `commit_b`, `runs_b`
- `metric`, `run_agg`, `sample_agg`
- `margin`, and `confidence` (`80`, `90`, `95` or `99`)
- `min_delta_pct`, `max_pvalue`, `min_abs`: the filters (see CP1), each present
  only while the filter is enabled, holding the value it uses. A disabled
  filter's value is not saved in the URL.
- `hide_unchanged=true`, `hide_inconclusive=true`
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
parameter once per value (see AR2 "State"). `runs_a` and `runs_b` are left out
when all of the side's runs are selected, which is the default. They are left
out too when none is, since the URL cannot say so: loading such a URL selects
every run.

A value the page cannot use is dropped (see AR2 "State"):
- a suite or machine that does not exist, a commit the side's commit picker
  would not offer (see AR15), or a machine named without a suite or a commit
  without a machine, along with whatever CP1 clears when that control is
  cleared;
- a run that is not in the side's run list; if this leaves no run, all of the
  side's runs are selected;
- a metric the page does not offer;
- a margin or a filter's value that is not a number or is out of range, and a
  confidence that is not offered; the default is then used, and the filter is
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
pinned. It names the shadow as "Shadow: {suite} › {machine} › {commit}", where
`{suite}` is the suite's full label (see AR22) and `{commit}` the commit's
display value (see AR6), or the commit string until it is known, followed by " ·
{k} of {n} runs" when the shadow selects only some of its commit's runs, once
they are listed. While there is a comparison and all the shadow's samples have
loaded, the name is followed by " · {N} tests" in muted text, where N is the
number of tests its line plots (see "Rendering"), even 0. The tests of a line
may differ from the bars' (see "Rendering"), and the count lets the user notice.
The chip shows the shadow's color, marker and dash pattern (see "Rendering"), as
a stroke of its line with its marker on it, and has a dismiss (×) button.
Dismissing a shadow gives the focus to the dismiss button of the chip after it,
or else before it, or to the pin button once none is left; while there is no
comparison, and so no pin button, it goes back to the page.
Chips are shown whether or not there is a comparison, so that shadows can always
be dismissed.

**Rendering:**
- Each shadow's comparison is computed the same way as the main one, between
  side A and the shadow's runs. Its line plots the compared rows (see CP2) that
  can be plotted in the shadow's comparison, each at its ratio there. A test can
  have a point without a bar, or a bar without a point.
- Each line is sorted by its own ratios, so a test's point on a line is not
  necessarily above its bar. The X-axis is wide enough for whichever of the
  bars and the lines has the most tests. The lines are drawn over the bars, in
  the order the shadows were pinned.
- Each shadow has a color, a marker and a dash pattern of its own, given by its
  position among the shadows, so that dismissing a shadow changes those of the
  shadows after it. The colors differ from each other, from the status colors
  of the bars and from the outline of a bar whose row is hovered (see CP5), and
  have a contrast of at least 3:1 against the page's background. Colors alone
  cannot keep five lines apart for every reader; their dash patterns do, as do
  their markers while drawn. The chart has no legend: the chips serve as one.
- Each point of a line has a marker, as long as at most 200 tests of the x-axis
  are in view, as on the Graph (see GR1): beyond, the markers merge into a
  thick band, and the lines are drawn alone while more than 200 are in view, as
  when zoomed out. A line with a single point keeps its marker. A point without
  a marker can still be hovered.
- Hovering a point of a line shows the test name, a line naming its shadow as
  its chip does, without its test count, and the exact ratio, the values of
  both sides and Delta %, as a main bar does (see CP3). A shadow has no status,
  and a point of a line has no details, so neither the status nor the line
  about clicking is shown.
  Table-to-chart hover highlighting targets the main bars only, and hovering a
  point of a line highlights no row.
- If side A's suite and a shadow's suite don't both offer the selected metric,
  under CP1's rule for comparing a metric across suites, that shadow plots no
  test, and draws nothing.

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
drawn only once all its samples have loaded: if its runs or samples cannot be
fetched, its line is not drawn. Whatever a shadow cannot fetch, the page says
that a shadow could not be loaded, offering to try again everything that failed
(see AR7). A failure of a runs list or a run that a side has too is reported as
the side's.

**URL encoding:** the URL holds each shadow as a `shadow` parameter (see CP7),
in the order they were pinned: `{project}/{suite}/{machine}/{commit}`, by name,
followed by `/{run},{run}...` when it selects only some of its commit's runs,
named by their UUIDs, each once, in ascending order. None of the names can
contain a `/` (see D4, D7 and I1), and only the runs are told apart by commas,
which a machine or a commit may contain. A value with fewer than four parts or
more than five, or
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

The header requires `triage` scope in side B's suite (see AR17). While the box
is collapsed, the header is disabled, with an explanation, when there would be
no indicators, or more than one request can carry (I2's maximum page size; see
E8). While it is expanded, the header collapses it, except while a request is
under way.

When expanded, the box first lists what the indicators are, a line each: how
many tests compared they cover (Covers), side B's suite by its full label (Test
Suite, see AR22), the
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
