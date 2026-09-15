# v5 Web UI: Test Suites

Page specifications for the Test Suites page (suite picker + tabs).


## Test Suites -- `/suites` and `/suites/{ts}`

The primary entry point for browsing test suite data. `/suites` shows the suite
picker alone; `/suites/{ts}` shows the picker with `{ts}` selected, plus the
tabbed content for that suite.

**Suite picker**: A row of prominent card/button elements, one per test suite.
Clicking a card selects it (highlighted) and shows the tab bar below, navigating
to `/suites/{name}`. When no suite is selected (`/suites`), only the suite
picker is visible.

**Tabs**: [Recent Activity] [Machines] [Runs] [Commits] [Regressions]. Default
tab is Recent Activity.

**URL state**: the suite is a path segment (`/suites/{ts}`); the remaining state
is in query params (`?tab=machines&search=foo&offset=0`). On mount, reads the
path and params to restore state. On changes, updates the URL.

| Tab | Content | API | Search/Filter |
|-----|---------|-----|---------------|
| Recent Activity | Last 25 runs sorted by time | `GET runs?sort=-submitted_at&limit=25` | Substring match on machine searchable fields |
| Machines | Searchable machine list with offset pagination | `GET machines?search=...&limit=25&offset=...` | Substring match on machine searchable fields |
| Runs | Run list with cursor pagination | `GET runs?machine=...&sort=-submitted_at&limit=25` | Substring match on machine searchable fields |
| Commits | Commit list with cursor pagination | `GET commits?search=...&limit=25` | Substring match on commit, tag and searchable commit fields |
| Regressions | Full regression triage interface (see below) | `GET regressions?state=...&limit=25` | State chips, machine combobox, metric selector, has_commit checkbox, title search |

## Recent Activity tab

This tab shows the last 25 runs sorted by time. It shows a table like this:

```
Machine             Commit          Submitted                 Run
-------------------------------------------------------------------------------------
macos-26.5-arm64    fcc09b6f0267    2026-08-31, 3:03:36 PM    f1668bea... (truncated)
linux-arm64         f059e5870216    2026-08-31, 3:03:20 PM    0a03c629... (truncated)
etc...
```

The machines, commits and runs are clickable links leading to the detail page for
that object. At the bottom of the page, a "Load more" button that allows loading
the next page. The value in the `Commit` column is the `display` field for that
commit, if any.

## Machine tab

This tab shows the machines defined in the test suite. It shows a table like this:

```
Name                        Info
----------------------------------------------------------------------------------------------------------------------
linux-x86_64                compiler: clang version 22.1.0, test_suite_commit: 8bb5e216937e6b541f351aa1637c67e85a43ada0
macos-26.5-arm64            compiler: Apple clang version 21.0.0, hardware: Apple M4, os: macOS 26.5 (25F71)
macos-arm64-O3 [untracked]  compiler: Apple clang version 21.0.0, hardware: Apple M4, cflags: -O3
```

The `Name` is a clickable link to the machine detail page. The `Info` column presents the machine
fields for that machine separated by commas.

Machines with `tracked: false` carry a small grey `untracked` badge next to the name. All machines
are listed regardless of `tracked`; the badge is informational, marking configurations that are
excluded from the Dashboard's trend overview. Hovering the badge explains that.

Above the table, a `Filter by name...` text box allows filtering the machines using substring
matching on their name and searchable fields.

Below the table, `[<- Previous] 1-2 of 2 [Next ->]` allows navigating through pages.

## Runs tab

This tab shows the runs submitted to that test suite. It shows a table like this:

```
Run               Machine                   Commit            Submitted
------------------------------------------------------------------------------------
f1668bea...       macos-26.5-arm64          fcc09b6f0267      2026-08-31, 3:03:36 PM
53e0d192...       linux-x86_64              ef2afa1e83fa      2026-08-31, 3:03:15 PM
etc...
```

- `Run` is a link to the run detail page. UUID is abbreviated.
- `Machine` is a link to the machine detail page.
- `Commit` is a link to the commit detail page. `display` commit field is used if any.
- `Submitted` is the submission timestamp for that run

Above the table, a search box showing "Filter by machine name...". It allows substring
matching on machine name and searchable machine fields.

Below the table, `[<- Previous] [Next ->]` allows navigating through pages.

## Commits tab

This tab shows the commits present in the test suite. It shows a table like:

```
Commit            Ordinal                 Tag
----------------------------------------------------
0f69d2804b9b      588009                  llvm-22.0
0f985af790f8      591886                  --
etc...
```

- `Commit` is a link to the commit detail page. `display` field is used.
- `Ordinal` is the ordinal value for that commit, or `--` if there is no ordinal.
- `Tag` is the tag associated to that commit if any, or `--` if there is no tag.

Above the table, a text filter showing "Search commits..." allows filtering based
on the commit's value and any tags and searchable fields. Substring matching is used.

Below the table, `[<- Previous] [Next ->]` allows navigating through pages.

## Regressions tab

The Regressions tab embeds the full regression triage UI directly in the Test
Suites page.

**Filters** (control panel above table):
- State: multi-select chips (detected, active, not_to_be_fixed, fixed,
  false_positive) -- toggleable, all deselected by default
- Machine: combobox with typeahead
- Metric: dropdown
- Has commit: checkbox (surfaces regressions with unset commit)
- Free-text search on title (client-side, debounced)

**Actions**:
- "New Regression" button (auth-gated) -> toggles an inline create form with
  title, bug, state, commit fields. On successful creation, navigates to the new
  regression's detail page.
- Row click -> navigates to regression detail page.
- Delete: per-row button with confirmation prompt (auth-gated).

The table displaying regressions is like this:

```
Title                 State       Commit        Machines      Tests         Bug
------------------------------------------------------------------------------------------------------------
find_if slowdown      detected    abc123        2             12            https://github.com/llvm/.../issues/1234
etc...
```

Machines and Tests are the `machine_count` and `test_count` the list item carries
-- counts rather than names, because the list endpoint deliberately does not
return the indicators themselves, and they count the whole regression rather than
whatever the table is filtered by (see the Regressions section of the server's
endpoints spec). The names are on the regression detail page.

The elements are clickable and link to the details page for that entity.
Below the table, `[<- Previous] [Next ->]` allows navigating through pages.
