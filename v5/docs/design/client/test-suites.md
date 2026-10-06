# v5 Web UI: Test Suites

Page specifications for the Test Suites page (suite picker + tabs).


## TS1: Test Suites -- `/suites` and `/suites/{ts}`

The primary entry point for browsing test suite data. `/suites` shows the suite
picker alone; `/suites/{ts}` shows the picker with `{ts}` selected, plus the
tabbed content for that suite.

**Suite picker**: A row of prominent card/button elements, one per test suite.
Clicking a card selects it (highlighted) and shows the tab bar below, navigating
to `/suites/{name}`. When no suite is selected (`/suites`), only the suite
picker is visible.

**Tabs**: [Runs] [Machines] [Commits] [Regressions]. Default tab is Runs.

**URL state**: the suite is a path segment (`/suites/{ts}`); the remaining state
is in query params (`?tab=machines&search=foo&offset=0`). On mount, reads the
path and params to restore state. On changes, updates the URL.

| Tab | Content | API | Search/Filter |
|-----|---------|-----|---------------|
| Runs | Run list with cursor pagination, most recent first | `GET runs?search=...&sort=-submitted_at&limit=25` | Substring match on machine name and searchable machine fields |
| Machines | Searchable machine list with offset pagination | `GET machines?search=...&limit=25&offset=...` | Substring match on machine name and searchable machine fields |
| Commits | Commit list with cursor pagination, most recently seen first | `GET commits?search=...&sort=-first_seen&limit=25` | Substring match on commit, tag and searchable commit fields |
| Regressions | Full regression triage interface (see below) | `GET regressions?state=...&machine=...&metric=...&has_commit=...&search=...&sort=-created_at&limit=25` | State chips, machine combobox, metric selector, "No commit set" checkbox, title search |

## TS2: Runs tab

This tab shows the runs submitted to that test suite, most recent first. It
shows a table like this:

```
Run               Machine                   Commit            Submitted
------------------------------------------------------------------------------------
f1668bea...       macos-26.5-arm64          fcc09b6f0267      2026-08-31, 3:03:36 PM
53e0d192...       linux-x86_64              ef2afa1e83fa      2026-08-31, 3:03:15 PM
etc...
```

- `Run` is a link to the run detail page, showing the shortened UUID.
- `Machine` is a link to the machine detail page.
- `Commit` is a link to the commit detail page.
- `Submitted` is the submission timestamp for that run

Above the table, a search box showing "Filter by machine name...". It allows substring
matching on machine name and searchable machine fields.

## TS3: Machines tab

This tab shows the machines defined in the test suite. It shows a table like this:

```
Name                        Info
----------------------------------------------------------------------------------------------------------------------
linux-x86_64                compiler: clang version 22.1.0, test_suite_commit: 8bb5e216937e6b541f351aa1637c67e85a43ada0
macos-26.5-arm64            compiler: Apple clang version 21.0.0, hardware: Apple M4, os: macOS 26.5 (25F71)
macos-arm64-O3 [untracked]  compiler: Apple clang version 21.0.0, hardware: Apple M4, cflags: -O3
```

The `Name` is a clickable link to the machine detail page. The `Info` column presents the machine
fields that have a value for that machine, separated by commas.

Machines with `tracked: false` carry a small grey `untracked` badge next to the name. All machines
are listed regardless of `tracked`; the badge is informational, marking configurations that are
excluded from the Dashboard's trend overview. Hovering the badge explains that.

Above the table, a `Filter by name...` text box allows filtering the machines using substring
matching on their name and searchable fields.

Below the table, `[<- Previous] 1-2 of 2 [Next ->]` allows navigating through pages.

## TS4: Commits tab

This tab shows the commits present in the test suite, most recently seen first
(see E3), so that the commits that just arrived are on the first page whether or
not they have an ordinal. It shows a table like:

```
Commit            Ordinal                 Tag
----------------------------------------------------
0f985af790f8      591886                  --
0f69d2804b9b      588009                  llvm-22.0
etc...
```

- `Commit` is a link to the commit detail page, showing the display value without its
  ` (tag)` suffix.
- `Ordinal` is the ordinal value for that commit, or `--` if there is no ordinal.
- `Tag` is the tag associated to that commit if any, or `--` if there is no tag.

Above the table, a text filter showing "Search commits..." allows filtering based
on the commit's value and any tags and searchable fields. Substring matching is used.

## TS5: Regressions tab

The Regressions tab embeds the full regression triage UI directly in the Test
Suites page.

**Filters** (control panel above table):
- State: multi-select chips (detected, active, not_to_be_fixed, fixed,
  false_positive) -- toggleable, none selected by default; with none
  selected, every state is shown
- Machine: combobox with typeahead
- Metric: dropdown
- "No commit set": checkbox. When checked, only regressions without a commit
  are shown (`has_commit=false`); when unchecked, regressions are shown whether
  or not they have one.
- Free-text search on title: server-side `search=` (see AR2)

**Actions** (each requires `triage` scope):
- "New Regression" button -> toggles an inline create form with title, bug,
  state and commit fields, the latter a commit picker over every commit of the
  suite. On successful creation, navigates to the new regression's detail page.
- Delete: a per-row button, confirmed as AR2 describes.

Clicking a row navigates to the regression's detail page, except on the commit and
bug links it holds, which lead to their own targets.

The table lists regressions newest first (`sort=-created_at`), so that newly
recorded regressions are on the first page. It looks like this:

```
Title                 State       Commit        Machines      Tests         Created                   Bug
-----------------------------------------------------------------------------------------------------------------------------------------------
find_if slowdown      detected    abc123        2             12            2026-08-31, 3:03:36 PM    https://github.com/llvm/.../issues/1234
etc...
```

Machines and Tests are the `machine_count` and `test_count` the list endpoint returns
for each regression. They count the whole regression even when the table is filtered.
The names are on the regression detail page. Created is the regression's
`created_at`.
