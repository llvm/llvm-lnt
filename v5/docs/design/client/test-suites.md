# v5 Web UI: Test Suites

Page specifications for the Test Suites page (suite picker + tabs), including the Schema tab and
the schema editor.


## TS1: Test Suites -- `/projects`, `/projects/{p}` and `/projects/{p}/suites/{s}`

The primary entry point for browsing test suite data, and for maintaining a
suite's schema (see TS6). The page shows a suite picker, which depends on the
path:

- `/projects` shows the suites of every project, each project under a heading
  with its label, linking to `/projects/{p}` (see AR22). A project without
  suites says that it has none. When there are no projects, the page says so.
- `/projects/{p}` shows the suites of that project alone, under its heading,
  with no suite selected and no tabs. When the project has no suites, it says
  so instead. When `{p}` names no project, the page says that the project was
  not found.
- `/projects/{p}/suites/{s}` shows the suites of project `{p}`, as
  `/projects/{p}` does, with `{s}` selected, plus the tabbed content for that
  suite. When `{p}` names no project, the page says that the project was not
  found, as on `/projects/{p}`. When `{s}` names no suite of the project, the
  page shows the picker and says that the suite was not found.

Except on `/projects` itself, an "All projects" link above the picker leads to
`/projects`. Only a failure to load the list of projects in the first place
takes the place of the page, with a way to try again; when the list is fetched
again and that fails, the page keeps showing what it shows (see AR7).

**Suite picker**: A row of prominent card/button elements, one per test suite,
labelled and ordered as AR22 says. Clicking a card selects it (highlighted) and
shows the tab bar below, navigating to `/projects/{p}/suites/{name}`.

**Tabs**: [Runs] [Machines] [Commits] [Regressions] [Schema]. Default tab is Runs.
Switching tabs clears the search, the filters and the pagination position.

**URL state**: the project and the suite are path segments
(`/projects/{p}/suites/{s}`); the remaining state
is in query params (`?tab=machines&search=foo`). On mount, reads the
path and params to restore state. On changes, updates the URL.

| Tab | Content | API | Search/Filter |
|-----|---------|-----|---------------|
| Runs | Run list with cursor pagination, most recently submitted first | `GET runs?search=...&sort=-submitted_at&limit=25` | Machine, commit or UUID prefix (see O4) |
| Machines | Every machine, by name | `GET machines?search=...` | Substring match on machine name and searchable machine fields |
| Commits | Commit list with cursor pagination, most recently seen first | `GET commits?search=...&sort=-first_seen&limit=25` | Substring match on commit, tag and searchable commit fields |
| Regressions | Full regression triage interface (see below) | `GET regressions?state=...&machine=...&metric=...&has_commit=...&search=...&sort=-created_at&limit=25` | State chips, machine combobox, metric selector, "No commit set" checkbox, title or UUID prefix search |
| Schema | The suite's schema, its export, editing, renaming, moving and deletion (see TS6) | `GET /api/projects` (E13); writes in TS6 and TS7 | -- |

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
- `Commit` is a link to the commit detail page, with its card (see AR21).
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
value for that field as DT1 shows it. A value longer than 50 characters is cut
short, and shown whole on hover and to assistive technology.
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
  ` (tag)` suffix, with its card (see AR21).
- `Ordinal` is the ordinal value for that commit, or `--` if there is no ordinal.
- `Tag` is the tag associated to that commit if any, or `--` if there is no tag.
- After `Tag`, a column for each commit field the schema marks `listed: true`
  (see D4), in schema order, headed by the field's label (see AR6). A cell shows
  the commit's value for that field as DT1 shows a machine's, cut short and
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
3f0ac112...   find_if slowdown      detected    abc123        2             12            2026-08-31, 3:03:36 PM    https://github.com/llvm/llvm-…
9b27d4e0...   (untitled)            active      --            1             3             2026-08-30, 9:12:44 AM    --
etc...
```

UUID is the regression's shortened UUID, linking to its detail page like Title. It is the
only way to tell regressions without a title apart, and it shows the prefix by which the
search can find a regression.

Commit is a link to the page of the regression's commit, showing its display value, with its
card (see AR21), or `--` when the regression has none.

Machines and Tests are the `machine_count` and `test_count` the list endpoint returns
for each regression. They count the whole regression even when the table is filtered.
The names are on the regression detail page. Created is the regression's
`created_at`.

Bug is the regression's bug (see AR6), or `--` when it has none. A bug longer than 30
characters is cut short, and shown whole on hover and to assistive technology.

## TS6: Schema tab

This tab shows the suite's schema, as follows:

```
Suite (subtitle font)

Project         libc++
Name            benchmarks
Display name    Microbenchmarks


Metrics (subtitle font)

Name              Type        Display Name              Unit                    Bigger is Better    Dashboard
-----------------------------------------------------------------------------------------------------------
execution_time    real        Execution Time            seconds (s)             No                  Yes
instructions      real        Instructions Retired      instructions (instr)    No                  Yes
etc...


Commit Fields (subtitle font)

Name              Type        Display Name              Searchable    Display    Listed
-----------------------------------------------------------------------------------------
short_sha         text        Short SHA                 Yes           Yes        No
commit_info       text        --                        No            No         Yes
etc...


Machine Fields (subtitle font)

Name              Type        Display Name              Searchable    Listed
------------------------------------------------------------------------------
hardware          text        Hardware                  Yes           Yes
os                text        --                        Yes           Yes
compiler          text        --                        No            No
etc...


Repository (subtitle font)

Label         GitHub
Commit URL    https://github.com/llvm/llvm-project/commit/{commit}
Range URL     --

[Edit schema] [Rename or move] [Copy as JSON] [Download JSON]           [Delete This Suite]
```

"Suite" shows the label of the suite's project (see AR22), and the suite's name and display
name, `--` when it has none.

Each table shows exactly the presentation keys its list accepts (see D4), so the three
tables deliberately differ in their columns. Entries are shown by their `name`, with their
`display_name` in a column of its own; one that was not set shows `--` rather than
repeating the name, matching what the API returns. `Unit` shows the metric's unit as AR6
writes it, and `--` when it has neither a unit nor an abbreviation.

"Repository" shows each key of the schema's `repository` (see D4), `--` when it is not set.
The URL templates are shown as text, not as links: they are not URLs until filled in.

"Edit schema" opens the schema editor (see TS7) on the suite; once the editor closes, the
focus returns to "Edit schema". "Copy as JSON" and "Download
JSON" export the schema exactly as the API returns it. Another instance can create the same
suite from it unchanged (see D4).

Clicking the red "Delete This Suite" button shows an inline panel warning that deleting a
suite permanently destroys all its machines, runs, commits, samples, and regressions, with
the confirmation prompt AR16 describes. Once the suite is deleted
(`DELETE /api/projects/{project}/suites/{suite}`, see E10), the page leaves for `/projects/{p}`,
without query parameters, in place of itself in the history (see AR16), which shows the suites
left in the project, or says that there is none (see TS1). It does so even if the user has gone
to another of the suite's tabs meanwhile: only a user who has left the suite's page since
confirming stays where they are.

"Rename or move" shows an inline panel below the buttons, with a Project dropdown listing every
project (see AR22), which starts on the suite's own, a Name input, which starts on the suite's
name, and Save and Cancel buttons. As the user types, the name is checked as the schema editor
checks a suite's name (see TS7), against the other suites of the project picked. Saving the same
project and name closes the panel without sending anything. Otherwise, Save first asks for a
plain confirmation (see AR16), which names the suite's old and new full names (see D7) and
warns that every URL, bookmark and bot that uses the old name gets a 404 until it is updated.
For a move, it also says that API keys listing the old project no longer cover the suite, that
those listing the new project do, and that those listing the suite itself still do (see I5); for
a rename within the project, it says that API keys are unaffected. Once confirmed, the change is
sent (`PATCH /api/projects/{project}/suites/{suite}`, see E10). On success, the page goes to the
suite's Schema tab under its new names, in place of itself in the history (see AR16), unless the
user has left the suite's page meanwhile. If it fails, the panel stays open with its contents and
says why.

Anyone can view and export a schema. Editing it, or renaming, moving or deleting the suite, requires
`manage` on the suite, which a key covering it grants (see I5). Moving it to another project also
requires the project to be covered in full, so the panel's Project dropdown disables the other
projects the token does not cover in full (see AR17).


## TS7: Schema editor

The schema editor creates a suite, from the Admin page's Test Suites tab (see AD2), or edits a
suite's schema, from its Schema tab (see TS6). It takes the place of what the tab shows: its
whole content in the Admin page, and the schema viewer, buttons included, in the Schema tab.
"Cancel" closes it and discards its changes, without asking, and the tab shows what it showed
before again. Leaving the tab with unsaved changes asks first (see AR19): when editing a schema,
the changes "Save" would send; when creating a suite, a project picked, a suite name or display
name, any entry, a repository value, or a document to import that is not blank.

```
New suite    Project [libc++ v]    Suite name [________]    Display name [________]    Start from [suite v]    [Import JSON]

Metrics
Name              Type        Display Name        Unit          Abbrev    Bigger is Better    Dashboard
-------------------------------------------------------------------------------------------------------
execution_time    real        [Execution Time]    [seconds]     [s]       [ ]                 [x]         ×
code_size         integer     (removed)                                                            [undo]
[instructions]    [real v]    [              ]    [       ]     [   ]     [ ]                 [ ]         ×
[+ Add metric]

Commit Fields
Name              Type        Display Name        Searchable    Display    Listed
-----------------------------------------------------------------------------------
short_sha         text        [Short SHA     ]    [x]           [x]        [ ]        ×
commit_info       text        [              ]    [ ]           [ ]        [x]        ×
[+ Add commit field]

Machine Fields
...

Repository
Label         [GitHub                                                    ]
Commit URL    [https://github.com/llvm/llvm-project/commit/{commit}      ]
              {commit} is replaced by the commit.
Range URL     [                                                          ]
              {from} and {to} are replaced by the commit the changes start after and the one they end at.

                                                                           [Cancel] [Create]

Display name [LLVM test-suite]                       (the header, when editing a schema)
Editing LLVM/LLVM test-suite                                                 [Cancel] [Save]
```

When creating a suite, the header above the tables holds its project, its name, its display name,
"Start from" and "Import JSON". When editing one, it holds the suite's display name alone. The
editor's buttons are below the tables: "Cancel" and "Create" when creating a suite, and its
heading, "Editing" followed by the suite's full label (see AR22), "Cancel" and "Save" when
editing one, where the viewer has its own buttons. The tables
are the same in both modes.

The editor shows the same entries and keys as the viewer, with an input for each value, and the
same repository keys, with an input for each. Each URL's input says which placeholders it
accepts (see D4). Each table has a button to add an entry, and each entry a button (×) to remove
it. An added entry goes at the end of its list, and entries cannot be reordered. The suite's
display name, the entries' display name, unit and abbreviation, and the repository's keys, are
sent without whitespace at either end, and
an input that is empty, or holds only whitespace, sets its key to `null` (see D2).

`searchable` and `display` are only valid on a `text` entry, and `dashboard` only on a numeric
metric (see D3): each is disabled for the other types, says why on hover, and is cleared when the
entry's type changes to one of them. Checking `display` on one commit field unchecks it on the
others, since at most one can have it.

As the user types a name, the editor checks it against D4's rules for names, including the
names that D5 reserves, and for uniqueness within its list. Likewise, as the user changes a
repository URL, the editor checks it, as it would be sent, against D4's rules for templates. A
name or a URL that fails shows the red halo (see AR11), and says why on hover. "Create" or "Save"
is disabled while any name or URL fails, or any name is empty, and when disabled, says why on
hover. When editing a schema, a URL the user has not changed is not checked, so that a schema
stored with one the editor would refuse can still be saved. The server validates everything else
when the schema is submitted.

**Creating a suite**: The editor starts empty, with a Project dropdown and an extra input for the
suite's name. The Project dropdown lists every project (see AR22), those the token does not cover in
full disabled (see AR17), and starts with none picked. The name is also checked against the names of
the suites of the project picked. A "Start from" dropdown, over every suite (see AR22), replaces the
editor's entries and repository with a copy of an existing suite's. It copies neither the suite's
name nor its display name. Until the projects and their suites have loaded, the Project dropdown and
"Start from" are disabled, and so is "Create", saying why. If they cannot be loaded, the editor says
so and offers to try again (see AR7). "Create" is also disabled, saying why, while no project is
picked.

"Create" creates the suite in the project picked. On success, the page goes to the new suite's
Schema tab (`/projects/{p}/suites/{name}?tab=schema`), unless the user has left the tab
meanwhile. If the name was taken meanwhile, the name check says so once "Create" fails.

"Import JSON" creates a suite from a schema document instead, without going through the editor. It
opens a text area, where the user pastes the document or loads it from a file, and a button that
sends the document unchanged to `POST /api/projects/{project}/suites` for the project picked, which
must be picked first, where the server validates it. They take the place of the suite name, the
display name, "Start from", the tables and "Create" until "Import JSON" is clicked again,
which goes back to the editor as the user left it, and keeps the document. On success, the page
goes to the new suite's Schema tab, as with "Create". On failure, the text area keeps its
contents, and the API's error message is shown.

**Editing a schema**: The editor starts from the suite's schema as fetched when it opens. Only
an existing entry's presentation keys can be edited: its `name` and `type` are read-only, since
D2 allows changing neither. An added entry is editable in full. Removing an existing entry only
marks it as removed, with an undo button, and its name stays taken until the schema is saved:
the reason given for refusing an added entry with that name is that an entry removed in this edit
cannot be added again in the same edit.

"Save" applies every change in one `PATCH /api/projects/{project}/suites/{suite}/schema`. It sends
only the keys the user changed, of the entries and of the repository alike, so that it does not
overwrite changes made by others since the editor opened. When the user changed nothing, "Save"
closes the editor without sending anything. If any entry was removed, "Save" first asks the user to
type the suite name to confirm (see AR16), and the editor's contents cannot change until the user
does, or cancels. The prompt lists the removed entries and warns that every value stored for them
will be permanently destroyed, along with the regression indicators of any removed metric (see D2).
On success, the editor closes and the viewer shows the schema the API returned.

In both modes, if "Create" or "Save" fails, the editor stays open with its contents and shows
the API's error message. If the suite being edited no longer exists, the editor closes, and the
page says that the suite was not found (see TS1).
