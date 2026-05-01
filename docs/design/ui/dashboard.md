# v5 Web UI: Dashboard

Page specification for the Dashboard at `/v5/`.

For the SPA architecture and routing, see [`architecture.md`](architecture.md).
Related pages: [Graph](graph.md), [Compare](compare.md).


## Dashboard -- `/v5/`

Suite-agnostic landing page providing an at-a-glance visual overview of
performance trends across all test suites.

**Layout**:
- Page header "Dashboard" with a commit range preset selector (Last 100 / Last 500 / Last 1000 buttons, default Last 500) at top-right, persisted in URL as `?range=500`.
- One section per test suite (ordered alphabetically, matching `getTestsuites()`).
- Each suite section contains a responsive grid of sparkline cards -- one card per metric defined in the suite schema.

**Sparkline cards**:
- Each card shows a small time-series chart (~300x160px) with the metric name (and unit, if available) as the card title.
- Up to 5 traces per chart, one per most-recently-active machine (determined from recent runs sorted by start_time). Each trace is a colored line.
- X-axis: sequential position (evenly spaced, no axis labels); commit string shown on hover. Y-axis: geometric mean of all test values at each commit for that machine+metric combination.
- Hover tooltip shows the machine name, commit string, and value.
- Clicking a sparkline navigates to the Graph page pre-populated with that suite, metric, and the displayed machines. Clicking directly on a specific trace navigates with just that machine.
- Loading state: placeholder skeleton while data is being fetched.
- Error state: "Failed to load" message if fetching fails.

**Why per-machine traces (not a single aggregate)**: Per-machine traces surface machine-specific regressions that a single aggregate line would hide. With only 5 traces, readability is fine. The dashboard's purpose is anomaly detection.

**Data flow**:
1. Suite names from `getTestsuites()` (embedded in HTML shell, no API call).
2. Per suite: `getTestSuiteInfo()` for the metrics schema, `getRunsPage(sort=-start_time, limit=50)` to find the 5 most recently active machines.
3. Per suite x metric: `fetchTrends()` calls `POST /api/v5/{ts}/trends` with the metric, machine list, and `last_n` filter. The server groups all samples by (machine, commit) and returns the geomean per group for the most recent N commits by ordinal. The frontend groups the response by machine, sorts by ordinal, and assigns sequential x-positions (0, 1, 2, ...) for even spacing into `SparklineTrace[]`.
4. Sparklines render progressively as each metric's data arrives.

**Geomean**: `exp(mean(ln(values)))`, skipping zero/negative values. Computed server-side in the trends endpoint. Shared utility in `utils.ts` also used by the Compare page.
