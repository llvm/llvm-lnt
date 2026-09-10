# v5 Web UI: Detail pages

Page specifications for the various detail pages. The detail pages present
detailed information about various entities. They are accessible by clicking
on these entities from other pages (e.g. the `Test Suite / Runs` page).


## Machine Detail -- `/suites/{ts}/machines/{name}`

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
Clicking "Delete Machine" shows a confirmation prompt (below the action row) requiring the user to type
the machine name. Deletion requires a valid API token with `manage` scope. On success, navigates to the
test suites page. While the delete is in progress, a message reassures the user that deletion may take a
while for machines with many runs.

### Tracked toggle

The info box shows a `Tracked` checkbox reflecting the machine's `tracked`
flag. Toggling it issues `PATCH /machines/{name}` and requires an API token
with `manage` scope; without one the checkbox is disabled and hovering it
explains why. Unchecking it excludes the machine from the Dashboard's trend
overview -- it stays fully available in Graph, Compare, Profiles, and every
listing. The label carries a help tooltip saying so, and makes clear that the
flag is not a lifetime policy: untracked machines are kept indefinitely.

### Active regressions table

A section showing non-resolved regressions (state: detected, active) with at least one
indicator on this machine. Each row's title links to its regression detail page.

Each row shows:
- Regression: the regression's title (truncated to 50 chars, or (untitled)), link to the regression detail page
- State: a colored state badge
- Tests: the number of affected tests

If there are no unresolved regressions for the machine, it shows "No active regressions on this machine."
Below the table (when populated) there's a "Show all regressions" button linking to the regression list page
under `Test Suites`, pre-filtered for this machine.

### Run History table

Shows the 25 runs most recently submitted to this machine. Entities (runs, commits) are clickable and
lead to the details page for that object.


## Run Detail -- `/suites/{ts}/runs/{uuid}`

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

[Compare with...] [Delete run]

Metric [metric dropdown]

[Filter tests...]

Test                                                                                  Value
-------------------------------------------------------------------------------------------
BM_align/1                                                                            1.264
BM_ascii_text<char>                                                                 66655.7
BM_BitsetToString<1048576>/Dense_(90%)/90                                           59242.7
```

### Action buttons

"Compare with..." button navigates to the Compare page (pre-selects this run's machine and commit
on side A).

Clicking "Delete Run" shows a confirmation prompt (below the action row) requiring the user to type
the first 8 characters of the run UUID. Deletion requires a valid API token with `manage` scope. On
success, navigates to the machine detail page.

### Metric selector

The metric selector drop-down controls which metric column is shown in the
samples table, consistent with how the Compare page handles metric selection.

### Test filter

Text input for substring matching on test names (client-side).

### Samples table

All samples + selected metric value, sorted by test name by default.

Samples are loaded progressively -- the table renders immediately with the first
page and grows as more pages arrive, with a progress indicator showing the
count. Multiple samples for the same test (repetitions) appear as separate rows.

Tests with profiles show a "Profile" link/icon in the samples table. The link navigates
to `/profiles?suite_a={ts}&run_a={uuid}&test_a={test}`.


## Commit Detail -- `/suites/{ts}/commits/{value}`

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
------------------------------------------------------------------------------------
linux-x86_64                                  67713ef1...     2026-08-25, 2:22:36 PM
etc...
```

### Display and edit

The various commit fields are displayed prominently. Inline edit buttons allow setting
or clearing the tag and ordinal via `PATCH /commits/{value}`. Editing requires an API
token with `manage` scope; show an auth error if the token is missing or insufficient.

### Navigation

Previous / next buttons allow navigating to the previous or next commit based on ordinals.
If the commit has no ordinal, these buttons are greyed out.

### Regressions section

Section listing regressions where `commit` matches this commit's value. Each row's title
links to its regression detail page. Displays `No regressions at this commit.` if there
are no regressions.

### Runs section

Displays the runs at this commit in a table. Provides a text input for substring matching
on machine names, filters the runs table. The summary updates to reflect filtered counts
(e.g. "5 of 12 runs across 2 of 8 machines").


## Regression Detail -- `/suites/{ts}/regressions/{uuid}`

Investigation and management page for a single regression.

**Page header**: Shows "Regression: {title}" when a title is set, or
"Regression: {uuid_short}" as fallback. Updates dynamically when the title is
edited.

**Header section** (editable fields):
- Title: inline-editable text. Enter key saves.
- State: dropdown selector (detected, active, not_to_be_fixed, fixed,
  false_positive)
- Bug: URL input (opens in new tab when set). Enter key saves.
- Commit: display value shown (linked to commit detail page). Combobox with API
  search for editing (shows display values in dropdown). Nullable.
- Notes: text display with Edit button. Edit mode shows textarea + Save/Cancel.
  Ctrl/Cmd+Enter saves. Display preserves line breaks (pre-wrap).

**Delete regression**: Button with type-to-confirm prompt. Requires `triage`
scope. On success, navigates to the regressions tab.

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
- "View on graph" link per indicator: opens Graph page pre-populated with the
  indicator's machine, test, metric, and the regression's commit as context

Auth: requires `triage` scope for all modifications.
