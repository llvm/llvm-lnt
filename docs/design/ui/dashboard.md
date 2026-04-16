# v5 Web UI: Dashboard

Page specification for the Dashboard at `/v5/`.

For the SPA architecture and routing, see [`architecture.md`](architecture.md).
Related pages: [Graph](graph.md), [Compare](compare.md).


## Dashboard -- `/v5/`

Suite-agnostic landing page providing an at-a-glance visual overview of
performance trends across all test suites.

**Layout**:
- Page header "Dashboard" with a time range preset selector (30d / 90d / 1y buttons, default 30d) at top-right, persisted in URL as `?range=30d`.
- One section per test suite (ordered alphabetically, matching `getTestsuites()`).
- Each suite section contains a responsive grid of sparkline cards -- one card per metric defined in the suite schema.

**Sparkline cards**:
- Each card shows a small time-series chart (~300x160px) with the metric name (and unit, if available) as the card title.
- Up to 5 traces per chart, one per most-recently-active machine (determined from recent runs sorted by start_time). Each trace is a colored line.
- X-axis: run timestamps. Y-axis: geometric mean of all test values at each commit for that machine+metric combination.
- Hover tooltip shows the value and machine name.
- Clicking a sparkline navigates to the Graph page pre-populated with that suite, metric, and the displayed machines. Clicking directly on a specific trace navigates with just that machine.
- Loading state: placeholder skeleton while data is being fetched.
- Error state: "Failed to load" message if fetching fails.

**Why per-machine traces (not a single aggregate)**: Per-machine traces surface machine-specific regressions that a single aggregate line would hide. With only 5 traces, readability is fine. The dashboard's purpose is anomaly detection.

**Data flow**:
1. Suite names from `getTestsuites()` (embedded in HTML shell, no API call).
2. Per suite: `getTestSuiteInfo()` for the metrics schema, `getRunsPage(sort=-start_time, limit=50)` to find the 5 most recently active machines.
3. Per suite x metric: `fetchTrends()` calls `POST /api/v5/{ts}/trends` with the metric, machine list, and `after_time` filter. The server groups all samples by (machine, commit) and returns the geomean per group. The frontend groups the response by machine into `SparklineTrace[]`.
4. Sparklines render progressively as each metric's data arrives.

**Geomean**: `exp(mean(ln(values)))`, skipping zero/negative values. Computed server-side in the trends endpoint. Shared utility in `utils.ts` also used by the Compare page.
