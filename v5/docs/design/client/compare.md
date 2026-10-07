# v5 Web UI: Compare Page

Page specification for the Compare page at `/compare`.


## Compare -- `/compare?suite_a={ts}&...`

Side-by-side comparison of two commits (or runs). This page is suite-agnostic -- each
side can independently select its suite.


### CP1: Selection Panel

Each side (A and B) has independent controls:
- **Suite**: dropdown selector populated from the existing test suites. Changing the
  suite clears the machine, commit, and runs for that side and re-populates the
  machine combobox from the new suite's machines endpoint. Clearing the suite
  also clears cached fields and commits for that side so stale metrics don't
  linger.
- **Machine**: combobox over machine names. The full machine list for the
  selected suite is fetched once and filtered locally by case-insensitive
  substring as the user types (instant, no per-keystroke API calls). **Disabled
  until a suite is selected** -- shows "Select a suite first" placeholder.
  Clearing the machine text and blurring resets downstream state (commit, runs)
  and disables the commit input.
- **Commit**: a commit picker (see AR2) over the commits where the selected
  machine has runs. When a machine is pre-selected from URL state, its commits
  are fetched on creation so the dropdown is correctly filtered from the start.
  **Disabled until a machine is selected** -- shows "Select a machine first"
  placeholder. Re-disabled if the machine is cleared. Clearing the commit also
  clears the runs for that side.
- **Runs**: checkbox list of runs for the selected commit+machine, populated by
  `GET /api/suites/{ts}/runs?machine=M&commit=C`. Empty list shown when no runs exist.
  All runs are selected by default. The only exception is URL state restoration:
  if the shared URL specifies a subset of runs, that selection is restored. Each
  run shows its timestamp and its shortened UUID, linking to the Run Detail page.
  Before a commit is selected, a hint message ("Select a commit first") is shown
  instead.
- **Run aggregation**: strategy for aggregating across selected runs
  (median/mean/min/max, default: median); grayed out when only one run selected

A **Swap sides** button (circular, showing arrows) sits between the two sides.
Clicking it exchanges all of side A's state (commit, machine, runs, run
aggregation) with side B's, updates the URL, re-renders the selection panel, and
triggers auto-compare. This is useful for quickly reversing the baseline/new
direction.

Global controls (shared across both sides):
- **Metric**: single-select dropdown; one metric at a time, applies to both
  table and chart. Only numeric metrics (see D3) are offered; the delta, ratio,
  and geomean columns are undefined for `text` and `datetime`. When the two
  sides select different suites, a metric is offered only if both suites
  declare it, with the same `bigger_is_better` and the same `unit` (an unset
  unit matching only an unset one). While only one side has a suite, that
  suite's metrics are offered. The dropdown shows "-- Select metric --" until
  a metric is selected, and again if a side's suite changes so that the
  selected metric is no longer offered. Before any suite is selected, the
  metric area shows a "Select a suite to load metrics..." hint instead of an
  empty dropdown.
- **Sample aggregation**: strategy for aggregating multiple samples within a
  single run (default: median). When a test appears multiple times in a run's
  samples, this strategy produces a single value per test per run.
- **Hide noise**: checkbox (always visible, outside the collapsible section)
  that hides noise-classified rows from the table and chart entirely.
- **Noise filtering** (collapsible disclosure, collapsed by default): expands
  downward as a floating overlay so the other controls (Metric, Sample
  aggregation, etc.) remain vertically aligned with the summary label. Contains
  three independent knobs. A test is classified as **noise** if it fails ANY
  enabled knob (equivalently, a test is "signal" only if it passes ALL enabled
  knobs). When all knobs are disabled, no test is classified as noise. Each knob
  has an enable checkbox and a value input:
  - **Delta % below** (disabled by default, value: 1%): tests where
    |Delta %| < threshold are noise. Skipped when Delta % is unavailable (see
    "Zero baseline" bullet in the table section). Input must be >= 0. Hovering
    on the label shows a help tooltip: "Tests where the absolute percentage
    change is below this threshold are considered noise."
  - **P-value above** (disabled by default, value: 0.05): tests where the
    Welch's t-test p-value exceeds alpha are noise (the difference is not
    statistically significant). Uses all raw per-sample values from each side,
    pooled across selected runs, before any aggregation. Skipped when either
    side has fewer than 2 samples. Input must be in [0, 1]. Hovering on the
    label shows a help tooltip: "Welch's t-test on raw samples from both sides.
    Tests with p-value above the threshold are considered noise (the difference
    is not statistically significant). Requires at least 2 samples per side."
  - **Absolute below** (disabled by default, value: 0): tests where max(|Value
    A|, |Value B|) < floor are noise, where Value A and Value B are the final
    aggregated values displayed in the table. The value is in the metric's raw
    unit (the user sets it accordingly). Input must be >= 0. Hovering on the
    label shows a help tooltip: "Tests where both sides' aggregated values are
    below this floor are considered noise. Useful for filtering out measurements
    too small to be meaningful."

  Edge-case behavior for noise classification:
  - **Identical values**: when delta is exactly zero and a noise knob catches it
    (e.g., the Delta % knob with any threshold > 0%), the test is classified as
    noise with a noise reason. When no noise knob fires (all knobs disabled, or
    all thresholds are 0), the test is classified as `unchanged`.
  - **Zero variance (p-value knob)**: when both sides have zero variance and
    equal means, the p-value cannot be computed and the knob is skipped. When
    both sides have zero variance but different means, the change is
    deterministic and the knob passes (effectively p-value = 0). When only one
    side has zero variance, the test proceeds normally.
  - **Raw sample pooling**: a single run with N samples contributes n=N to the
    pooled sample set for the p-value calculation. Samples are pooled across all
    selected runs per side, before any aggregation.

- **Test filter**: text input for substring matching on test names, applied to
  both table and chart

There is no Compare button. The comparison triggers automatically whenever the
state becomes valid (both sides have runs and a metric is selected). Changing
the machine, commit, metric, or aggregation settings re-triggers the
comparison. Previous in-flight fetches are aborted.


### CP2: Comparison Table

| Column   | Description                                              |
|----------|----------------------------------------------------------|
| Test     | Test name                                                |
| Value A  | Aggregated metric value from side A                      |
| Value B  | Aggregated metric value from side B                      |
| Delta    | `vB - vA`                                                |
| Delta %  | `(vB - vA) / \|vA\| * 100`; see Computation Reference for sign convention and edge cases |
| Ratio    | `vB / vA`; same quantity plotted on the chart as `log2(Ratio)` |
| Status   | Improved / Regressed / Unchanged / Noise / N/A; see Computation Reference for classification rules |

The table can also show optional statistics columns (see "Optional columns" below).

- **Visible rows**: the rows the text filter, the chart zoom and "Hide noise"
  keep, minus those toggled off by a click (see "Interactive rows" below). Rows
  of the "Missing tests" section are not visible rows. The geomean summary row,
  the CSV export and Add to Regression (CP9) all operate on them.
- **Geomean summary row**: computed over the visible rows; see Computation
  Reference for precise formulas. It carries a status like any row, but is
  never classified as noise.
- Sortable by any column (click header)
- Color-coded status: green = improved, red = regressed (direction respects the
  metric's `bigger_is_better` flag)
- **Noise handling**: rows classified as noise by any enabled noise filtering
  knob are visually distinguished by the grey "noise" label in the Status
  column. The "Hide noise" checkbox removes them from the table and chart
  entirely (not rendered in the DOM).
- **Noise tooltip**: hovering over the Status cell of a noise-classified row
  shows a tooltip listing all knobs that triggered, e.g. "Delta 0.3% below 1%
  threshold", "p-value 0.12 above 0.05", "max(|A|, |B|) = 0.4 below floor of 1".
  All triggered knobs are shown, not just the first.
- **Sample count tooltips**: Value A and Value B cells show a tooltip
  indicating how many raw samples and contributing runs produced the aggregated
  value, e.g. "6 samples across 2 runs". Delta, Delta %, and Ratio cells show
  both sides: "A: 6 samples across 2 runs, B: 4 samples across 1 run". Sample
  count is the total number of raw sample values pooled across contributing
  runs (before any aggregation). Run count is the number of selected runs that
  have data for that specific test (not all selected runs). The geomean summary
  row and missing-test rows have no sample count tooltips. Singular/plural is
  applied ("1 sample across 1 run" vs "6 samples across 2 runs").
- **Missing tests**: tests present in only one side show "—" for the
  missing side's values. These are grayed out in a separate section at the
  bottom, excluded from the chart. This includes tests absent due to cross-suite
  comparison (different suites may have different test sets). The section header
  shows "Missing tests (N)" with the total count. When a text filter or chart
  zoom is active, the header updates to "Missing tests (M of N matching)" where
  M is the number of missing tests matching the filter and N is the total. Since
  missing tests are excluded from the chart, chart zoom always hides all missing
  rows (none can be in the zoomed range).
- **Null metrics**: when a test has samples on a side but no value for the
  selected metric there, that side's value shows "N/A", the test's Status is
  `N/A`, and it is excluded from the chart
- **Zero baseline**: when Value A is 0, display "N/A" for Delta %, Ratio, and
  Status (raw values are still shown)
- **Interactive rows**: Clicking a row toggles its visibility on the chart.
  Double-clicking a row isolates it (hides all others), like the Graph page's
  legend table. Manually-hidden rows (toggled by clicking) are shown grayed out
  in the table (not removed from the DOM). The "Hide noise" checkbox is a
  separate filter that removes noise rows from the DOM entirely. The two filters
  are independent: manual toggles persist across hideNoise changes, and changing
  noise filtering knobs correctly hides/unhides tests as their status changes.
- **Summary message**: A message above the table rows shows a count, consistent
  with the Graph page's legend message: "150 tests" when all are shown, "120 of
  150 tests shown" when some are toggled off, or "42 of 150 tests matching" when a
  text filter or chart zoom is active. Counts reflect only tests present in the
  table — noise-hidden tests (removed by "Hide noise") are excluded from both
  the numerator and denominator.
- **Copy as CSV**: A small clipboard icon button (right-justified on the summary
  message row) copies the visible comparison table as CSV to the clipboard. The
  exported CSV contains exactly the visible rows, in the current sort order,
  with the geomean summary as the first data row. Columns match the table's:
  Test, Value A, Value B, Delta, Delta %, Ratio, the optional columns shown,
  and Status. The button provides brief visual feedback indicating success or
  failure. Hidden when no rows are visible.
- **Optional columns**: A "Columns" button on the summary message row opens a
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

  Statistics are computed over all the samples of a side's selected runs taken
  together, ignoring the sample and run aggregation settings, as the P-value
  knob does. Only samples with a value for the metric count. Hovering a
  column's header says so.

  A per-side statistic adds an A and a B column. Optional columns sit between
  Ratio and Status, in the order above, A before B. They are empty on the
  geomean summary row, and a missing-test row shows the per-side ones for the
  side it has. They are sortable, and hiding the column the table is sorted by
  returns the table to its default sort.
- **Profile column**: When either side has profile data for a test, a "Profile"
  link appears, leading to the Profiles page pre-populated as PF1 describes.
  With a profile on both sides, it is
  `/profiles?suite_a={ts_a}&run_a={uuid_a}&test_a={test}&suite_b={ts_b}&run_b={uuid_b}&test_b={test}`.
  The link is omitted when neither side has a profile for that test.


#### Computation Reference

**Aggregation pipeline.** The values `vA` and `vB` shown in the table are
produced by a two-stage aggregation pipeline:
1. **Sample aggregation** (within each run): when a test appears multiple times
   in a run's samples, the sample aggregation function (median/mean/min/max)
   reduces them to one value per test per run.
2. **Run aggregation** (across selected runs): per-run values are reduced by the
   run aggregation function (median/mean/min/max, independently selectable per
   side) to produce the final `vA` and `vB`.

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

**Zero baseline.** When `vA = 0`, Delta is still computed, but Delta %, Ratio,
and Status are all `N/A`. This classification happens before noise
classification -- noise knobs are never evaluated for zero-baseline tests.

**Missing value.** When a test has samples on both sides but no value for the
metric on one side or both, its Status is `N/A`, and so is every derived column.
Like a zero baseline, this is decided before noise classification.

**Status classification** (checked in this order, after zero-baseline tests and
tests missing a value have already been classified as `N/A`):
1. If any enabled noise knob triggers -> `noise`
2. If `Delta = 0` -> `unchanged`
3. If `bigger_is_better` and `Delta > 0` -> `improved`
4. If `bigger_is_better` and `Delta < 0` -> `regressed`
5. If not `bigger_is_better` and `Delta < 0` -> `improved`
6. If not `bigger_is_better` and `Delta > 0` -> `regressed`

Status uses the sign of Delta (not Ratio) combined with `bigger_is_better`.

**Geomean summary row.** Computed over the N visible rows where both sides are
present, both values are non-zero, and ratio is defined:

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
never `noise`.

**Chart Y-axis.** The chart plots `log2(Ratio)` = `log2(vB / vA)`. The log2
scale makes equal multiplicative changes symmetric: a 2x speedup (ratio = 0.5)
and a 2x slowdown (ratio = 2.0) appear at -1 and +1 respectively, equidistant
from zero. Tick labels show the equivalent percentage change at "nice" values
(+/-1%, +/-5%, +/-10%, etc.).

A test is excluded from the chart when any of these conditions hold:
- Only one side has the test (not present on both sides)
- Either side has no value for the metric
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

Sorted ratio chart (relative performance chart):
- **X-axis**: tests, sorted by B/A ratio
- **Y-axis**: `log2(Ratio)` -- see Computation Reference for definition,
  symmetry rationale, and chart exclusion criteria. Tick labels show percentage
  change at "nice" values (+/-1%, +/-5%, +/-10%, +/-50%, +/-100%, etc.),
  auto-adapting to the data range
- Rendered as bars, one per test, colored by status (see CP2)

Interactivity:
- **Hover**: tooltip showing test name, exact ratio, the values of both sides,
  and Delta %
- **Zoom / drag-select**: filters the comparison table to show only the tests in
  the visible range
- **Noise band**: see Computation Reference for how the Delta % threshold is
  converted to log2 space. The p-value and absolute floor knobs do not have
  chart-level visualization.
- **Text filter**: the chart applies the text filter from the selection panel;
  the text filter stacks with the chart zoom filter (intersection)
- **Zoom preservation**: changing noise filtering knobs, aggregation functions,
  text filter, or toggling row visibility preserves the current chart zoom. The
  user can double-click the chart to reset zoom.
- **Adaptive tick labels on zoom**: tick labels recompute dynamically when the
  user zooms -- zooming into a narrow range shows fine-grained percentage ticks
  (+/-1%, +/-2%), while the full view shows coarser ticks (+/-50%, +/-100%).
  Double-click reset restores ticks for the full data range.
- **Empty state**: when there is no data to chart (no comparison triggered yet,
  or no tests match), the chart area displays "No data to chart." -- consistent
  with the Graph page's empty-state pattern.


### CP4: Comparison Summary Bar

A horizontal summary bar between the chart and the comparison table shows the
count of tests in each status category, with percentages for comparable
categories:

| Category   | Counts tests that                          | Dot color |
|------------|--------------------------------------------|-----------|
| Improved   | have Status Improved (see CP2)             | `#2ca02c` |
| Regressed  | have Status Regressed                      | `#d62728` |
| Noise      | have Status Noise                          | `#999999` |
| Unchanged  | have Status Unchanged                      | `#999999` |
| Only in A  | are present on side A only                 | `#888888` |
| Only in B  | are present on side B only                 | `#888888` |
| N/A        | have Status N/A                            | `#888888` |

**Comparable categories** (Improved, Regressed, Noise, Unchanged) show a colored
dot, label, and "count (pct%)" where the denominator is the sum of comparable
categories only (within the filtered set). Percentages use one decimal place,
except whole numbers drop the trailing `.0` (e.g. `25%` not `25.0%`).
Percentages among comparable categories sum to ~100% (one-decimal rounding may
cause minor drift). When there are no comparable tests, comparable categories
show just the count with no percentage. A tooltip on each count explains the
denominator.

**Non-comparable categories** (Only in A, Only in B, N/A) show a colored dot,
label, and count only — no percentage.

**Filtering behavior**: the summary bar respects the text filter and chart zoom
(counts reflect only tests visible in those filters). The comparable-category
denominator is the comparable count within the filtered set. The bar does NOT
respect the "Hide noise" toggle -- noise and unchanged tests are always counted.
This ensures the user can see the full status breakdown even when noise rows are
hidden from the table and chart. The source of truth is the full comparison
result, filtered by text filter and chart zoom.

**Zero-count categories**: shown with reduced opacity (0.5) for visual muting
rather than hidden, providing layout stability.

**Empty state**: when no comparison data exists, the summary bar renders nothing.
When `total > 0` but all tests are non-comparable, all categories render with bare
counts and no percentages.


### CP5: Bidirectional Chart-Table Sync

The chart and table always represent the same dataset:
- **Chart -> Table**: zooming or drag-selecting on the chart filters the table
  to the matching tests
- **Table -> Chart**: the text filter and row toggles update the chart to show
  only visible, matching tests
- **Hover sync**: hovering on a chart bar highlights the table row (scrolls
  into view); hovering on a table row highlights the chart bar


### CP6: Data Flow

1. Page loads: fetch metric metadata via `GET suites/{ts}`. When a machine is
   selected, the first page of `GET commits?machine={name}&sort=-first_seen`
   populates the commit combobox with the commits relevant to that machine,
   most recently seen first; typing re-queries it with `search=` (see AR2).
2. User selects commit and machine on each side. On each change, fetch
   `GET runs?machine=M&commit=C` to populate the runs checkbox list. If no runs
   exist, show an empty list.
3. Once both sides have runs and a metric is selected, comparison triggers
   automatically. Fetch sample data for each selected run via
   `GET runs/{uuid}/samples` (cursor-paginated with `limit=10000`). Show a
   progress indicator during fetch.
4. Client-side: aggregate samples (within-run via sample aggregation), aggregate
   across runs (via run aggregation), join on test name, compute derived columns
   (delta, ratio, status, p-value when the knob is enabled).
5. Render table and chart.
6. Subsequent filter/sort/zoom operations are client-side (data already loaded).
7. If the user changes selections while data is loading, abort the in-flight
   requests before starting new ones.
8. For the Profile column, call `GET /runs/{uuid}/profiles` for each side's runs,
   asynchronously. Cache per run UUID alongside the sample cache. Match profiles
   to test names to determine which rows get a Profile link.

**Per-run sample caching**: Fetched samples are cached per run UUID. Changing
the metric, aggregation function, noise filtering settings, or run selection
re-aggregates and re-compares from cache without any API calls. Only selecting a
new commit or machine (which produces different run UUIDs) triggers new fetches,
and only for runs not already in the cache.


### CP7: URL State

All selection state is encoded as query parameters for shareability:
- `suite_a`, `commit_a`, `machine_a`, `runs_a` (comma-separated UUIDs),
  `run_agg_a`
- `suite_b`, `commit_b`, `machine_b`, `runs_b`, `run_agg_b`
- `metric`, `sample_agg`
- `noise_pct`, `noise_pval`, `noise_floor` (knob values; omitted when at
  defaults: 1, 0.05, 0 respectively), `noise_pct_on`, `noise_pval_on`,
  `noise_floor_on` (knob enabled state; all default to disabled, so `_on` params
  only appear as `1` when enabled), `hide_noise`
- `test_filter`
- `columns`: the keys of the optional columns shown (see CP2), comma-separated;
  omitted when none is shown
- `sort`: the comparison table's sort column (`test`, `value_a`, `value_b`,
  `delta`, `delta_pct`, `ratio` or `status`, or the key of an optional column
  shown, suffixed with `_a` or `_b` for a per-side one), prefixed with `-` for
  descending


### CP8: Shadow Trace (Comparison Overlay)

A shadow trace overlays a pinned comparison on the chart, allowing the user to
visually compare how a ratio profile changed between two versions of side B
against a shared baseline (side A). For example: pin GCC vs LLVM20, then change
side B to LLVM21 to see both comparisons overlaid.

**Workflow:**
1. User sets up a comparison and sees the chart.
2. Clicks "Pin as Shadow" (small button in the top-right of the Side B panel
   header). Current side B selection is captured as the shadow.
3. The pin button hides. A chip badge appears above the chart (outside the
   settings area): "Shadow: {commit} on {machine}" with a dismiss (×) button.
4. User changes side B. The chart now shows main comparison as bars and the
   shadow comparison as a thin line trace.
5. To remove the shadow, click × on the chip. To change it, dismiss then re-pin.

**Pin button placement:**
- Inside the Side B selection panel, top-right of the "Side B (New)" heading.
- Small button, visible only when a comparison is active and no shadow is
  currently pinned.

**Shadow chip placement:**
- In a toolbar row between the progress/error area and the chart, outside any
  settings panel. Chip with a dismiss (×) button.

**Shadow trace rendering:**
- Thin line trace, independently sorted by its own ratio ascending, producing a
  smooth curve. It does NOT share X positions with the main bars — each trace
  uses its own sequential X positions (0..N). The X-axis range accommodates
  whichever trace has more points.
- Muted blue color, distinct from the green/red/grey status-coded bars.
- No legend displayed. The shadow chip above the chart identifies the trace.
- Shadow Y values are included in the Y-axis range calculation for tick
  generation.
- Text filter, hide-noise, and manual row toggles apply to the shadow trace the
  same as the main.

**Hover:**
- Hovering a shadow point shows the same info as the main bars: test name,
  ratio, value A, value B, delta %, with a "(shadow)" label to distinguish.
- Table-to-chart hover sync targets the main trace only.

**Scope:**
- Chart-only: no table columns, no summary bar changes.
- "Add to Regression" panel operates on the main comparison only.

**Same side A enforced:**
- Any change to side A (including swapping sides) auto-unpins the shadow.

**Settings interactions:**

| Setting changed       | Shadow behavior                                  |
|-----------------------|--------------------------------------------------|
| Metric                | Full recompute (both main and shadow)            |
| Sample aggregation    | Full recompute (both main and shadow)            |
| Run aggregation (A)   | Full recompute (both main and shadow)            |
| Run aggregation (B)   | Recompute main only; shadow uses its pinned value|
| Noise config          | Reclassify both main and shadow                  |
| Hide noise            | Shadow visibility follows main (chart filter)    |
| Test filter           | Shadow visibility follows main (chart filter)    |
| Sort                  | No effect (chart always sorts by ratio)          |
| Side A change         | Auto-unpin shadow                                |
| Side B change         | Recompute main; shadow unchanged                 |
| Swap sides            | Auto-unpin shadow                                |

Sample aggregation is a global visualization preference — both main and shadow
respond to it equally. Run aggregation is per-side: the shadow's run aggregation
is frozen at pin time.

**Data flow:**
- On pin: a deep copy of the current side B selection is stored as the shadow.
  The shadow's side B samples are already in the sample cache.
- On recompute: the shadow reuses the main comparison's cached side A
  aggregation, then aggregates only the shadow's side B samples independently.
- On page load from a URL with shadow parameters, shadow samples are fetched in
  parallel with the main samples. Shadow fetch failures are tolerated — the main
  comparison still renders.

**URL encoding:**
- Shadow side B is encoded with the same scheme as side A and side B, using the
  suffix `shadow_b` (e.g., `suite_shadow_b`, `commit_shadow_b`, `runs_shadow_b`,
  `run_agg_shadow_b`).
- The shadow display label is not stored in the URL — it is derived from the
  shadow's commit and machine at render time.


### CP9: Add to Regression

A collapsible panel (button: "Add to regression" in the controls area),
requiring `triage` scope. It works on side B: its indicators name side B's
machine, the selected metric, and the test of each visible row (see CP2), and
the regression they go to belongs to side B's suite. It is disabled, with an
explanation, while there are more visible rows than one request can carry
indicators (I2's maximum page size; see E8). When expanded, it offers:
- "Create new regression" -- a title input and a button that creates a
  regression in side B's suite, attributed to side B's commit, with those
  indicators.
- "Add to existing" -- a regression picker over side B's suite; adds the
  indicators to the selected regression. A suite can hold more regressions than
  fit on a page, so the picker searches the server (see AR2): it opens on the
  first page of `GET regressions?sort=-created_at` and narrows it with
  `search=`, which matches the title. Each suggestion shows the regression's
  title, or `(untitled)` and its shortened UUID when it has none. On selection,
  the input shows the suggestion's label; editing the text afterwards clears
  the selection. Enter with no suggestion focused does nothing: the user must
  select from the list, since regressions are identified by UUID.

On successful creation, the feedback shows "Regression created: " followed by a
clickable link to the new regression's detail page. The link text is the
regression title if one was provided, otherwise its shortened UUID. Clicking
the link navigates to the regression detail page within the SPA. The title
input is cleared after successful creation.

On successful addition of indicators to an existing regression, the feedback
shows "Added N indicator(s) to " followed by a clickable link to the regression
detail page. The link text is the regression title if available, otherwise its
shortened UUID.

The panel collapses back to the button when done.
