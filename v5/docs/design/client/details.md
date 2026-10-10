# v5 Web UI: Detail pages

Page specifications for the various detail pages. The detail pages present
detailed information about various entities. They are accessible by clicking
on these entities from other pages (e.g. the `Test Suite / Runs` page).


## DT1: Machine Detail -- `/suites/{ts}/machines/{name}`

Deep dive into a single machine. Machine names are guaranteed unique. Layout:

```
# Machine: linux-x86_64-20260812

+----------------------------------------------------------------+
| Tracked:           [x]                                         |
| compiler:          clang version 22.1.0                        |
| test_suite_commit: 8bb5e216937e6b541f351aa1637c67e85a43ada0    |
| etc...                                                         |
+----------------------------------------------------------------+

[View Graph] [Compare] [Delete Machine]

## Active Regressions

UUID          Title                   State             Tests
-------------------------------------------------------------
3f0ac112...   find_if slowdown        detected          12
etc...

## Run History

Run                   Commit                Submitted
------------------------------------------------------------------
573af861...           014621ede7c1          2026-08-25, 2:22:41 PM
2cb00c2d...           e8cb3559eec0          2026-08-18, 3:57:56 AM
etc..

[<- Previous] [Next ->]
```

### Action buttons

"View Graph" (pre-filled machine), "Compare" (pre-selected machine), and red "Delete Machine" button.
Clicking "Delete Machine" shows its confirmation prompt (see AR2) below the action row.
Deletion requires `manage` scope. On success, navigates to the Machines tab of the Test
Suites page. While the delete is in progress, a message reassures the user that deletion
may take a while for machines with many runs.

### Tracked toggle

The info box shows a `Tracked` checkbox reflecting the machine's `tracked` flag.
Toggling it saves the change at once with `PATCH /machines/{name}` (see
"Controls saving on change" in AR2), which requires `manage` scope. Unchecking
it excludes the machine from the Dashboard's trend overview -- it stays fully
available in Graph, Compare, Profiles, and every listing. The label carries a
help tooltip saying so, and makes clear that the flag is not a lifetime policy:
untracked machines are kept indefinitely.

### Active regressions table

A section showing non-resolved regressions (state: detected, active) with at least one
indicator on this machine, newest first
(`GET /regressions?machine={name}&state=detected&state=active&sort=-created_at&limit=25`).
Each row's title links to its regression detail page.

Each row shows:
- UUID: the regression's shortened UUID, linking to its detail page like Title. As in the
  Regressions tab (TS5), it tells regressions without a title apart.
- Title: the regression's title (truncated to 50 chars, whole on hover), link to the regression detail page
- State: a colored state badge
- Tests: the regression's `test_count`, which counts the tests across all of its
  indicators rather than only those on this machine

If there are no unresolved regressions for the machine, it shows "No active regressions on this machine."
The table has no Previous/Next: below it, a "Show all regressions" button links to the
Regressions tab of the Test Suites page, filtered by this machine only, whatever the state.
It is shown even when the table is empty, since the machine may have resolved regressions.

### Run History table

Shows the runs submitted to this machine, most recent first, 25 per page
(`GET /runs?machine={name}&sort=-submitted_at&limit=25`). Entities (runs, commits) are clickable and
lead to the details page for that object.


## DT2: Run Detail -- `/suites/{ts}/runs/{uuid}`

All data from a single run. Layout:

```
# Run: 573af861-8303-4a5b-a643-b8321e0142c4

+-------------------------------------------------+
| UUID              <uuid>                        |
| Machine           linux-x86_64                  |
| Commit            014621ede7c1                  |
| Submitted         2026-08-25, 2:22:41 PM        |
| <run-parameters>                                |
+-------------------------------------------------+

[Compare with...] [Compare with previous commit] [Delete run]

Metric [metric dropdown]

[Filter tests...]

Test                                                                                  Value
-------------------------------------------------------------------------------------------
BM_align/1                                                                          1.26432
BM_ascii_text<char>                                                                 66655.7
BM_BitsetToString<1048576>/Dense_(90%)/90                                           59242.7
```

The info box has one row per top-level key of the run's `run_parameters`, ordered by key: a
string value as it is, and any other value as compact JSON.

### Action buttons

"Compare with..." button navigates to the Compare page with side A set to this run's commit and
machine, with only this run selected (`runs_a={uuid}`), and the metric selected on this page
(see CP7).

"Compare with previous commit" navigates to the Compare page set up to compare this run with
the commit before it on the same machine: side A is the previous commit (see below) on this
run's machine, with all of its runs, side B is this run's commit and machine with only this
run selected (`runs_b={uuid}`), and the metric is the one selected on this page. The previous
commit is the one with the nearest lower ordinal at which this machine has runs
(`GET commits?machine={name}&before_commit={value}&sort=-ordinal&limit=1`), not the commit's
`previous` neighbour, which may have no runs on this machine. The button is disabled, with a
tooltip saying why, when the run's commit has no ordinal or the machine has no earlier commit,
and while the previous commit is being looked up or could not be.

Both are links, so a modified click opens the comparison in a new tab (see AR2), unless
"Compare with previous commit" is disabled (see "Disabled links" in AR2).

Clicking "Delete run" shows its confirmation prompt (see AR2) below the action row.
Deletion requires `manage` scope. On success, navigates to the machine detail page.

### Metric selector

The metric selector drop-down controls which metric column is shown in the
samples table. It offers every metric of the suite, and defaults to the first
numeric metric (see D3) in schema order, or to the first metric if none is
numeric. The selected metric is kept in the URL as `?metric={name}`, and is
passed on by the Compare links above; Compare drops a metric it does not
offer (see AR2). A suite with no metrics has no selector, and no value column.

### Test filter

Text input for substring matching on test names (client-side), kept in the URL as
`?test_filter={text}`.

### Samples table

All samples + selected metric value, sorted by test name, with no control to sort them
otherwise. The value column is headed by the selected metric's label (see AR2).

Samples are loaded progressively -- the table renders immediately with the first
page and grows as more pages arrive, with a progress indicator showing the
count (see "Paginated tables" in AR2). Once they are all loaded, the count reflects the
filter (e.g. "2 of 25 samples matching"). Multiple samples for the same test (repetitions)
appear as separate rows. The table says `This run has no samples.` when there are none, and
`No tests match the filter.` when the filter keeps none.

Tests with profiles show a "Profile" link/icon in the samples table. The link navigates
to `/profiles?suite_a={ts}&run_a={uuid}&test_a={test}`.


## DT3: Commit Detail -- `/suites/{ts}/commits/{value}`

The "what happened at this commit?" page. Key investigation page for developers.
Layout:

```
# Commit: 014621ede7c175aece29796adcaf5000f891cf0c

+-------------------------------------------------------------+
| Commit            014621ede7c175aece29796adcaf5000f891cf0c  |
| Ordinal           593922    [Edit]                          |
| Tag               --        [Edit]                          |
| <commit-fields>                                             |
+-------------------------------------------------------------+

[<- Previous commit] [Next commit ->] [Delete commit]

## Regressions

UUID          Title                   State             Tests
-------------------------------------------------------------
3f0ac112...   find_if slowdown        detected          12
etc...

[<- Previous] [Next ->]

## Runs

10 runs across 3 machines

[Filter machines...]

Machine                                       Run             Submitted
------------------------------------------------------------------------------------------------------
linux-x86_64                                  67713ef1...     2026-08-25, 2:22:36 PM    [Compare with previous]
etc...
```

### Display and edit

The page header and the `Commit` row show the commit string itself rather than its
display value. The various commit fields are displayed prominently. The ordinal and the
tag are edited in place (see "Inline editing" in AR2) through `PATCH /commits/{value}`,
which requires `manage` scope. Emptying either clears it. An ordinal is an integer that its
column can hold (see D3 and D5): any other text is invalid (see "Invalid input" in AR2).

### Navigation

Previous / next buttons allow navigating to the previous or next commit based on ordinals.
Each is greyed out when there is no such commit: when the commit has no ordinal, and at
either end of the ordered range.

### Delete commit

A red "Delete commit" button follows the navigation buttons. Clicking it shows its
confirmation prompt (see AR2) below them, saying that the commit's runs, with their samples
and profiles, are deleted too, and that the regressions attributed to it are kept, with no
commit (see E3). Deletion requires `manage` scope. While it is in progress, a message
reassures the user that deletion may take a while for commits with many runs. On success,
navigates to the Commits tab of the Test Suites page (`/suites/{ts}?tab=commits`).

### Regressions section

Section listing regressions where `commit` matches this commit's value, newest first,
25 per page with Previous/Next (`sort=-created_at`; see AR2). Its rows are those of DT1's
active regressions table: UUID, Title, State and Tests. Displays
`No regressions at this commit.` if there are no regressions.

### Runs section

Displays every run at this commit in a table, sorted by machine name, and on each machine
newest first. The runs are loaded progressively, as DT2's samples are, with a count of
those loaded so far (see "Paginated tables" in AR2). A text input for substring matching on
machine names, kept in the URL as `?machine_filter={text}`, filters the runs table. Once
every run has loaded, a summary counts them and their machines, and reflects the filter
(e.g. "12 runs across 8 machines", "5 of 12 runs across 2 of 8 machines"). The table says
`No runs at this commit.` when there are none, and `No machines match the filter.` when the
filter keeps none.

Each row has a "Compare with previous" link, which does what the Run Detail page's "Compare
with previous commit" does for that row's run (see DT2). Since this page has no metric
selector, the link carries the metric Run Detail would select by default. The previous commit
is looked up once per machine rather than once per run. The link is disabled, with a tooltip
saying why, when this commit has no ordinal or the row's machine has no earlier commit.


## DT4: Regression Detail -- `/suites/{ts}/regressions/{uuid}`

Investigation and management page for a single regression. Layout:

```
# Regression: find_if slowdown

+---------------------------------------------------------------+
| Title      find_if slowdown                          [Edit]   |
| State      (active) [active v]                                |
| Bug        https://github.com/llvm/llvm-project/...  [Edit]   |
| Commit     014621ede7c1                              [Edit]   |
| Created    2026-08-31, 3:03:36 PM                             |
| Notes      Bisected to the vectorizer change.        [Edit]   |
+---------------------------------------------------------------+

[Delete regression]

## Add indicators

Metric [Execution Time v]

Machines                          Tests
[Filter machines...]              [Filter tests...]
[x] linux-x86_64                  [x] BM_find_if/1024
[ ] macos-26.5-arm64              [x] BM_find_if/4096
etc...                            etc...

This will add 2 indicators.  [Add]

## Indicators (2 tests across 1 machine across 1 metric)

[Filter indicators...]                                  [Remove selected]

[ ]  Machine          Test                 Metric
-----------------------------------------------------------------------------
[ ]  linux-x86_64     BM_find_if/1024      Execution Time    View on graph  x
[ ]  linux-x86_64     BM_find_if/4096      Execution Time    View on graph  x
```

### Page header

The header shows "Regression: {title}", or "Regression: {shortened UUID}" when
the regression has no title. After the title is edited, the header changes once
the new title is saved.

### Info box

The info box shows the regression's title, state, bug, commit and notes, and
when it was created (`created_at`). Everything but the creation time can be
edited with `triage` scope. An empty field shows `--`, the title included.

- Title, Bug and Notes are edited in place (see "Inline editing" in AR2). The
  bug is displayed as AR2 describes. The notes are edited in a multi-line input,
  and displayed with their line breaks.
- State shows the state's colored badge, then a dropdown listing every state.
  Picking a state saves it (see "Controls saving on change" in AR2).
- Commit links to the commit's detail page, showing its display value. It is
  edited in place with a commit picker that offers every commit of the suite
  (see AR2). Clearing the picker removes the commit.

### Delete regression

A red "Delete regression" button follows the info box. Clicking it opens its
confirmation prompt (see AR2) below the button, which says that the regression's
indicators are deleted too. Deleting requires `triage` scope. Afterwards, the
page goes to the Regressions tab of the Test Suites page
(`/suites/{ts}?tab=regressions`).

### Add indicators panel

- Metric: dropdown selector
- Machines: checkbox list with filter input (multi-select, shift+click range)
- Tests: checkbox list with filter input (multi-select, shift+click range),
  filtered by selected machines and metric
- Preview: "This will add N indicators" (machines × tests cross-product)
- "Add" button creates all (machine × test × metric) indicator combinations
- Duplicates (same machine+test+metric already on this regression) are silently
  ignored

### Indicators table

- Heading: "Indicators (X tests across Y machines across Z metrics)" — unique
  counts computed from the indicators. Shows plain "Indicators" when empty. When
  a filter is active: "Indicators (showing N of X tests across ...)".
- Filter: text input above the table for substring matching on machine name,
  test name, or metric (OR logic, case-insensitive). Filters the table rows
  client-side. Not shown when there are no indicators.
- Columns: select checkbox, Machine, Test, Metric, "View on graph" link, remove
  button (×)
- Select-all checkbox in header (with indeterminate state for partial selection)
- Shift+click range selection on checkboxes
- Batch "Remove selected" button
- "View on graph" link per indicator: opens the Graph page with the
  regression's suite and the indicator's machine, metric and test selected, and
  regression annotations
  showing every state (`regressions=all`; see GR15), which marks this
  regression's commit on the chart

Auth: requires `triage` scope for all modifications.
