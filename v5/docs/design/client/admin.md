# v5 Web UI: Admin Page

Page specification for the Admin page.

## Admin -- `/admin`

Not test-suite specific. Served at `/admin` (outside the `{ts}` namespace).
This page provides various tabs with different tools.

| Tab | Shows | API Calls |
|-----|-------|-----------|
| API Keys | List, create, revoke API keys (global to instance) | `GET/POST/DELETE admin/api-keys`, `GET suites` |
| Test Suites | The suites, each leading to its Schema tab; create suites | `GET/POST suites` |

The URL keeps the selected tab as `tab` (`suites` for Test Suites, and nothing for API Keys,
the default), and the sort of the API Keys tab's table as `sort` (see AD1). Switching tabs
clears the setting of the tab left.

### AD1: API Keys tab detail

This tab requires `admin` scope -- listing keys needs `admin` just as creating and
revoking them do. Otherwise, a red banner saying
`Permission denied. Set an API token with the required scope in Settings.` is shown in
place of the tab's content.

While the token is being checked (see AR17), the tab says so, unless it is already showing its
content. It then keeps it until the check settles, so that a check that accepts the token again
loses nothing the tab shows, such as a token shown only once, but disables the actions that need
the token meanwhile, as AR17 gates them. This is an exception to AR17's rule that the SPA behaves as
if no token were set until a check succeeds, whether the check is of a new token or of the same
one again. A check that does not accept a token with `admin` scope replaces the content with the
banner.

A "Create API Key" form has a text input for the key name, a dropdown to select
the scope of the key, starting on `read`, the lowest, a choice of the suites the
key is for, and a "Create key" button to create the new key:

```
Name [ci-bot      ]   Scope [triage v]   Suites
                                         ( ) All suites (instance-wide)
                                         (o) Only these suites: [libcxx, nts v]   [Create key]
```

The suites are chosen with two radio buttons: "All suites (instance-wide)", the
default, and "Only these suites:", which restricts the key to the suites checked
in the dropdown beside it. The dropdown can be used only while "Only these
suites:" is selected. It opens a list of the instance's suites, each with a
checkbox; the list stays open while suites are checked and unchecked, and
scrolls when long. It is not an AR10 list: there is no checkbox selecting them
all. The dropdown's button shows "Select suites" while no suite is checked, and
otherwise names the suites checked, or says how many when there are more than
two. "Create key" is disabled, saying why on hover, while "Only these suites:"
is selected with no suite checked. Only `submit`, `triage` and `manage` keys can
be restricted (see I5): for another scope, "Only these suites:" is disabled,
saying why on hover, and the choice goes back to "All suites (instance-wide)".
While the suites are not loaded, or there are none, only "Only these suites:" is
unavailable.

On creation, a banner shows:

```
  Key created. Copy the token now -- it will not be shown again:
  +---------------------------------------------------------------------------+
  | KEY HERE                                     [copy to clipboard button]   |
  +---------------------------------------------------------------------------+
```

The token stays shown until the user asks for another key, whether or not that succeeds, or the
tab stops showing its content: when the user leaves it, say.

Below the creation widget, a table like this shows the existing API keys:

```
Prefix      Name          Scope       Suites         Created                     Last Used                   Active
--------------------------------------------------------------------------------------------------------------------------------------------
229d78c5    test-key2     read        All            2026-08-13, 3:01:04 AM      Never                       Yes           [red Revoke button]
135f502b    test-key      manage      libcxx, nts    2026-08-11, 1:04:23 PM      2026-08-18, 3:49:26 AM      Yes           [red Revoke button]
3f0ac112    old-bot       submit      All            2026-07-02, 9:12:44 AM      2026-08-01, 6:20:11 PM      No
```

Keys are listed newest first, so a newly created key appears at the top of the
table without a reload. Revoked keys remain in the table with `Active` showing
`No`, since revoking does not delete them, and they carry no Revoke button.
`Suites` shows `All` for an instance-wide key, and otherwise the suites the key
is restricted to. `Last Used` shows `Never` for a key that has not yet
authenticated a request, and is otherwise a best-effort value that may lag
actual use (see D5).

Column headers are click-to-sort, applied client-side over the already-loaded
keys -- the list endpoint is unpaginated, so sorting issues no request. Sorting
by `Last Used` is how to surface the most- and least-recently-active keys; keys
that have never been used sort after every key carrying a timestamp, in both
directions. `Scope` sorts by I5's hierarchy, from `read` to `admin`, rather than
alphabetically. `Suites` sorts `All` first, then by its suite names, compared in
turn. Keys with the same value keep the default order, which is `Created`
descending, also the order the API returns. The URL names the sort column after
its key in the API, prefixed with `-` for descending order
(`sort=-last_used_at`).

Clicking Revoke asks for a plain confirmation (see AR16) before the request is sent. On
success the row's `Active` flips to `No` in place and its Revoke button disappears --
the row is not removed. Revoking the key of the token set in Settings checks the token again at
once, so that the Settings panel, this tab and every control gated on the token show straight
away that it is no longer valid. The confirmation of that revocation warns that the tab will no
longer be available, and that a token shown and not copied yet will be lost.

### AD2: Test Suites tab detail

A "New suite" button opens the schema editor (see TS7) to create a suite. Below the button, the
tab lists the instance's suites by name, each a link to its Schema tab (see TS6), where its
schema is viewed, exported and edited, and the suite deleted. When the instance has no suites,
the tab says so, and "New suite" is still offered.

```
[New suite]

Edit, export or delete a suite from its Schema tab:
  - libcxx
  - nts
```

Creating a suite requires an instance-wide `manage` key (see I5).
