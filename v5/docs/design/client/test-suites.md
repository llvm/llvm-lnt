# v5 Web UI: Projects page

Page specifications for the Projects page (project and suite chips + a suite's tabs), including
the Schema tab and the schema editor.


## TS1: Projects -- `/projects`, `/projects/{p}` and `/projects/{p}/suites/{s}`

The primary entry point for browsing test suite data, and for maintaining a
suite's schema (see TS6). The page, titled "Projects", shows a row of chips, one
per project, those without suites included, labelled and ordered as AR22 says.
Below it, a row of chips for the suites of the selected project, each by its own
label, in AR22's order. What is selected depends on the path:

- `/projects` goes to `/projects/{p}`, without query parameters, for the first
  project, once the projects have loaded. When there are no projects, the page
  says so.
- `/projects/{p}` goes to `/projects/{p}/suites/{s}`, without query parameters,
  for the first suite of the project `{p}`, once the projects have loaded. When
  the project has no suites, the page stays, selects the project, and says that
  it has none in place of the row of suites.
- `/projects/{p}/suites/{s}` selects the project `{p}` and its suite `{s}`, and
  shows the tabbed content for that suite below the chips.

The page a path goes to takes its place in the history rather than adding an
entry, and so does the one a chip leads to, the project and the suite being
settings of the page (exceptions to AR2 "State").

When `{p}` names no project, on either path, the page shows the row of projects,
none selected, and says that the project was not found. When `{s}` names no
suite of the project, the page shows both rows, no suite selected, and says that
the suite was not found. When the list of projects cannot be loaded, the page
says so in its place, with a way to try again (see AR7).

**Chips**: Each chip is a link (see AR2 "Routing"), and the selected one says to
assistive technology that it is the current one. A suite's chip leads to the tab
shown, in its default state, of that suite: picking another suite keeps the tab,
but clears the search, the filters and the pagination position, as switching tabs
does. Away from a suite's tabs, a suite's chip leads to its default tab. A
project's chip leads where its first suite's chip would, or to `/projects/{p}`
when it has no suites. Clicking the selected chip does nothing, though a modified
click still opens it in a new tab. The chips of both rows are cards, the
selected one standing out from the others.

**Tabs**: [Runs] [Machines] [Commits] [Regressions] [Schema]. Default tab is Runs.
Switching tabs clears the search, the filters and the pagination position.

**URL state**: the project and the suite are path segments
(`/projects/{p}/suites/{s}`); the remaining state
is in query params (`?tab=machines&search=foo`). On mount, reads the
path and params to restore state. On changes, updates the URL.

| Tab | Content | API | Search/Filter |
|-----|---------|-----|---------------|
| Runs | Run list with cursor pagination, most recently submitted first | `GET runs?search=...&sort=-submitted_at&limit=25` | Machine, commit or UUID prefix (see O4) |
| Machines | Every machine, by label (see AR23) | `GET machines?search=...` | Substring match on machine name, display name and searchable machine fields |
| Commits | Commit list with cursor pagination, most recently seen first | `GET commits?search=...&sort=-first_seen&limit=25` | Substring match on commit, tag and searchable commit fields |
| Regressions | Full regression triage interface (see below) | `GET regressions?state=...&machine=...&metric=...&has_commit=...&search=...&sort=-created_at&limit=25` | State chips, machine combobox, metric selector, "No commit set" checkbox, title or UUID prefix search |
| Schema | The suite's schema, its export, editing, renaming, moving and deletion (see TS6 and TS7) | `GET /api/projects` (E13); writes in TS6 and TS7 | -- |

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

This tab shows every machine defined in the test suite, by label (see AR23), in a single table
like this:

```
Machine                                hardware    os                    compiler
-----------------------------------------------------------------------------------------------------------------------
linux-x86_64                           --          --                    clang version 22.1.0 (https://github.com/llvm…
macOS / M4  macos-26.5-arm64           Apple M4    macOS 26.5 (25F71)    Apple clang version 21.0.0 (clang-2100.1.1.101)
macos-arm64-O3 [untracked]             Apple M4    macOS 26.5 (25F71)    Apple clang version 21.0.0 (clang-2100.1.1.101)
```

The `Machine` column shows the machine's label, a clickable link to the machine detail page,
followed by its name in muted text when it has a display name (see AR23). It is followed by a
column for each machine field the schema marks `listed: true` (see D4), in
schema order, headed by the field's label (see AR6). A cell shows the machine's
value for that field as DT1 shows it. A value longer than 50 characters is cut
short, and shown whole on hover and to assistive technology.
Every field, listed or not, is shown on the machine's detail page (see DT1).

Machines with `tracked: false` carry a small grey `untracked` badge next to the name. All machines
are listed regardless of `tracked`, by label; the badge is informational, marking configurations
that are excluded from the Dashboard's trend overview and listed last in machine pickers (see
AR18). Hovering the badge explains that.

Above the table, a `Search machines...` box searches the machines by name, display name and
searchable fields (see O4).

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

The Regressions tab embeds the full regression triage UI directly in the Projects
page.

**Filters** (control panel above table):
- State: multi-select chips (detected, confirmed, not_to_be_fixed, fixed,
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
9b27d4e0...   (untitled)            confirmed   --            1             3             2026-08-30, 9:12:44 AM    --
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

[Edit schema] [Copy as JSON] [Download JSON]                            [Delete This Suite]
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

"Edit schema" opens the schema editor (see TS7) on the suite, which also renames and moves it;
once the editor closes, or has taken the page to the suite's new names, the focus returns to "Edit
schema". "Copy as JSON" and "Download
JSON" export the schema exactly as the API returns it. Another instance can create the same
suite from it unchanged (see D4).

Clicking the red "Delete This Suite" button shows an inline panel warning that deleting a
suite permanently destroys all its machines, runs, commits, samples, and regressions, with
the confirmation prompt AR16 describes. Once the suite is deleted
(`DELETE /api/projects/{project}/suites/{suite}`, see E10), the page leaves for `/projects/{p}`,
without query parameters, in place of itself in the history (see AR16), which goes to the first
suite left in the project, or says that there is none (see TS1). It does so even if the user has gone
to another of the suite's tabs meanwhile: only a user who has left the suite's page since
confirming stays where they are.

Anyone can view and export a schema. Editing it, which includes renaming and moving the suite
(TS7), or deleting the suite, requires `manage` on the suite, and for a move the destination
project in full (see I5).


## TS7: Schema editor

The schema editor creates a suite in a project, from the project's row in the Admin page's
Projects tab (see AD3), or edits a suite's schema, and renames or moves the suite, from its Schema
tab (see TS6). It takes the place of what the tab shows: its whole content in the Admin page, and
the schema viewer, buttons included, in the Schema tab. "Cancel" closes it and discards its
changes, without asking, and the tab shows what it showed before again. Leaving the tab with
unsaved changes asks first (see AR19): when editing a schema, the changes "Save" would send, a new
name or project included; when creating a suite, a suite name or display name, any entry, a
repository value, or a document to import that is not blank.

```
Start from [suite v]    [Import JSON]                      (when creating a suite)

Suite
Project         libc++                                     (when creating a suite)
Project         [libc++ v]                                 (when editing a schema)
Name            [benchmarks      ]
Display name    [Microbenchmarks ]

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
              {commit} is replaced by the commit, and {commit.<field>} by its value for a text field.
Range URL     [                                                          ]
              {from} and {to} are replaced by the commit the changes start after and the one they end at,
              {from.<field>} and {to.<field>} by their values for a text field.

New suite in libc++                                                          [Cancel] [Create]
Editing libc++ › Microbenchmarks                                             [Cancel] [Save]
```

"Suite" is laid out as the viewer's (see TS6). Its project is shown by its label (see AR22) when
creating a suite, and is a dropdown when editing one (see below). The heading below the tables,
where the viewer has its own buttons, is "New suite in" followed by the project's label when
creating a suite, and "Editing" followed by the suite's full label (see AR22) when editing one.

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
names that D5 reserves, and for uniqueness within its list: for the suite's name, among the other
suites of its project, the one picked when editing a schema. Likewise, as the user changes a
repository URL or the commit fields, the editor checks the URL, as it would be sent, against D4's
rules for templates, with the commit fields as they would be sent. A name or a URL that fails shows
the red halo (see AR11), and says why on hover. "Create" or "Save" is disabled while any name or
URL fails, or any name is empty, and when disabled, says why on hover. When editing a schema, a URL
the user has not changed is not checked against D4's rules, except that the fields it names must be
text commit fields of the schema being edited, so that a schema stored with one the editor would
refuse can still be saved. The server validates everything else when the schema is submitted.

**Creating a suite**: The editor starts empty. A "Start from" dropdown, over every suite
(see AR22), replaces the editor's entries and repository with a copy of an existing suite's. It
copies neither the suite's name nor its display name. Creating the suite, with "Create" or with the
button sending a document to import, requires `manage` covering the project in full (see I5 and
AR17). Both buttons are disabled, saying why on hover, while the project is no longer listed, as
when it has been deleted or renamed elsewhere. The editor keeps its contents meanwhile, and names
the project by its name.

"Create" creates the suite in the project. On success, the page goes to the new suite's
Schema tab (`/projects/{p}/suites/{name}?tab=schema`), unless the user has left the tab
meanwhile. If the name was taken meanwhile, the name check says so once "Create" fails.

"Import JSON" creates a suite from a schema document instead, without going through the editor. It
opens a text area, where the user pastes the document or loads it from a file, and a button that
sends the document unchanged to `POST /api/projects/{project}/suites` for the project, where the
server validates it. They take the place of "Start from", "Suite", the tables and "Create" until
"Import JSON" is clicked again, which goes back to the editor as the user left it, and keeps the
document. On success, the page
goes to the new suite's Schema tab, as with "Create". On failure, the text area keeps its
contents, and the API's error message is shown.

**Editing a schema**: The editor starts from the suite's schema as fetched when it opens. Its
Project dropdown lists every project (see AR22), and starts on the suite's own; picking another
moves the suite there, which needs the destination covered in full (see I5): the projects the token
does not cover in full, other than the suite's own, are disabled as AR17 says. Only
an existing entry's presentation keys can be edited: its `name` and `type` are read-only, since
D2 allows changing neither. An added entry is editable in full. Removing an existing entry only
marks it as removed, with an undo button, and its name stays taken until the schema is saved:
the reason given for refusing an added entry with that name is that an entry removed in this edit
cannot be added again in the same edit.

"Save" first applies every change to the schema in one
`PATCH /api/projects/{project}/suites/{suite}/schema`, under the suite's current names, then, once
that succeeds, renames or moves the suite (`PATCH /api/projects/{project}/suites/{suite}`, see
E10), each only if there is one. The schema change sends only the keys the user changed, of the
entries and of the repository alike, so that it does not overwrite changes made by others since the
editor opened. When the user changed nothing, "Save" closes the editor without sending anything.

A save that neither removes an entry nor renames or moves the suite asks nothing. Otherwise, "Save"
first asks for one confirmation (see AR16) covering all that the save does, and the editor's
contents cannot change until the user confirms or cancels. For a rename or a move, the prompt names
the suite's old and new full names (see D7), warns that every URL, bookmark and bot that uses the old
name gets a 404 until it is updated, and says how the change affects API keys (see I5). For removed
entries, it lists them, warns that every value stored for them will be permanently destroyed, along
with the regression indicators of any removed metric (see D2), and asks the user to type the suite's
current name to confirm; otherwise the confirmation is a plain one.

On success, the editor closes and the viewer shows the schema the API returned, or, after a rename
or a move, the page goes to the suite's Schema tab under its new names (see AR16).

In both modes, if "Create" or "Save" fails, the editor stays open with its contents and shows
the API's error message, in the prompt when one is open. A rename or a move that fails closes the
prompt instead, the focus going to "Save"; if the schema change was stored, the editor then starts
from the schema as stored, so that saving again only renames or moves the suite. If the
suite being edited no longer exists, the editor closes, and the page says that the suite was not
found (see TS1).
