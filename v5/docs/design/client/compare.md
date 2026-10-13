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
|                  [x] 2026-08-25 ... |       |                  [x] 2026-08-31, 3:03 PM ...  |
| Run aggregation  [median         v] |       | Run aggregation  [median                   v] |
+-------------------------------------+       +-----------------------------------------------+

Metric [Execution Time v]  Sample aggregation [median v]  [ ] Hide noise  > Noise filtering
[Filter tests...] [ ] Regex                                                [Add to regression]

<progress and errors>
[Shadow: 0f69d2804b9b on linux-x86_64  x]
<chart>

o Improved 120 (40%)  o Regressed 30 (10%)  o Noise 0 (0%)  o Unchanged 150 (50%)  o Only in A 2  o Only in B 0  o N/A 1

301 of 303 tests shown                                                [Columns] [Copy as CSV]
[-]  Test                 Value A    Value B    Delta     Delta %   Ratio     Status
     Geomean              ...
[x]  BM_find_if/1024      1.26432    1.31007    0.04575   +3.62%    1.0362    Regressed
[ ]  BM_sort/4096         ...
```


### CP1: Selection Panel

Each side has its own controls:

- **Suite**: a dropdown over the test suites defined on the instance. Changing
  the suite clears the side's machine, commit and runs.
- **Machine**: a combobox (see AR14) over the selected suite's machines. The
  suite's full machine list is fetched once and filtered locally (see AR9).
  Disabled until a suite is selected, showing "Select a suite first". Picking
  another machine keeps the side's commit if the new machine has runs at it,
  as the side's run list for that machine shows, and clears it otherwise.
  Clearing the machine clears the commit and the runs.
- **Commit**: a commit picker (see AR15) over the commits at which the selected
  machine has runs. Disabled until a machine is selected, showing "Select a
  machine first". Clearing the commit clears the runs.
- **Runs**: a checkbox list of the selected machine's runs at the selected
  commit, in the order they were submitted, each with its submission time and
  its shortened UUID linking to its Run Detail page. Every run is selected when
  a commit is picked, unless the URL names some of them (see CP7). Rows are
  selected one at a time, a range at a time with Shift, or all at once from the
  header (see AR10). Before a commit is selected, the list says "Select a
  commit first".
- **Run aggregation**: how the selected runs' values are combined (see CP2
  "Aggregation pipeline"): median, mean, min or max, median by default.
  Disabled while at most one run is selected.

A **Swap sides** button between the two sides exchanges everything each side
holds: its suite, machine, commit, runs and run aggregation, along with what
has been fetched or looked up for them.

Global controls, shared by both sides:

- **Metric**: a dropdown; one metric at a time, for both the table and the
  chart. Only numeric metrics (see D3) are offered, since Delta, Ratio and the
  geomean are undefined for `text` and `datetime`. When the two sides select
  different suites, a metric is offered only if both suites declare it, with
  the same `bigger_is_better` and the same `unit` (an unset unit matching only
  an unset one). While only one side has a suite, that suite's metrics are
  offered. The dropdown shows "-- Select metric --" until a metric is selected,
  and again if a side's suite changes so that the selected metric is no longer
  offered. Before any suite is selected, the metric area says "Select a suite
  to load metrics..." instead.
- **Sample aggregation**: how a test's samples within one run are combined (see
  CP2 "Aggregation pipeline"): median, mean, min or max, median by default.
- **Hide noise**: a checkbox that removes the rows classified as noise from the
  table and the chart.
- **Noise filtering**: a section, collapsed by default, holding three
  independent knobs. Each knob has a checkbox enabling it and a value. A test
  is classified as **noise** if any enabled knob triggers for it; with every
  knob disabled, no test is noise. Each knob's label has a help tooltip saying
  what the knob does.
  - **Delta % below** (1 by default, at least 0): triggers when |Delta %| is
    below the value.
  - **P-value above** (0.05 by default, between 0 and 1): triggers when the
    p-value of Welch's t-test between the two sides' samples for the test (see
    CP2 "Computation Reference") exceeds the value, i.e. the difference is not
    statistically significant. Skipped when either side has fewer than 2
    samples. When both sides have zero variance, the knob is skipped if their
    means are equal, and does not trigger otherwise, since the change is then
    deterministic (its p-value is taken as 0).
  - **Absolute below** (0 by default, at least 0): triggers when
    max(|Value A|, |Value B|) is below the value, which is in the metric's raw
    unit. For measurements too small to be meaningful.

  A value outside its knob's range, or that is not a number, shows the red halo
  (see AR11), and the knob keeps applying its last valid value.
- **Test filter**: a text filter on test names, with regex mode (see AR9).

There is no Compare button. There is a comparison once both sides have at least
one run selected and a metric is selected, and it always reflects the current
controls (see CP6).


### CP2: Comparison Table

**Rows.** The comparison holds one row per test that has a value for the metric
on at least one side, i.e. among that side's samples for the test (see
Computation Reference). Tests are matched by name, including across suites. The
table shows the rows the test filter keeps, minus those classified as noise
while "Hide noise" is checked, with the geomean summary row first whatever the
sort.

| Column   | Description                                              |
|----------|----------------------------------------------------------|
| Test     | Test name, after the row's checkbox                      |
| Value A  | Aggregated metric value from side A, or N/A when it has none |
| Value B  | Aggregated metric value from side B, or N/A when it has none |
| Delta    | `vB - vA`                                                |
| Delta %  | `(vB - vA) / \|vA\| * 100`; see Computation Reference for sign convention and edge cases |
| Ratio    | `vB / vA`; same quantity plotted on the chart as `log2(Ratio)` |
| Status   | Improved / Regressed / Unchanged / Noise / N/A; see Computation Reference for classification rules |

**Hidden tests.** Each row has a checkbox, checked while the row is shown on the
chart. Unchecking it hides the test: its row stays in the table, greyed, in its
place in the sort order. Every test is shown by default. The controls are those
of the Graph's test table (see GR7), over the rows the table shows, with
"shown" in place of "selected" and no limit on how many.

The test filter and "Hide noise" never change which tests are hidden: clearing
the filter brings back the rows it hid, as they were. When the comparison
changes -- another commit, other runs, another metric -- the hidden tests it
still holds stay hidden, the tests it gains are shown, and the hidden tests it
no longer holds are forgotten, once the new comparison is complete (see AR2
"State").

**Compared rows** are the rows the table shows that are not hidden. The chart
(see CP3), the geomean summary row, Copy as CSV and Add to Regression (see CP9)
all operate on them.

- **Geomean summary row**: no checkbox; see Computation Reference.
- **Sorting**: by any column, by clicking its header. The default is Delta %
  descending. N/A sorts last in both directions. Status sorts improved,
  regressed, noise, unchanged, then N/A. Ties are broken by test name,
  ascending.
- **Status colors**: green for improved, red for regressed. Noise rows show a
  grey "noise" label, whose tooltip lists each knob that triggered, with the
  test's value and the knob's threshold.
- **Sample count tooltips**: Value A and Value B show how many of the side's
  samples for the test, and how many of its selected runs, produced the value,
  e.g. "6 samples across 2 runs". Delta, Delta % and Ratio show both sides: "A:
  6 samples across 2 runs, B: 4 samples across 1 run". A side with no value,
  and the geomean summary row, have no tooltip.
- **Summary message**: above the rows, a message says how many of the table's
  rows are shown, as the Graph's test table does (see GR6): "120 of 150 tests
  shown", or with the test filter set, "30 of 42 matching tests shown (150
  total)". Rows removed by "Hide noise" are counted in none of these. While the
  URL cannot hold the hidden tests (see CP7), the message says so.
- **Copy as CSV**: a clipboard button at the end of the summary message row
  copies the compared rows as CSV, in the current sort order, with the geomean
  summary row first. The columns are the table's: Test, Value A, Value B,
  Delta, Delta %, Ratio, the optional columns shown, and Status. Numbers are
  written at full precision, and an N/A cell is left empty. The button briefly
  shows whether the copy succeeded. It is hidden when there is no compared row.
- **Optional columns**: a "Columns" button on the summary message row opens a
  menu of checkboxes adding statistics columns to the table, all off by
  default:

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
  Computation Reference), ignoring the sample and run aggregation settings.
  Hovering a column's header says so.

  A per-side statistic adds an A and a B column. Optional columns sit between
  Ratio and Status, in the order above, A before B. They are empty on the
  geomean summary row. They are sortable, and hiding the column the table is
  sorted by returns the table to its default sort.
- **Profile column**: when either side has a profile for a test, a "Profile"
  link leads to the Profiles page, pre-populated as PF1 describes.


#### Computation Reference

**A side's samples for a test** are the samples of the test, in the side's
selected runs, that have a value for the metric. Pooled across those runs, a
run with N of them contributing N values, they are what the P-value knob, the
optional statistics columns and the sample count tooltips use.

**Aggregation pipeline.** The values `vA` and `vB` shown in the table are
produced by a two-stage aggregation pipeline:
1. **Sample aggregation** (within each run): when a test appears multiple times
   in a run's samples, the sample aggregation function (median/mean/min/max)
   reduces them to one value per test per run.
2. **Run aggregation** (across selected runs): per-run values are reduced by the
   run aggregation function (median/mean/min/max, independently selectable per
   side) to produce the final `vA` and `vB`.

Only the side's samples for the test take part, and a run with none of them
contributes no per-run value.

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

**Status classification** (checked in this order, for the other tests):
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

Sorted ratio chart (relative performance chart) of the compared rows (see CP2),
leaving off those that cannot be plotted (see Computation Reference):
- **X-axis**: tests, sorted by ratio
- **Y-axis**: `log2(Ratio)` -- see Computation Reference. Tick labels show the
  equivalent percentage change at "nice" values (+/-1%, +/-5%, +/-10%,
  +/-50%, +/-100%, etc.), adapted to the range shown, so that zooming into a
  narrow range shows finer ticks
- Rendered as bars, one per test, colored by status (see CP2)

Interactivity:
- **Hover**: tooltip showing test name, exact ratio, the values of both sides,
  and Delta %. It also highlights the bar's table row (see CP5).
- **Zoom**: as on the Graph page (see GR5), except that the zoom is reset when
  the comparison is replaced -- another suite, machine, commit or runs on
  either side, swapping the sides, or another metric -- and kept across every
  other change. Zooming does not change the table.
- **Noise band**: see Computation Reference for how the Delta % threshold is
  converted to log2 space. The p-value and absolute floor knobs do not have
  chart-level visualization.
- **Empty state**: when there is a comparison but none of its compared rows can
  be plotted, the chart area displays "No data to plot", as on the Graph page
  (see GR12). CP6 says what is shown while there is no comparison.


### CP4: Comparison Summary Bar

A horizontal summary bar between the chart and the comparison table counts the
tests in each category, with percentages for comparable categories. Every test
counts in exactly one category:

| Category   | Counts tests that                          |
|------------|--------------------------------------------|
| Improved   | have Status Improved (see CP2)             |
| Regressed  | have Status Regressed                      |
| Noise      | have Status Noise                          |
| Unchanged  | have Status Unchanged                      |
| Only in A  | have a value on side A only                |
| Only in B  | have a value on side B only                |
| N/A        | have a zero baseline                       |

Each category shows a dot of its color -- the status colors of CP2 for Improved
and Regressed, and grey for the others -- its label and its count.

**Comparable categories** (Improved, Regressed, Noise, Unchanged) also show a
percentage, whose denominator is the sum of comparable categories only.
Percentages use one decimal place, except whole numbers drop the trailing `.0`
(e.g. `25%` not `25.0%`). When there are no comparable tests, they show just
the count. A tooltip on each count explains the denominator.

**What is counted**: the tests of the comparison that the test filter keeps,
hidden or not, and noise or not, whatever "Hide noise" says.

Categories with a count of zero are shown muted rather than hidden, so that the
bar's layout stays stable. When there is no comparison, the bar renders nothing.


### CP5: Chart-Table Sync

The chart shows the compared rows (see CP2), so the table's filter, "Hide
noise" and hidden tests apply to both. Hovering a chart bar highlights its table
row, and hovering a table row highlights its chart bar. Neither scrolls the
page.


### CP6: Data Flow

- Each side's metrics come from its suite's schema, as listed by `GET suites`.
- A suite's machines come from `GET machines`, fetched once per suite while the
  page is open, whichever side or shadow needs them. A side's commit picker
  searches `GET commits?machine={name}&sort=-first_seen` (see AR15).
- A side's runs come from `GET runs?machine={name}&commit={value}`, every page
  of it. Until the list has loaded whole, the side has no runs to compare.
- The samples of each selected run come from `GET runs/{uuid}/samples`, every
  page of it, at the largest page size the API allows. The samples of every
  run of the sides' and the shadow's commits are kept once fetched, so that no
  other change to the controls -- the metric, an aggregation, the noise
  settings, the run selection, the hidden tests, swapping the sides, pinning a
  shadow -- fetches them again. A run's samples stop loading once it is no
  longer a run of either side's or the shadow's commit, without disturbing the
  others.
- The Profile column needs to know which tests of each side have a profile. A
  side's runs with profiles come from
  `GET runs?machine={name}&commit={value}&has_profiles=true`, and the profiles
  of each of them from `GET runs/{uuid}/profiles`. They never delay the
  comparison.
- On load, the requests the URL's values determine are sent at once, without
  waiting for those values to be checked. What is fetched for a value found
  unusable is discarded.

While the samples of a comparison are loading, a progress indicator says how
many of its runs have loaded, in place of the comparison: a comparison that
does not match the controls is never shown.

When something the page needs cannot be fetched -- the suites, a suite's
machines, a side's runs, a commit lookup, a selected run's samples or profiles,
the shadow's runs or samples -- the page says so (see AR7). If any selected
run's samples cannot all be fetched, there is no comparison, rather than one
silently based on fewer runs. A failure to fetch profiles only leaves out the
Profile links it would have given.

**Empty states.** Where the comparison would be, the page says what is missing
while there is none: a suite, a machine, a commit, a selected run on a side, or
the metric. Once there is a comparison, the table says
`No test has a value for this metric.` when it holds no row, and
`No tests match the filter.` when the filter keeps none.


### CP7: URL State

All selection state is encoded as query parameters for shareability:
- `suite_a`, `machine_a`, `commit_a`, `runs_a`, `run_agg_a`
- `suite_b`, `machine_b`, `commit_b`, `runs_b`, `run_agg_b`
- `metric`, `sample_agg`
- `noise_pct`, `noise_pval`, `noise_floor`: present exactly while their knob is
  enabled, holding its value. A disabled knob's value is not kept.
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
- The shadow trace's parameters (see CP8)

`runs_a`, `runs_b`, `hidden_test` and `columns` repeat their parameter once per
value (see AR2 "State"). `runs_a` and `runs_b` are left out while every run of
their side is selected, which is the default.

A value the page cannot use is dropped (see AR2 "State"):
- a suite, machine or commit the side cannot have (a commit as AR15 describes),
  along with what CP1 clears with it;
- a run its side's run list does not hold; if none of the side's runs is left,
  every run is selected;
- a metric the page does not offer;
- a noise value outside its knob's range, which leaves the knob disabled;
- a `sort` naming a column that is not shown, for the default sort;
- a hidden test the comparison does not hold.


### CP8: Shadow Trace (Comparison Overlay)

A shadow trace overlays a pinned comparison on the chart, allowing the user to
visually compare how a ratio profile changed between two versions of side B
against a shared baseline (side A). For example: pin GCC vs LLVM20, then change
side B to LLVM21 to see both comparisons overlaid.

**Workflow:**
1. User sets up a comparison and sees the chart.
2. Clicks "Pin as shadow", in the header of side B's panel. Side B's current
   selection is captured as the shadow.
3. A chip appears above the chart: "Shadow: {commit} on {machine}", where
   `{commit}` is the commit's display value (see AR6), or the commit string
   until it is known, with a dismiss (×) button.
4. User changes side B. The chart now shows the main comparison as bars and the
   shadow comparison as a thin line.
5. To remove the shadow, click × on the chip.

The pin button is shown only while there is a comparison and no shadow is
pinned.

**Rendering:**
- The shadow comparison is computed as the main one, between side A and the
  shadow's runs. The line plots the tests of the compared rows (see CP2) that
  can be plotted in the shadow comparison, each at its shadow ratio.
- The line is sorted by its own ratio and plotted at its own positions, not
  those of the main bars; the X-axis range fits whichever of the two has more
  tests. Its color is distinct from the status colors of the bars, and there is
  no legend: the chip identifies the trace.
- Hovering a shadow point shows the same information as a main bar, with a
  "(shadow)" label. Table-to-chart hover highlighting targets the main bars
  only.
- If the selected metric is not comparable between side A's suite and the
  shadow's, under CP1's rule for a metric compared across suites, the shadow
  draws nothing.

**Scope:** chart only -- no table columns, no summary bar counts. Add to
Regression (see CP9) operates on the main comparison only.

**What it follows.** The shadow follows the metric, the sample aggregation,
side A's run aggregation and the compared rows. It keeps side B's suite,
machine, commit, runs and run aggregation as they were when pinned, whatever
happens to side B afterwards. Changing side A's suite, machine, commit or runs,
or swapping the sides, dismisses the shadow.

**Data:** the shadow's samples are fetched like a side's (see CP6). A failure to
fetch them is reported, but does not prevent the main comparison.

**URL encoding:** the shadow is encoded like a side, with the suffix `shadow_b`:
`suite_shadow_b`, `machine_shadow_b`, `commit_shadow_b`, `runs_shadow_b` and
`run_agg_shadow_b`, following the same rules (see CP7). The shadow is dropped
when its suite, machine or commit is unusable, or when side A's is.


### CP9: Add to Regression

A collapsible panel (button: "Add to regression" in the controls area) creates
regression indicators from the comparison. It works on side B: its indicators
name side B's machine, the selected metric, and the test of each compared row
(see CP2) that has a value on side B -- a test without one was not measured
there, and side B's suite may not even have it. The regression they go to
belongs to side B's suite.

The button requires `triage` scope (see AR17). It is disabled, with an
explanation, while no row would give an indicator, and while more would than one
request can carry (I2's maximum page size; see E8). When expanded, the panel
offers:
- "Create new regression" -- a title input, which may be left empty, and a
  button that creates a regression in side B's suite, attributed to side B's
  commit, with those indicators.
- "Add to existing" -- a regression picker over side B's suite, which searches
  the server (see AR9) from the first page of `GET regressions?sort=-created_at`,
  matching the title or a prefix of the UUID; adds the indicators to the
  selected regression. Each suggestion shows the regression's title, or
  `(untitled)` and its shortened UUID when it has none.

The panel is a form (see AR2 "State").

Once the regression is created, or the indicators added, the panel collapses
back to its button, and a message beside the button says what was done, until
the panel is opened again:
- "Regression created: " followed by a link to the new regression's detail
  page;
- "Added N indicators to " followed by a link to the regression's detail page,
  where N counts only the indicators the request created, followed by how many
  already existed and were not added again, if any (as in DT4).

Each link's text is the regression's title, or its shortened UUID when it has
none.
