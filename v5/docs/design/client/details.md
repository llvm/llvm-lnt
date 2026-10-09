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

Title                   State             Tests
-----------------------------------------------
find_if slowdown        detected          12
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

The info box shows a `Tracked` checkbox reflecting the machine's `tracked`
flag. Toggling it issues `PATCH /machines/{name}` and requires `manage` scope.
Unchecking it excludes the machine from the Dashboard's trend overview -- it
stays fully available in Graph, Compare, Profiles, and every listing. The label
carries a help tooltip saying so, and makes clear that the flag is not a
lifetime policy: untracked machines are kept indefinitely.

### Active regressions table

A section showing non-resolved regressions (state: detected, active) with at least one
indicator on this machine, newest first
(`GET /regressions?machine={name}&state=detected&state=active&sort=-created_at&limit=25`).
Each row's title links to its regression detail page.

Each row shows:
- Title: the regression's title (truncated to 50 chars), link to the regression detail page
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
BM_align/1                                                                            1.264
BM_ascii_text<char>                                                                 66655.7
BM_BitsetToString<1048576>/Dense_(90%)/90                                           59242.7
```

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
tooltip saying why, when the run's commit has no ordinal or the machine has no earlier commit.

Both are links, so a modified click opens the comparison in a new tab (see AR2).

Clicking "Delete run" shows its confirmation prompt (see AR2) below the action row.
Deletion requires `manage` scope. On success, navigates to the machine detail page.

### Metric selector

The metric selector drop-down controls which metric column is shown in the
samples table. It offers every metric of the suite, and defaults to the first
numeric metric (see D3) in schema order, or to the first metric if none is
numeric. The selected metric is kept in the URL as `?metric={name}`, and is
passed on by the Compare links above; Compare drops a metric it does not
offer (see AR2).

### Test filter

Text input for substring matching on test names (client-side).

### Samples table

All samples + selected metric value, sorted by test name.

Samples are loaded progressively -- the table renders immediately with the first
page and grows as more pages arrive, with a progress indicator showing the
count. Multiple samples for the same test (repetitions) appear as separate rows.

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
| Tag               (none)    [Edit]                          |
| <commit-fields>                                             |
+-------------------------------------------------------------+

[<- Previous commit] [Next commit ->]

## Regressions

Title                   State             Tests
-----------------------------------------------
find_if slowdown        detected          12
etc...

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
display value. The various commit fields are displayed prominently. Inline edit buttons
allow setting or clearing the tag and ordinal via `PATCH /commits/{value}`. Editing
requires `manage` scope.

### Navigation

Previous / next buttons allow navigating to the previous or next commit based on ordinals.
If the commit has no ordinal, these buttons are greyed out.

### Regressions section

Section listing regressions where `commit` matches this commit's value, newest first,
25 per page (`sort=-created_at`). Each row's title links to its regression detail page. Displays
`No regressions at this commit.` if there are no regressions.

### Runs section

Displays the runs at this commit in a table. Provides a text input for substring matching
on machine names, filters the runs table. The summary updates to reflect filtered counts
(e.g. "5 of 12 runs across 2 of 8 machines").

Each row has a "Compare with previous" link, which does what the Run Detail page's "Compare
with previous commit" does for that row's run (see DT2). Since this page has no metric
selector, the link carries the metric Run Detail would select by default. The previous commit
is looked up once per machine rather than once per run. The link is disabled, with a tooltip
saying why, when this commit has no ordinal or the row's machine has no earlier commit.


## DT4: Regression Detail -- `/suites/{ts}/regressions/{uuid}`

Investigation and management page for a single regression.

**Page header**: Shows "Regression: {title}" when a title is set, or
"Regression: {shortened UUID}" as fallback. Updates dynamically when the title
is edited.

**Header section** (editable fields):
- Title: inline-editable text. Enter key saves.
- State: dropdown selector (detected, active, not_to_be_fixed, fixed,
  false_positive)
- Bug: URL input (opens in new tab when set). Enter key saves.
- Commit: linked to the commit detail page. A commit picker over every commit
  of the suite for editing (see AR2). Nullable.
- Notes: text display with Edit button. Edit mode shows textarea + Save/Cancel.
  Ctrl/Cmd+Enter saves. Display preserves line breaks (pre-wrap).

The header also shows, read-only, when the regression was created (`created_at`).

**Delete regression**: Button with a confirmation prompt (see AR2). Requires
`triage` scope. On success, navigates to the regressions tab.

**Add indicators panel**:
- Metric: dropdown selector
- Machines: checkbox list with filter input (multi-select, shift+click range)
- Tests: checkbox list with filter input (multi-select, shift+click range),
  filtered by selected machines and metric
- Preview: "This will add N indicators" (machines × tests cross-product)
- "Add" button creates all (machine × test × metric) indicator combinations
- Duplicates (same machine+test+metric already on this regression) are silently
  ignored

**Indicators table**:
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
