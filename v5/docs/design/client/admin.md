# v5 Web UI: Admin Page

Page specification for the Admin page.

## Admin -- `/admin`

Not test-suite specific. Served at `/admin` (outside the `{ts}` namespace).
This page provides various tabs with different tools.

| Tab | Shows | API Calls |
|-----|-------|-----------|
| API Keys | List, create, revoke API keys (global to instance) | `GET/POST/DELETE admin/api-keys` |
| Test Suites | Suite selector, schema viewer and editor, create and delete suites | `GET/POST/DELETE suites`, `PATCH suites/{name}/schema` |

### AD1: API Keys tab detail

This tab requires `admin` scope -- listing keys needs `admin` just as creating and
revoking them do. Otherwise, a red banner saying
`Permission denied. Set an API token with the required scope in Settings.` is shown in
place of the tab's content.

A "Create API Key" form has a text input for the key name, a dropdown to select the
scope of the key, and a "Create key" button to create the new key. On creation, a
banner shows:

```
  Key created. Copy the token now -- it will not be shown again:
  +---------------------------------------------------------------------------+
  | KEY HERE                                     [copy to clipboard button]   |
  +---------------------------------------------------------------------------+
```

Below the creation widget, a table like this shows the existing API keys:

```
Prefix      Name          Scope       Created                     Last Used                   Active
-------------------------------------------------------------------------------------------------------------------------------
229d78c5    test-key2     read        2026-08-13, 3:01:04 AM      Never                       Yes           [red Revoke button]
135f502b    test-key      manage      2026-08-11, 1:04:23 PM      2026-08-18, 3:49:26 AM      Yes           [red Revoke button]
3f0ac112    old-bot       submit      2026-07-02, 9:12:44 AM      2026-08-01, 6:20:11 PM      No
```

Keys are listed newest first, so a newly created key appears at the top of the table
without a reload. Revoked keys remain in the table with `Active` showing
`No`, since revoking does not delete them, and they carry no Revoke button. `Last Used`
shows `Never` for a key that has not yet authenticated a request, and is otherwise a
best-effort value that may lag actual use (see D5).

Column headers are click-to-sort, applied client-side over the already-loaded keys -- the
list endpoint is unpaginated, so sorting issues no request. Sorting by `Last Used` is how
to surface the most- and least-recently-active keys; keys that have never been used sort
after every key carrying a timestamp, in both directions. The default order is
`Created` descending, which is also the order the API returns.

Clicking Revoke asks for a plain confirmation (see AR2) before the request is sent. On
success the row's `Active` flips to `No` in place and its Revoke button disappears --
the row is not removed.

### AD2: Test Suites tab detail

A dropdown switches between test suites, and a "New suite" button opens the schema editor
(see AD3) to create one. Selecting a suite loads and displays its schema. The schema is
displayed as follows:

```
Metrics (subtitle font)

Name              Type        Display Name              Unit                    Bigger is Better
------------------------------------------------------------------------------------------------
execution_time    real        Execution Time            seconds (s)             No
instructions      real        Instructions Retired      instructions (instr)    No
etc...


Commit Fields (subtitle font)

Name              Type        Display Name              Searchable    Display
------------------------------------------------------------------------------
short_sha         text        Short SHA                 Yes           Yes
commit_info       text        --                        No            No
etc...


Machine Fields (subtitle font)

Name              Type        Display Name              Searchable
------------------------------------------------------------------
hardware          text        Hardware                  Yes
os                text        --                        Yes
compiler          text        --                        No
etc...

[Edit schema] [Copy as JSON] [Download JSON]                            [Delete This Suite]
```

Each table shows exactly the presentation keys its list accepts (see D4), so the three
tables deliberately differ in their columns. Entries are shown by their `name`, with their
`display_name` in a column of its own; one that was not set shows `--` rather than
repeating the name, matching what the API returns.

"Edit schema" opens the schema editor on the selected suite. "Copy as JSON" and "Download
JSON" export the schema exactly as the API returns it. Another instance can create the same
suite from it unchanged (see D4).

Clicking the red "Delete This Suite" button shows an inline panel warning that deleting a
suite permanently destroys all its machines, runs, commits, samples, and regressions, with
the confirmation prompt AR2 describes. On confirmation, the suite is deleted.

Anyone can view and export a schema. Creating, editing and deleting a suite require `manage`
scope.

### AD3: Schema editor

The schema editor takes the place of the schema viewer in the Test Suites tab, to create a
suite or to edit the selected suite's schema. While it is open, the suite dropdown and the
viewer's buttons are disabled. "Cancel" closes it and discards its changes. Leaving the tab or
the page does the same, without asking.

```
New suite    Name [__________]    Start from [suite v]    [Import JSON]       [Cancel] [Create]

Editing nts                                                                   [Cancel] [Save]

Metrics
Name              Type        Display Name        Unit          Abbrev    Bigger is Better
-------------------------------------------------------------------------------------------
execution_time    real        [Execution Time]    [seconds]     [s]       [ ]             ×
code_size         integer     (removed)                                                [undo]
[instructions]    [real v]    [              ]    [       ]     [   ]     [ ]             ×
[+ Add metric]

Commit Fields
Name              Type        Display Name        Searchable    Display
-------------------------------------------------------------------------
short_sha         text        [Short SHA     ]    [x]           [x]             ×
commit_info       text        [              ]    [ ]           [ ]             ×
[+ Add commit field]

Machine Fields
...
```

The first header is shown when creating a suite, and the second when editing one. The tables
are the same in both modes.

The editor shows the same entries and keys as the viewer, with an input for each value. Each
table has a button to add an entry, and each entry a button (×) to remove it. An added entry
goes at the end of its list, and entries cannot be reordered. Emptying the display name, unit
or abbreviation input sets it to `null` (see D2).

`searchable` and `display` are only valid on a `text` entry (see D3): they are disabled for
other types, and changing an entry's type away from `text` clears them. Checking `display` on
one commit field unchecks it on the others, since at most one can have it.

As the user types a name, the editor checks it against D4's rules for names, and for
uniqueness within its list. A name that fails shows the red halo (see AR2), and "Create" or
"Save" is disabled while any name fails or is empty. The server validates everything else when
the schema is submitted.

**Creating a suite**: The editor starts empty, with an extra input for the suite's name, which
is also checked against the names of the existing suites. Two shortcuts fill the editor in,
replacing its contents:

- A "Start from" dropdown copies the schema of an existing suite, leaving the name empty.
- "Import JSON" takes a schema in the format `POST /api/suites` accepts, pasted or read from a
  file, including its name. If the editor cannot show the document as it is, it shows an error
  and keeps its contents. This is the case for a document that is not JSON in that format, or
  that has a key its list does not accept, a `type` outside D3's, or `searchable` or `display`
  on an entry that is not `text`.

"Create" creates the suite. On success, the editor closes and the dropdown selects the new
suite.

**Editing a schema**: The editor starts from the suite's schema as fetched when it opens. Only
an existing entry's presentation keys can be edited: its `name` and `type` are read-only, since
D2 allows changing neither. An added entry is editable in full. Removing an existing entry only
marks it as removed, with an undo button, and its name stays taken until the schema is saved.

"Save" applies every change in one `PATCH /api/suites/{name}/schema`. It sends only the keys
the user changed, so that it does not overwrite changes made by others since the editor opened.
If any entry was removed, "Save" first asks the user to type the suite name to confirm (see AR2).
The prompt lists the removed entries and warns that every value stored for them will be
permanently destroyed, along with the regression indicators of any removed metric (see D2). On
success, the editor closes and the viewer shows the schema the API returned.

In both modes, if the request fails, the editor stays open with its contents and shows the
API's error message.
