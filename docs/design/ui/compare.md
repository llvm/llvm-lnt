# v5 Web UI: Compare Page

Page specification for the Compare page at `/v5/compare`.

For the SPA architecture and routing, see [`architecture.md`](architecture.md).
Related pages: [Graph](graph.md), [Browsing Pages](browsing.md),
[Regressions](regressions.md).


## Compare -- `/v5/compare?suite_a={ts}&...`

Side-by-side comparison of two commits (or runs). The existing code in
`comparison.ts`, `selection.ts`, `table.ts`, `chart.ts` becomes a page module.
The SPA router delegates to it. This page is suite-agnostic -- each side can
independently select its suite.


### Selection Panel

Each side (A and B) has independent controls:
- **Suite**: dropdown selector populated from `data-testsuites`. Changing the suite clears the machine, commit, and runs for that side and re-populates the machine combobox from the new suite's machines endpoint. Clearing the suite also clears cached fields and commits for that side so stale metrics don't linger.
- **Commit**: combobox (searchable dropdown) over commit values. When the schema defines a commit_field with ``display: true``, the dropdown items show the display value (e.g. short SHA) while the internal selection uses the raw commit string; when no display field is defined or not populated, the raw commit string is shown. The text filter matches against both the raw commit string and the display value. Filters suggestions to only show commits where the selected machine has runs. When a machine is pre-selected from URL state, its commits are fetched on creation so the dropdown is correctly filtered from the start. **Disabled until a machine is selected** -- shows "Select a machine first" placeholder. Re-disabled if the machine is cleared. Clearing the commit also clears the runs for that side.
- **Machine**: combobox over machine names. The full machine list for the selected suite is fetched once and filtered locally by case-insensitive substring as the user types (instant, no per-keystroke API calls). **Disabled until a suite is selected** -- shows "Select a suite first" placeholder. Clearing the machine text and blurring resets downstream state (commit, runs) and disables the commit input.
- **Runs**: checkbox list of runs for the selected commit+machine, populated by `GET /api/v5/{ts}/runs?machine=M&commit=O`. Empty list shown when no runs exist. All runs are selected by default. The only exception is URL state restoration: if the shared URL specifies a subset of runs, that selection is restored. Each run shows its timestamp and a short UUID linking to the Run Detail page. Before a commit is selected, a hint message ("Select a commit first") is shown instead.
- **Run aggregation**: strategy for aggregating across selected runs (median/mean/min/max); grayed out when only one run selected

A **Swap sides** button (circular, showing arrows) sits between the two sides. Clicking it exchanges all of side A's state (commit, machine, runs, run aggregation) with side B's, updates the URL, re-renders the selection panel, and triggers auto-compare. This is useful for quickly reversing the baseline/new direction.

Global controls (shared across both sides):
- **Metric**: single-select dropdown; one metric at a time, applies to both table and chart. Shows the **union** of metrics from both sides' suites. Only metrics with `type === 'real'` are shown (filtered client-side). Before any suite is selected, the metric area shows a "Select a suite to load metrics..." hint instead of an empty dropdown.
- **Sample aggregation**: strategy for aggregating multiple samples within a single run (default: median). When a test appears multiple times in a run's samples, this strategy produces a single value per test per run.
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
    label shows a help tooltip: "Welch's t-test on raw samples from both
    sides. Tests with p-value above the threshold are considered noise (the
    difference is not statistically significant). Requires at least 2 samples
    per side."
  - **Absolute below** (disabled by default, value: 0): tests where
    max(|Value A|, |Value B|) < floor are noise, where Value A and Value B are
    the final aggregated values displayed in the table. The value is in the
    metric's raw unit (the user sets it accordingly). Input must be >= 0.
    Hovering on the label shows a help tooltip: "Tests where both sides'
    aggregated values are below this floor are considered noise. Useful for
    filtering out measurements too small to be meaningful."

  Edge-case behavior for noise classification:
  - **Identical values**: when delta is exactly zero and a noise knob catches
    it (e.g., the Delta % knob with any threshold > 0%), the test is classified
    as noise with a noise reason. When no noise knob fires (all knobs disabled,
    or all thresholds are 0), the test is classified as `unchanged`.
  - **Zero variance (p-value knob)**: when both sides have zero variance and
    equal means, the p-value cannot be computed and the knob is skipped. When
    both sides have zero variance but different means, the change is
    deterministic and the knob passes (effectively p-value = 0). When only one
    side has zero variance, the test proceeds normally.
  - **Raw sample pooling**: a single run with N samples contributes n=N to
    the pooled sample set for the p-value calculation. Samples are pooled
    across all selected runs per side, before any aggregation.

- **Test filter**: text input for substring matching on test names, applied to both table and chart

There is no Compare button. The comparison triggers automatically whenever the
state becomes valid (both sides have runs and a metric is selected), like the
Graph page's auto-plot. Changing the machine, commit, metric, or aggregation
settings re-triggers the comparison. Previous in-flight fetches are aborted.


### Comparison Table

| Column   | Description                                              |
|----------|----------------------------------------------------------|
| Test     | Test name                                                |
| Value A  | Aggregated metric value from side A                      |
| Value B  | Aggregated metric value from side B                      |
| Delta    | `vB - vA`                                                |
| Delta %  | `(vB - vA) / |vA| * 100`; see Computation Reference for sign convention and edge cases |
| Ratio    | `vB / vA`; same quantity plotted on the chart as `log2(Ratio)` |
| Status   | Improved / Regressed / Unchanged / Noise / N/A; see Computation Reference for classification rules |

- **Geomean summary row**: see Computation Reference for precise formulas. The geomean summary row is never classified as noise.


#### Computation Reference

**Aggregation pipeline.** The values `vA` and `vB` shown in the table are
produced by a two-stage aggregation pipeline:
1. **Sample aggregation** (within each run): when a test appears multiple
   times in a run's samples, the sample aggregation function
   (median/mean/min/max) reduces them to one value per test per run.
2. **Run aggregation** (across selected runs): per-run values are reduced
   by the run aggregation function (median/mean/min/max, independently
   selectable per side) to produce the final `vA` and `vB`.

**Per-test derived columns** (given `vA`, `vB` as defined above):

| Quantity   | Formula                  | Domain                           |
|------------|--------------------------|----------------------------------|
| Delta      | `vB - vA`                | always defined                   |
| Delta %    | `(vB - vA) / |vA| * 100` | undefined (N/A) when `vA = 0`    |
| Ratio      | `vB / vA`                | undefined (N/A) when `vA = 0`    |

Notes:
- Delta % uses `|vA|` (not `vA`) in the denominator so its sign always
  matches the sign of Delta, even when the baseline is negative. Without
  the absolute value, a negative baseline would flip the percentage sign.
- For positive baselines, `Delta % = (Ratio - 1) * 100`, so Delta % and
  Ratio carry the same information in different forms.

**Zero baseline.** When `vA = 0`, Delta is still computed, but Delta %,
Ratio, and Status are all `N/A`. This classification happens before noise
classification -- noise knobs are never evaluated for zero-baseline tests.

**Status classification** (checked in this order, after zero-baseline
tests have already been classified as `N/A`):
1. If any enabled noise knob triggers -> `noise`
2. If `Delta = 0` -> `unchanged`
3. If `bigger_is_better` and `Delta > 0` -> `improved`
4. If `bigger_is_better` and `Delta < 0` -> `regressed`
5. If not `bigger_is_better` and `Delta < 0` -> `improved`
6. If not `bigger_is_better` and `Delta > 0` -> `regressed`

Status uses the sign of Delta (not Ratio) combined with `bigger_is_better`.

**Geomean summary row.** Computed over N valid tests where both sides are
present, both values are non-zero, and ratio is defined:

| Quantity        | Formula                                     |
|-----------------|---------------------------------------------|
| Geomean A       | `exp(mean(ln(\|vA_i\|)))` for i = 1..N      |
| Geomean B       | `exp(mean(ln(\|vB_i\|)))` for i = 1..N      |
| Ratio (geomean) | `exp(mean(ln(\|ratio_i\|)))` for i = 1..N   |
| Delta           | `Geomean B - Geomean A`                     |
| Delta %         | `(Delta / \|Geomean A\|) * 100`             |

Absolute values are taken before computing the geometric mean so that
negative metric values do not produce undefined logarithms. The Ratio
column shows the geometric mean of per-test ratios (the multiplicative
average), which differs from `Geomean B / Geomean A`. The former weights
all tests equally regardless of absolute magnitude; the latter is
dominated by tests with large absolute values. For example, given two
tests with ratios 2.0 and 0.5, the geomean of ratios is
`sqrt(2.0 * 0.5) = 1.0` (no net change), while the ratio of geomeans
depends on the magnitude of the values.

**Chart Y-axis.** The chart plots `log2(Ratio)` = `log2(vB / vA)`. The
log2 scale makes equal multiplicative changes symmetric: a 2x speedup
(ratio = 0.5) and a 2x slowdown (ratio = 2.0) appear at -1 and +1
respectively, equidistant from zero. Tick labels show the equivalent
percentage change at "nice" values (+/-1%, +/-5%, +/-10%, etc.).

A test is excluded from the chart when any of these conditions hold:
- Only one side has the test (not present on both sides)
- `vA = 0` (ratio undefined)
- Ratio <= 0 (log2 undefined -- occurs when `vA` and `vB` have opposite
  signs, or when `vB = 0`)

**Noise band on chart.** When the Delta % knob is enabled, horizontal
dashed lines are drawn at the log2-space equivalents of the threshold:
- Upper line: `log2(1 + threshold/100)`
- Lower line: `log2(1 - threshold/100)` when threshold < 100%;
  otherwise `-log2(1 + threshold/100)` (forced symmetric, because
  `log2(1 - t/100)` is undefined when `t >= 100%`)

For small thresholds these lines are approximately symmetric (e.g. 5%
maps to +0.070 / -0.074). The asymmetry grows with larger thresholds.
A test whose bar falls inside the band has `|Delta %| < threshold`.
- Sortable by any column (click header)
- Color-coded status: green = improved, red = regressed (direction respects the metric's `bigger_is_better` flag)
- **Noise handling**: rows classified as noise by any enabled noise filtering knob are visually distinguished by the grey "noise" label in the Status column. The "Hide noise" checkbox removes them from the table and chart entirely (not rendered in the DOM).
- **Noise tooltip**: hovering over the Status cell of a noise-classified row shows a tooltip listing all knobs that triggered, e.g. "Delta 0.3% below 1% threshold", "p-value 0.12 above 0.05", "max(|A|, |B|) = 0.4 below floor of 1". All triggered knobs are shown, not just the first.
- **Missing tests**: tests present in only one side show "\u2014" for the missing side's values. These are grayed out in a separate section at the bottom, excluded from the chart. This includes tests absent due to cross-suite comparison (different suites may have different test sets).
- **Null metrics**: when a test has a sample but no value for the selected metric, display "N/A" in the table and exclude from the chart
- **Zero baseline**: when Value A is 0, display "N/A" for Delta %, Ratio, and Status (raw values are still shown)
- **Interactive rows**: Clicking a row toggles its visibility on the chart. Double-clicking a row isolates it (hides all others), like the Graph page's legend table. Manually-hidden rows (toggled by clicking) are shown grayed out in the table (not removed from the DOM). The "Hide noise" checkbox is a separate filter that removes noise rows from the DOM entirely. The two filters are independent: manual toggles persist across hideNoise changes, and changing noise filtering knobs correctly hides/unhides tests as their status changes.
- **Summary message**: A message above the table rows shows a count, consistent with the Graph page's legend message: "150 tests" when all visible, "120 of 150 tests visible" when some are hidden, or "42 of 150 tests matching" when a text filter or chart zoom is active. Counts reflect only tests present in the table — noise-hidden tests (removed by "Hide noise") are excluded from both the numerator and denominator.
- **Copy as CSV**: A small clipboard icon button (right-justified on the summary message row) copies the visible comparison table as CSV to the clipboard. The exported CSV contains exactly the rows visible in the table (respecting noise hiding, manual click-hiding, text filter, and chart zoom), in the current sort order, with the geomean summary as the first data row. Columns match the table: Test, Value A, Value B, Delta, Delta %, Ratio, Status. The button provides brief visual feedback indicating success or failure. Hidden when no rows are visible.
- **Profile column**: When both sides have profile data for a test, a
  "Profile" link appears. Clicking it navigates to the Profiles page
  pre-populated with both sides' run and test:
  `/v5/profiles?suite_a={ts_a}&run_a={uuid_a}&test_a={test}&suite_b={ts_b}&run_b={uuid_b}&test_b={test}`
  When only one side has a profile, the link pre-populates just that side.
  The link is omitted when neither side has a profile for that test.
- **Filter performance**: Typing in the test filter must feel instant even with
  thousands of tests. The table updates immediately on each keystroke; the chart
  may update asynchronously (within one animation frame) to avoid blocking input.


### Chart

Sorted ratio chart (relative performance chart):
- **X-axis**: tests, sorted by B/A ratio
- **Y-axis**: `log2(Ratio)` -- see Computation Reference for definition, symmetry rationale, and chart exclusion criteria. Tick labels show percentage change at "nice" values (+/-1%, +/-5%, +/-10%, +/-50%, +/-100%, etc.), auto-adapting to the data range
- Rendered as a connected line (not discrete bars) for readability at scale

Interactivity:
- **Hover**: tooltip showing test name, exact ratio, and absolute values for both sides
- **Zoom / drag-select**: filters the comparison table to show only the tests in the visible range
- **Noise band**: see Computation Reference for how the Delta % threshold is converted to log2 space. The p-value and absolute floor knobs do not have chart-level visualization.
- **Text filter**: the chart applies the text filter from the selection panel; the text filter stacks with the chart zoom filter (intersection)
- **Zoom preservation**: changing noise filtering knobs, aggregation functions, text filter, or toggling row visibility preserves the current chart zoom. The user can double-click the chart to reset zoom.
- **Adaptive tick labels on zoom**: tick labels recompute dynamically when the user zooms -- zooming into a narrow range shows fine-grained percentage ticks (+/-1%, +/-2%), while the full view shows coarser ticks (+/-50%, +/-100%). Double-click reset restores ticks for the full data range.
- **Empty state**: when there is no data to chart (no comparison triggered yet, or no tests match), the chart area displays "No data to chart." -- consistent with the Graph page's empty-state pattern.


### Comparison Summary Bar

A horizontal summary bar between the chart and the comparison table shows the
count of tests in each status category, with percentages for comparable
categories:

| Category   | Counts rows where                          | Dot color |
|------------|--------------------------------------------|-----------|
| Improved   | `status === 'improved'`                    | `#2ca02c` |
| Regressed  | `status === 'regressed'`                   | `#d62728` |
| Noise      | `status === 'noise'`                       | `#999999` |
| Unchanged  | `status === 'unchanged'`                   | `#999999` |
| Only in A  | `sidePresent === 'a_only'`                 | `#888888` |
| Only in B  | `sidePresent === 'b_only'`                 | `#888888` |
| N/A        | `status === 'na'`                          | `#888888` |

**Comparable categories** (Improved, Regressed, Noise, Unchanged) show a
colored dot, label, and "count (pct%)" where the denominator is the sum of
comparable categories only (within the filtered set). Percentages use one
decimal place, except whole numbers drop the trailing `.0` (e.g. `25%` not
`25.0%`). Percentages among comparable categories sum to ~100% (one-decimal
rounding may cause minor drift). When there are no comparable tests
(`comparableTotal = 0`), comparable categories show just the count with no
percentage. A tooltip on the `.summary-count` span explains the denominator.

**Non-comparable categories** (Only in A, Only in B, N/A) show a colored
dot, label, and count only — no percentage.

**Filtering behavior**: the summary bar respects the text filter and chart zoom
(counts reflect only tests visible in those filters). The comparable-category
denominator is the comparable count within the filtered set. The bar does NOT
respect the "Hide noise" toggle -- noise and unchanged tests are always
counted. This ensures the user can see the full status breakdown even when
noise rows are hidden from the table and chart. The source of truth is the
full comparison result (`lastRows`), filtered by text filter and chart zoom.

**Zero-count categories**: shown with reduced opacity (0.5) for visual muting
rather than hidden, providing layout stability.

**Empty state**: when no comparison data exists (total = 0), the summary bar
renders nothing (empty container). When `total > 0` but all tests are
non-comparable (`comparableTotal = 0`), all categories render with bare
counts and no percentages.


### Bidirectional Chart-Table Sync

The chart and table always represent the same dataset:
- **Chart -> Table**: zooming or drag-selecting on the chart filters the table to the matching tests
- **Table -> Chart**: the text filter and row toggles update the chart to show only visible, matching tests
- **Hover sync**: hovering on a chart point highlights the table row (scrolls into view); hovering on a table row highlights the chart point


### Data Flow

1. Page loads: fetch metric metadata via `GET test-suites/{ts}` (fields from `schema.metrics`). Commits are fetched per-machine via `GET commits?machine={name}` (cursor-paginated) when a machine is selected, to populate the commit combobox with only the commits relevant to that machine.
2. User selects commit and machine on each side. On each change, fetch `GET runs?machine=M&commit=O` to populate the runs checkbox list. If no runs exist, show an empty list.
3. Once both sides have runs and a metric is selected, comparison triggers automatically. Fetch sample data for each selected run via `GET runs/{uuid}/samples` (cursor-paginated with `limit=10000`). Show a progress indicator during fetch.
4. Client-side: aggregate samples (within-run via sample aggregation), aggregate across runs (via run aggregation), join on test name, compute derived columns (delta, ratio, status, p-value when the knob is enabled).
5. Render table and chart.
6. Subsequent filter/sort/zoom operations are client-side (data already loaded).
7. If the user changes selections while data is loading, abort the in-flight requests before starting new ones.
8. For the Profile column, call `GET /runs/{uuid}/profiles` for each side's
   runs (fired in parallel via `Promise.all`). Cache per run UUID alongside
   the sample cache. Match profiles to test names to determine which rows
   get a Profile link.

**Per-run sample caching**: Fetched samples are cached per run UUID. Changing
the metric, aggregation function, noise filtering settings, or run selection
re-aggregates and re-compares from cache without any API calls. Only selecting
a new commit or machine (which produces different run UUIDs) triggers new
fetches, and only for runs not already in the cache.


### URL State

All selection state is encoded as query parameters for shareability:
- `suite_a`, `commit_a`, `machine_a`, `runs_a` (comma-separated UUIDs), `run_agg_a`
- `suite_b`, `commit_b`, `machine_b`, `runs_b`, `run_agg_b`
- `metric`, `sample_agg`
- `noise_pct`, `noise_pval`, `noise_floor` (knob values; omitted when at defaults: 1, 0.05, 0 respectively), `noise_pct_on`, `noise_pval_on`, `noise_floor_on` (knob enabled state; all default to disabled, so `_on` params only appear as `1` when enabled), `hide_noise`
- Filter/sort state as applicable

Auth token is stored in `localStorage`, not in URL state (to avoid leaking
credentials when sharing URLs). All URL updates use `replaceState` (not
`pushState`) so the browser Back button navigates between pages, not between
individual setting changes.


**Links out**: Machine Detail, Run Detail, Graph (with machine pre-filled),
Regression Detail, Profiles (pre-populated A/B from comparison row).


### Shadow Trace (Comparison Overlay)

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
- Thin line trace, independently sorted by its own ratio ascending, producing
  a smooth curve. It does NOT share X positions with the main bars — each
  trace uses its own sequential X positions (0..N). The X-axis range
  accommodates whichever trace has more points.
- Muted blue color, distinct from the green/red/grey status-coded bars.
- No legend displayed. The shadow chip above the chart identifies the trace.
- Shadow Y values are included in the Y-axis range calculation for tick
  generation.
- Text filter, hide-noise, and manual row toggles apply to the shadow trace
  the same as the main.

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

`sampleAgg` is a global visualization preference — both main and shadow respond
to it equally. `runAgg` is per-side: the shadow's `runAgg` is frozen at pin
time.

**Data flow:**
- On pin: a deep copy of the current side B selection is stored as the shadow.
  The shadow's side B samples are already in the sample cache.
- On recompute: the shadow reuses the main comparison's cached side A
  aggregation, then aggregates only the shadow's side B samples independently.
- Cache eviction preserves shadow-referenced run UUIDs alongside the main
  selection's UUIDs.
- On page load from a URL with shadow parameters, shadow samples are fetched
  in parallel with the main samples. Shadow fetch failures are tolerated —
  the main comparison still renders.

**URL encoding:**
- Shadow side B is encoded with the same scheme as side A and side B, using
  the suffix `shadow_b` (e.g., `suite_shadow_b`, `commit_shadow_b`,
  `runs_shadow_b`, `run_agg_shadow_b`).
- The shadow display label is not stored in the URL — it is derived from the
  shadow's commit and machine at render time.


### Add to Regression

A collapsible panel (button: "Add to regression" in the controls area). When
expanded, offers:
- "Create new regression" -- pre-fills commit, machines, tests, and metrics from the current comparison into a new regression
- "Add to existing" -- a regression search combobox; adds the comparison's indicators to the selected regression. The regression search combobox follows the same pattern as the machine combobox: it fetches the regression list once on creation (limit 500), filters locally on each keystroke, and uses the standard combobox ARIA and keyboard behavior (collapse on select, ArrowDown/ArrowUp/Enter/Escape, close on blur and outside click). On selection, the input shows the selected regression's title. Enter on the input is a no-op (the user must select from the dropdown list, since regressions are identified by UUID).

Only tests currently visible in the comparison table are included as
indicators (tests that are noise-hidden, manually-hidden, or excluded by the
text filter are not included).

On successful creation, the feedback shows "Regression created: " followed by a
clickable link to the new regression's detail page. The link text is the
regression title if one was provided, otherwise the first 8 characters of the
UUID. Clicking the link performs a full page load (crossing from suite-agnostic
to suite-scoped context). The title input is cleared after successful creation.

On successful addition of indicators to an existing regression, the feedback
shows "Added N indicator(s) to " followed by a clickable link to the
regression detail page. The link text is the regression title if available,
otherwise the first 8 characters of the UUID.

The panel collapses back to the button when done.
