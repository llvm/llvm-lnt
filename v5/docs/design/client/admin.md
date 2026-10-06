# v5 Web UI: Admin Page

Page specification for the Admin page.

## Admin -- `/admin`

Not test-suite specific. Served at `/admin` (outside the `{ts}` namespace).
This page provides various tabs with different tools.

| Tab | Shows | API Calls |
|-----|-------|-----------|
| API Keys | List, create, revoke API keys (global to instance) | `GET/POST/DELETE admin/api-keys` |
| Test Suites | Suite selector, schema viewer, delete suite | `GET/DELETE suites` |
| Create Suite | JSON schema definition text area | `POST suites` |

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

A dropdown to switch between test suites. Selecting a suite loads and displays its schema.
The schema is displayed as follows:

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
```

Each table shows exactly the presentation keys its list accepts (see D4), so the three
tables deliberately differ in their columns. Entries are shown by their `name`, with their
`display_name` in a column of its own; one that was not set shows `--` rather than
repeating the name, matching what the API returns.

This is followed by a red "Delete This Suite" button. Clicking it shows an inline
panel explaining that deleting a suite permanently destroys all machines, runs,
commits, samples, and regressions, and is irreversible, with the confirmation prompt
AR2 describes. On confirmation, calls the API to delete the test suite. Deleting
requires `manage` scope. Viewing schemas requires no key.

### AD3: Create Suite tab detail

This tab requires `manage` scope. Otherwise, a red banner saying
`Permission denied. Set an API token with the required scope in Settings.` is shown in
place of the tab's content.

This tab provides a JSON text area where the user pastes the full suite definition
(name, metrics, commit fields, machine fields), in the format the test-suite creation
API endpoint expects. On success, switches to the "Test Suites" tab with the new suite
auto-selected.
