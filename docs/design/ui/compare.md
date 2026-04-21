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
    |Delta %| <= threshold are noise. Skipped when Delta % is unavailable (see
    "Zero baseline" bullet in the table section). Input must be >= 0. Hovering
    on the label shows a help tooltip: "Tests where the absolute percentage
    change is within this threshold are considered noise."
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
  - **Identical values**: when delta is exactly zero, the test is always
    classified as noise regardless of which knobs are enabled or disabled.
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
| Delta    | B - A (absolute difference)                              |
| Delta %  | (B - A) / |A| * 100 (abs ensures sign matches direction of change) |
| Ratio    | B / A (same value plotted on the chart)                  |
| Status   | Improved / Regressed / Unchanged (respects bigger_is_better) |

- **Geomean summary row**: The first row shows a geomean summary. Value A and Value B columns show the geometric mean of absolute values per side (useful for SPEC-like suites where individual values are comparable). Delta and Delta % are computed from these geomeans. The Ratio column shows the geometric mean of per-test ratios (the multiplicative average speedup), which is subtly different from geomean(B)/geomean(A) but is the standard way to report aggregate speedups. The geomean summary row is never classified as noise.
- Sortable by any column (click header)
- Color-coded status: green = improved, red = regressed (direction respects the metric's `bigger_is_better` flag)
- **Noise handling**: rows classified as noise by any enabled noise filtering knob are visually distinguished by the grey "noise" label in the Status column. The "Hide noise" checkbox removes them from the table and chart entirely (not rendered in the DOM).
- **Noise tooltip**: hovering over the Status cell of a noise-classified row shows a tooltip listing all knobs that triggered, e.g. "Delta 0.3% below 1% threshold", "p-value 0.12 above 0.05", "max(|A|, |B|) = 0.4 below floor of 1". All triggered knobs are shown, not just the first.
- **Missing tests**: tests present in only one side show "\u2014" for the missing side's values. These are grayed out in a separate section at the bottom, excluded from the chart. This includes tests absent due to cross-suite comparison (different suites may have different test sets).
- **Null metrics**: when a test has a sample but no value for the selected metric, display "N/A" in the table and exclude from the chart
- **Zero baseline**: when Value A is 0, display "N/A" for Delta %, Ratio, and Status (raw values are still shown)
- **Interactive rows**: Clicking a row toggles its visibility on the chart. Double-clicking a row isolates it (hides all others), like the Graph page's legend table. Manually-hidden rows (toggled by clicking) are shown grayed out in the table (not removed from the DOM). The "Hide noise" checkbox is a separate filter that removes noise rows from the DOM entirely. The two filters are independent: manual toggles persist across hideNoise changes, and changing noise filtering knobs correctly hides/unhides tests as their status changes.
- **Summary message**: A message above the table rows shows a count, consistent with the Graph page's legend message: "150 tests" when all visible, "120 of 150 tests visible" when some are hidden, or "42 of 150 tests matching" when a text filter or chart zoom is active. Counts reflect only tests present in the table — noise-hidden tests (removed by "Hide noise") are excluded from both the numerator and denominator.
- **Profile column**: When both sides have profile data for a test, a
  "Profile" link appears. Clicking it navigates to the Profiles page
  pre-populated with both sides' run and test:
  `/v5/profiles?suite_a={ts_a}&run_a={uuid_a}&test_a={test}&suite_b={ts_b}&run_b={uuid_b}&test_b={test}`
  When only one side has a profile, the link pre-populates just that side.
  The link is omitted when neither side has a profile for that test.


### Chart

Sorted ratio chart (relative performance chart):
- **X-axis**: tests, sorted by B/A ratio
- **Y-axis**: log2(ratio) scale -- equal multiplicative changes (e.g. 2x faster vs 2x slower) produce symmetric bars. Tick labels show percentage change at "nice" values (+/-1%, +/-5%, +/-10%, +/-50%, +/-100%, etc.), auto-adapting to the data range
- Rendered as a connected line (not discrete bars) for readability at scale

Interactivity:
- **Hover**: tooltip showing test name, exact ratio, and absolute values for both sides
- **Zoom / drag-select**: filters the comparison table to show only the tests in the visible range
- **Noise band**: horizontal dashed reference lines at +/- the Delta % threshold (when that knob is enabled) to visually separate signal from noise. The p-value and absolute floor knobs do not have chart-level visualization.
- **Text filter**: the chart applies the text filter from the selection panel; the text filter stacks with the chart zoom filter (intersection)
- **Zoom preservation**: changing noise filtering knobs, aggregation functions, text filter, or toggling row visibility preserves the current chart zoom. The user can double-click the chart to reset zoom.
- **Adaptive tick labels on zoom**: tick labels recompute dynamically when the user zooms -- zooming into a narrow range shows fine-grained percentage ticks (+/-1%, +/-2%), while the full view shows coarser ticks (+/-50%, +/-100%). Double-click reset restores ticks for the full data range.
- **Empty state**: when there is no data to chart (no comparison triggered yet, or no tests match), the chart area displays "No data to chart." -- consistent with the Graph page's empty-state pattern.


### Bidirectional Chart-Table Sync

The chart and table always represent the same dataset:
- **Chart -> Table**: zooming or drag-selecting on the chart filters the table to the matching tests
- **Table -> Chart**: the text filter and row toggles update the chart to show only visible, matching tests
- **Hover sync**: hovering on a chart point highlights the table row (scrolls into view); hovering on a table row highlights the chart point


### Data Flow

1. Page loads: fetch metric metadata via `GET test-suites/{ts}` (fields from `schema.metrics`). Commits are fetched per-machine via `GET commits?machine={name}` (cursor-paginated) when a machine is selected, to populate the commit combobox with only the commits relevant to that machine.
2. User selects commit and machine on each side. On each change, fetch `GET runs?machine=M&commit=O` to populate the runs checkbox list. If no runs exist, show an empty list.
3. Once both sides have runs and a metric is selected, comparison triggers automatically. Fetch sample data for each selected run via `GET runs/{uuid}/samples` (cursor-paginated with `limit=500`). Show a progress indicator during fetch.
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


### Add to Regression

A collapsible panel (button: "Add to regression" in the controls area). When
expanded, offers:
- "Create new regression" -- pre-fills commit, machines, tests, and metrics from the current comparison into a new regression
- "Add to existing" -- a regression search combobox; adds the comparison's indicators to the selected regression

Only tests currently visible in the comparison table are included as
indicators (tests that are noise-hidden, manually-hidden, or excluded by the
text filter are not included).

The panel collapses back to the button when done.
