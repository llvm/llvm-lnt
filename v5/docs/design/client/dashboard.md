# v5 Web UI: Dashboard

Page specification for the Dashboard at `/`.

This is the suite-agnostic landing page providing an at-a-glance visual overview of
performance trends across all test suites.

## Layout

- Page header "Dashboard" with a commit range preset selector (`Last 100` / `Last 500`
  / `Last 1000` buttons, default `Last 500`) at the top-right, persisted in URL as
  `?range=500`.
- One section per test suite (ordered alphabetically).
- Each suite section contains a responsive grid of sparkline cards -- one card
  per numeric metric defined in the suite schema (see D3). Non-numeric metric
  fields have no meaningful geomean and are skipped.

## Sparkline cards

- Each card shows a small time-series chart (~300x160px) with the metric name
  and unit (if any) as the card title.
- Up to 5 traces per chart, one per most-recently-active machine. The set is
  chosen once per suite rather than per metric, via
  `GET /api/suites/{ts}/machines?tracked=true&sort=-last_run_at&limit=5`, and
  the same machines are then requested for every card in that suite's section
  through `POST /api/suites/{ts}/trends`. Only machines with `tracked: true`
  are eligible -- untracked machines are ad-hoc or retired configurations not
  tracked in the overview. A machine with no data for a given metric simply has
  no trace on that card. Each trace is a colored line.
- X-axis: sequential position (evenly spaced, no axis labels).
- Y-axis: geometric mean of all test values at each commit for that machine+metric
  combination. See below for calculation.
- Hover tooltip shows the machine name, commit (or `display` field), and value.
  A trend item carries the raw commit string and its tag but not the commit's
  `display` field -- the server spec confines that denormalization to `ordinal`
  and `tag` (see R4) -- so a section that renders display values resolves the
  commits of its window once through `POST /api/suites/{ts}/commits/resolve`, the
  same call the Graph page's baseline chips make, and falls back to the raw
  string for any commit it did not resolve.
- Clicking a sparkline navigates to the Graph page pre-populated with that
  suite, metric, and the displayed machines. Clicking directly on a specific
  trace navigates with just that machine.
- Loading state: placeholder skeleton with "Loading..." while data is being fetched.
- Error state: "Failed to load" message if fetching fails.

## Why per-machine traces (not a single aggregate)

Per-machine traces surface machine-specific trends that a single aggregate
line would hide. With only 5 traces, readability is fine. The dashboard's
purpose is trend visualization.

## Geomean calculation

`exp(mean(ln(values)))`, skipping zero/negative values. Computed server-side in the
trends endpoint.
