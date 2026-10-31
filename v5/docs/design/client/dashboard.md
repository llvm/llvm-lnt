# v5 Web UI: Dashboard

Page specification for the Dashboard at `/`.

This is the suite-agnostic landing page providing an at-a-glance visual overview of
performance trends across all test suites, grouped by project (see D7).

## DA1: Layout

- Page header "Dashboard" with a commit range preset selector (`Last 100` / `Last 500`
  / `Last 1000` buttons, default `Last 500`) at the top-right, persisted in the URL
  as `range` (e.g. `?range=100`).
- Beside it, a `Project` dropdown narrows the page to one project. It offers
  `All projects`, the default, and every project, labelled and ordered as AR22
  says. The project picked is persisted in the URL as `project`, by name
  (e.g. `?project=libcxx`). Only the sections shown fetch their data.
- Both controls sit in the page header rather than in a controls panel, an
  exception to AR5.
- One section per project, under a heading with the project's label (see
  AR22), linking to the project's suites on the Test Suites page
  (`/projects/{p}`, see TS1). Projects are in AR22's order. A project with no
  suites says so in its section. When there are no projects, the page says so.
  Only a failure to load the list of projects in the first place takes the
  place of the sections, with a way to try again; when the list is fetched
  again and that fails, the page keeps showing what it shows (see AR7).
- Within a project's section, one section per suite of the project, in AR22's
  order, under a heading with the suite's label.
- Each suite section contains a responsive grid of sparkline cards -- one card
  per metric the suite schema marks `dashboard: true` (see D4), in schema order.
  Only a numeric metric (see D3) can be marked, since the others have no
  meaningful geomean. A suite with no card still has its section, which says
  why in place of its cards: that the suite has no numeric metric, or, when it
  has some but marks none of them, that it shows no metrics on the Dashboard,
  with a link to the suite's Schema tab (TS6), from which they can be chosen
  (TS7).

## DA2: Sparkline cards

- Each card shows a small time-series chart (~300x160px) with the metric's
  label as the card title, followed by its unit, as AR6 writes it, when it has
  one.
- Up to 5 traces per chart, one per most-recently-active machine. The set is chosen
  once per suite rather than per metric: the first 5 machines of
  `GET /api/projects/{p}/suites/{s}/machines?tracked=true&sort=-last_run_at` that
  have runs. The same machines are then requested for every card in that suite's
  section. Each card fetches its data in one call to
  `GET /api/projects/{p}/suites/{s}/trends?metric={name}&machine=...&last_n={range}`.
  Only machines with `tracked: true` are eligible -- untracked machines are ad-hoc or
  retired configurations not tracked in the overview. A suite with no tracked machine
  that has runs says so in place of its cards. A machine with no data for a given
  metric simply has no trace on that card, and a card on which no machine has a trend
  says so in place of its chart.
- Each trace is a colored line. A machine has the same color on every card of
  its suite.
- X-axis: sequential position (evenly spaced, no axis labels) among the
  commits any of the card's traces has data at, in ordinal order. A machine's
  line runs straight across the commits where it has no value.
- Y-axis: the trend item's `value` at each commit for that machine+metric
  combination, a geometric mean across tests. See below for calculation.
- Hover tooltip shows the machine name, the commit's display value (see AR6),
  and the value, followed by the metric's unit abbreviation, or its unit when
  it has none. Trend items do not carry the commit's fields, so a card resolves
  the display values of its commits through
  `POST /api/projects/{p}/suites/{s}/commits/resolve`.
- Clicking a sparkline, or the card's title, navigates to the Graph page
  pre-populated with that suite, metric, and the machines with a trace on the
  card. Clicking directly on a specific trace -- the one whose hover tooltip
  shows -- navigates with just that machine. While a card shows no chart, its
  title is a disabled link (see AR8).
- Loading state: placeholder skeleton with "Loading..." while data is being
  fetched, including after the commit range changes, rather than the chart of
  the previous range.
- Error state: the card says why its data could not be fetched, with a way to
  try again (see AR7).

## DA3: Why per-machine traces (not a single aggregate)

Per-machine traces surface machine-specific trends that a single aggregate
line would hide. With only 5 traces, readability is fine. The dashboard's
purpose is trend visualization.

## DA4: Geomean calculation

Computed server-side by the trends endpoint, from the run geomeans (see O9)
under the median sample aggregation.
