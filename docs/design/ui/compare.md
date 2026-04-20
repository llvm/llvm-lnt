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
- **Noise threshold**: numeric input defining the minimum |Delta %| to consider significant (default: 1%)
- **Test filter**: text input for substring matching on test names, applied to both table and chart
- **Hide noise**: checkbox that hides noise-status rows from the table and chart

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

- **Geomean summary row**: The first row shows a geomean summary. Value A and Value B columns show the geometric mean of absolute values per side (useful for SPEC-like suites where individual values are comparable). Delta and Delta % are computed from these geomeans. The Ratio column shows the geometric mean of per-test ratios (the multiplicative average speedup), which is subtly different from geomean(B)/geomean(A) but is the standard way to report aggregate speedups.
- Sortable by any column (click header)
- Color-coded status: green = improved, red = regressed (direction respects the metric's `bigger_is_better` flag)
- **Noise handling**: rows with |Delta %| below the noise threshold are visually de-emphasized (lighter text, no color). The "Hide noise" checkbox removes them from the table and chart entirely (not rendered in the DOM).
- **Missing tests**: tests present in only one side show "\u2014" for the missing side's values. These are grayed out in a separate section at the bottom, excluded from the chart. This includes tests absent due to cross-suite comparison (different suites may have different test sets).
- **Null metrics**: when a test has a sample but no value for the selected metric, display "N/A" in the table and exclude from the chart
- **Zero baseline**: when Value A is 0, display "N/A" for Delta %, Ratio, and Status (raw values are still shown)
- **Interactive rows**: Clicking a row toggles its visibility on the chart. Double-clicking a row isolates it (hides all others), like the Graph page's legend table. Manually-hidden rows (toggled by clicking) are shown grayed out in the table (not removed from the DOM). The "Hide noise" checkbox is a separate filter that removes noise rows from the DOM entirely. The two filters are independent: manual toggles persist across hideNoise changes, and changing the noise threshold correctly hides/unhides tests as their status changes.
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
- **Noise band**: horizontal reference lines at the +/- noise threshold to visually separate signal from noise
- **Text filter**: the chart applies the text filter from the selection panel; the text filter stacks with the chart zoom filter (intersection)
- **Zoom preservation**: changing noise settings, aggregation functions, text filter, or toggling row visibility preserves the current chart zoom. The user can double-click the chart to reset zoom.
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
4. Client-side: aggregate samples (within-run via sample aggregation), aggregate across runs (via run aggregation), join on test name, compute derived columns (delta, ratio, status).
5. Render table and chart.
6. Subsequent filter/sort/zoom operations are client-side (data already loaded).
7. If the user changes selections while data is loading, abort the in-flight requests before starting new ones.
8. For the Profile column, call `GET /runs/{uuid}/profiles` for each side's
   runs (fired in parallel via `Promise.all`). Cache per run UUID alongside
   the sample cache. Match profiles to test names to determine which rows
   get a Profile link.

**Per-run sample caching**: Fetched samples are cached per run UUID. Changing
the metric, aggregation function, noise threshold, or run selection
re-aggregates and re-compares from cache without any API calls. Only selecting
a new commit or machine (which produces different run UUIDs) triggers new
fetches, and only for runs not already in the cache.


### URL State

All selection state is encoded as query parameters for shareability:
- `suite_a`, `commit_a`, `machine_a`, `runs_a` (comma-separated UUIDs), `run_agg_a`
- `suite_b`, `commit_b`, `machine_b`, `runs_b`, `run_agg_b`
- `metric`, `sample_agg`, `noise`
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
