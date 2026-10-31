# v5 Web UI: Admin Page

Page specification for the Admin page.

## Admin -- `/admin`

Not test-suite specific. Served at `/admin` (outside `/projects`).
This page provides various tabs with different tools.

| Tab | Shows | API Calls |
|-----|-------|-----------|
| API Keys | List, create, revoke API keys (global to instance) | `GET/POST/DELETE admin/api-keys`, `GET projects` |
| Projects | List, create, rename and delete projects, change their display names | `GET/POST projects`, `PATCH/DELETE projects/{project}` |
| Test Suites | Create suites | `GET projects`, `POST projects/{project}/suites` |

The URL keeps the selected tab as `tab` (`projects` for Projects, `suites` for Test Suites, and
nothing for API Keys, the default), and the sort of the API Keys tab's table as `sort` (see AD1).
Switching tabs clears the setting of the tab left.

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
the scope of the key, starting on `read`, the lowest, a choice of what the key
covers, and a "Create key" button to create the new key:

```
Name [ci-bot      ]   Scope [triage v]   Covers
                                         ( ) Everything (instance-wide)
                                         (o) Only these: [libc++ (all), LLVM/nts v]   [Create key]
```

What the key covers is chosen with two radio buttons: "Everything (instance-wide)", the default, and
"Only these:", which restricts the key to what is checked in the dropdown beside it. The dropdown
can be used only while "Only these:" is selected. It opens a tree of checkboxes: every project,
those without suites included, with its suites indented below it, labelled and ordered as AR22 says.
Checking a project restricts the key to the whole project, including the suites it holds later (see
I5): its suites are then shown checked and cannot be unchecked, and unchecking the project unchecks
them. Checking a suite of a project that is not checked restricts the key to that suite alone. The
tree stays open while boxes are checked and unchecked, and scrolls when long. It is not an AR10
list: there is no checkbox selecting everything. The dropdown's button shows "Select projects or
suites" while nothing is checked, and otherwise names what is checked as AR22 shows what a key
covers, or says how many entries there are when there are more than two. "Create key" is disabled,
saying why on hover, while "Only these:" is selected with nothing checked. Only `submit`, `triage`
and `manage` keys can be restricted (see I5): for another scope, "Only these:" is disabled, saying
why on hover, and the choice goes back to "Everything (instance-wide)". While the projects are not
loaded, or there are none, only "Only these:" is unavailable.

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
Prefix      Name          Scope       Covers                     Created                     Last Used                   Active
--------------------------------------------------------------------------------------------------------------------------------------------------------
229d78c5    test-key2     read        All                        2026-08-13, 3:01:04 AM      Never                       Yes           [red Revoke button]
135f502b    test-key      manage      libc++ (all), LLVM/nts     2026-08-11, 1:04:23 PM      2026-08-18, 3:49:26 AM      Yes           [red Revoke button]
7d1e40aa    swift-bot     submit      Nothing                    2026-08-02, 4:40:10 PM      2026-08-09, 1:15:57 AM      Yes           [red Revoke button]
3f0ac112    old-bot       submit      All                        2026-07-02, 9:12:44 AM      2026-08-01, 6:20:11 PM      No
```

Keys are listed newest first, so a newly created key appears at the top of the table without a
reload. Revoked keys remain in the table with `Active` showing `No`, since revoking does not delete
them, and they carry no Revoke button. `Covers` shows what the key covers, as AR22 says. `Nothing`
is muted, and its hover says that what the key listed was deleted, so that it grants only `read`
(see I5). `Last Used` shows `Never` for a key that has not yet authenticated a request, and is
otherwise a best-effort value that may lag actual use (see D5).

Column headers are click-to-sort, applied client-side over the already-loaded
keys -- the list endpoint is unpaginated, so sorting issues no request. Sorting
by `Last Used` is how to surface the most- and least-recently-active keys; keys
that have never been used sort after every key carrying a timestamp, in both
directions. `Scope` sorts by I5's hierarchy, from `read` to `admin`, rather than
alphabetically. `Covers` sorts `All` first, then by the entries it shows,
compared in turn, and `Nothing` last. Keys with the same value keep the default
order, which is `Created` descending, also the order the API returns. The URL
names the sort column after its key in the API, prefixed with `-` for
descending order (`sort=-last_used_at`, `sort=restricted_to`).

Clicking Revoke asks for a plain confirmation (see AR16) before the request is sent. On
success the row's `Active` flips to `No` in place and its Revoke button disappears --
the row is not removed. Revoking the key of the token set in Settings checks the token again at
once, so that the Settings panel, this tab and every control gated on the token show straight
away that it is no longer valid. The confirmation of that revocation warns that the tab will no
longer be available, and that a token shown and not copied yet will be lost.

### AD2: Test Suites tab detail

The tab holds a "New suite" button, which opens the schema editor (see TS7) to create a suite.
An existing suite's schema is viewed, exported and edited, and the suite renamed, moved and
deleted, on its Schema tab (see TS6). Creating a suite requires `manage` covering its project in
full (see I5), so "New suite" needs an instance-wide `manage` token, or one restricted to at least
one whole project.

### AD3: Projects tab detail

The tab lists the projects of the instance (see D7) and manages them:

```
New project    Name [________]    Display name [________]    [Create project]

Name              Display name         Suites
----------------------------------------------------------------------
libcxx  [Edit]    libc++  [Edit]       2         [red Delete button, disabled]
swift   [Edit]    --      [Edit]       0         [red Delete button]
```

The "New project" form has an input for the project's name and one for its display name, and a
"Create project" button, which requires an instance-wide `manage` key (see I5). As the user types a
name, it is checked against D7's rules and the names of the existing projects, as the schema editor
checks a suite's name (see TS7). The display name is sent as the schema editor sends one (see TS7).
"Create project" is disabled, saying why on hover, until the list of projects has loaded, as in
TS7, and while the name is empty or fails its check. On success, the project appears in the table
and the form is emptied. On failure, the form keeps its contents and shows the API's error message.

The table has a row for each project, those without suites included, in AR22's order:

- `Name` is edited in place (see AR12), with the same check as the form's, which renames the
  project. Renaming requires an instance-wide `manage` key. Saving a new name first asks for a
  plain confirmation (see AR16), which names the old and the new name and warns that every URL,
  bookmark and bot that uses the old name for any of the project's suites gets a 404 until it is
  updated, and that API keys are unaffected.
- `Display name` is edited in place (see AR12), and shows `--` when the project has none.
  Emptying it clears the display name. Saving is not confirmed. It requires `manage` covering the
  project in full (see I5).
- `Suites` is the number of the project's suites, linking to them on the Test Suites page
  (`/projects/{p}`, see TS1).
- A red Delete button, which requires an instance-wide `manage` key, is disabled while the
  project has suites, saying why on hover. Clicking it asks for a plain confirmation (see AR16),
  which says that API keys listing the project lose it, and that a key left with nothing grants
  only `read` (see I5). On success, the row is removed.

Only a failure to load the list of projects in the first place takes the place of the table, with
a way to try again; when the list is fetched again and that fails, the table stays as it is (see
AR7).

Anyone can view the tab.
