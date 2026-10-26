# v5 Web UI: Test Suites

Page specifications for the Test Suites page (suite picker + tabs).


## TS1: Test Suites -- `/suites` and `/suites/{ts}`

The primary entry point for browsing test suite data. `/suites/{ts}` shows the
suite picker with `{ts}` selected, plus the tabbed content for that suite.
`/suites` shows the first suite of the picker: once the suites have loaded, the
page goes to `/suites/{first}` with the same query parameters, which takes the
place of `/suites` in the history rather than adding an entry (an exception to
AR2 "State"), so that Back does not return to it. When there are no suites, the
picker says so.

**Suite picker**: A row of prominent card/button elements, one per test suite,
ordered by name. Clicking a card selects it (highlighted) and shows the tab bar
below, navigating to `/suites/{name}`. When `{ts}` names no suite, the page
shows the suite picker and says that the suite was not found.

**Tabs**: [Runs] [Machines] [Commits] [Regressions]. Default tab is Runs.
Switching tabs clears the search, the filters and the pagination position.

**URL state**: the suite is a path segment (`/suites/{ts}`); the remaining state
is in query params (`?tab=machines&search=foo`). On mount, reads the
path and params to restore state. On changes, updates the URL.

| Tab | Content | API | Search/Filter |
|-----|---------|-----|---------------|
| Runs | Run list with cursor pagination, most recently submitted first | `GET runs?search=...&sort=-submitted_at&limit=25` | Machine, commit or UUID prefix (see O4) |
| Machines | Every machine, by name | `GET machines?search=...` | Substring match on machine name and searchable machine fields |
| Commits | Commit list with cursor pagination, most recently seen first | `GET commits?search=...&sort=-first_seen&limit=25` | Substring match on commit, tag and searchable commit fields |
| Regressions | Full regression triage interface (see below) | `GET regressions?state=...&machine=...&metric=...&has_commit=...&search=...&sort=-created_at&limit=25` | State chips, machine combobox, metric selector, "No commit set" checkbox, title or UUID prefix search |

## TS2: Runs tab

This tab shows the runs submitted to that test suite, most recently submitted
first. Unlike the rest of the UI (see AR6), it orders runs by `submitted_at`, so
that the runs that just arrived are on the first page, even those measured long
before. It shows a table like this:

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

Above the table, a search box showing "Search". It finds runs by their machine, their commit
or a prefix of their UUID (see O4).

## TS3: Machines tab

This tab shows every machine defined in the test suite, by name, in a single table like this:

```
Name                        hardware    os                    compiler
------------------------------------------------------------------------------------------------------------
linux-x86_64                --          --                    clang version 22.1.0 (https://github.com/llvm/llv…
macos-26.5-arm64            Apple M4    macOS 26.5 (25F71)    Apple clang version 21.0.0 (clang-2100.1.1.101)
macos-arm64-O3 [untracked]  Apple M4    macOS 26.5 (25F71)    Apple clang version 21.0.0 (clang-2100.1.1.101)
```

The `Name` is a clickable link to the machine detail page. It is followed by a
column for each machine field the schema marks `listed: true` (see D4), in
schema order, headed by the field's label (see AR6). A cell shows the machine's
value for that field, or `--` when it has none. A value longer than 50
characters is cut short, and shown whole on hover and to assistive technology.
Every field, listed or not, is shown on the machine's detail page (see DT1).

Machines with `tracked: false` carry a small grey `untracked` badge next to the name. All machines
are listed regardless of `tracked`, by name; the badge is informational, marking configurations
that are excluded from the Dashboard's trend overview and listed last in machine pickers (see
AR18). Hovering the badge explains that.

Above the table, a `Search machines...` box searches the machines by name and searchable fields
(see O4).

## TS4: Commits tab

This tab shows the commits present in the test suite, most recently seen first
(see E3), so that the commits that just arrived are on the first page whether or
not they have an ordinal. It shows a table like:

```
Commit            Ordinal                 Tag            commit_info
------------------------------------------------------------------------------------------
0f985af790f8      591886                  --             [libc++] Speed up std::to_chars
0f69d2804b9b      588009                  llvm-22.0      --
etc...
```

- `Commit` is a link to the commit detail page, showing the display value without its
  ` (tag)` suffix.
- `Ordinal` is the ordinal value for that commit, or `--` if there is no ordinal.
- `Tag` is the tag associated to that commit if any, or `--` if there is no tag.
- After `Tag`, a column for each commit field the schema marks `listed: true`
  (see D4), in schema order, headed by the field's label (see AR6). A cell shows
  the commit's value for that field, or `--` when it has none, cut short and
  shown whole on hover and to assistive technology when longer than 50
  characters.

Above the table, a `Search commits...` box searches the commits by value, tag and searchable
fields (see O4).

## TS5: Regressions tab

The Regressions tab embeds the full regression triage UI directly in the Test
Suites page.

**Filters** (control panel above table):
- State: multi-select chips (detected, active, not_to_be_fixed, fixed,
  false_positive) -- toggleable, none selected by default; with none
  selected, every state is shown
- Machine: a combobox over the suite's machines (see AR18)
- Metric: dropdown over the suite's metrics, or any metric
- "No commit set": checkbox. When checked, only regressions without a commit
  are shown (`has_commit=false`); when unchecked, regressions are shown whether
  or not they have one.
- Free-text search on the title or a UUID prefix: server-side `search=` (see
  AR9 and O4)

The filters are kept in the URL, as the API names them: `state`, `machine`,
`metric` and `has_commit=false`.

**Actions** (each requires `triage` scope):
- "New Regression" button -> toggles an inline create form with title, bug,
  state and commit fields, the latter a commit picker over every commit of the
  suite. On successful creation, navigates to the new regression's detail page.
- Delete: a per-row button, confirmed as AR16 describes.

Clicking a row navigates to the regression's detail page, except on the commit and
bug links it holds, which lead to their own targets.

The table lists regressions newest first (`sort=-created_at`), so that newly
recorded regressions are on the first page. It looks like this:

```
UUID          Title                 State       Commit        Machines      Tests         Created                   Bug
-----------------------------------------------------------------------------------------------------------------------------------------------------------
3f0ac112...   find_if slowdown      detected    abc123        2             12            2026-08-31, 3:03:36 PM    https://github.com/llvm/.../issues/1234
9b27d4e0...   (untitled)            active      --            1             3             2026-08-30, 9:12:44 AM
etc...
```

UUID is the regression's shortened UUID, linking to its detail page like Title. It is the
only way to tell regressions without a title apart, and it shows the prefix by which the
search can find a regression.

Machines and Tests are the `machine_count` and `test_count` the list endpoint returns
for each regression. They count the whole regression even when the table is filtered.
The names are on the regression detail page. Created is the regression's
`created_at`.
