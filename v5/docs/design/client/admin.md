# v5 Web UI: Admin Page

Page specification for the Admin page.

## Admin -- `/admin`

Not test-suite specific. Served at `/admin` (outside the `{ts}` namespace).
This page provides various tabs with different tools.

| Tab | Shows | API Calls |
|-----|-------|-----------|
| API Keys | List, create, revoke API keys (global to instance) | `GET/POST/DELETE admin/api-keys` |
| Test Suites | Suite selector, schema viewer, delete suite | `GET/DELETE suites` |
| Create Suite | Name input + JSON schema definition text area | `POST suites` |

### API Keys tab detail

This tab requires an API key with `admin` scope set in the navigation bar. Otherwise, a
red banner saying `Permission denied. Set an API token with the required scope in Settings.`
is shown.

Provides a text input titled "Create API Key" with a text input for the key name,
a dropdown to select the scope of the key, and a "Create key" button to create the
new key with the specified name. On creation, a banner shows:

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
135f502b    test-key      manage      2026-08-11, 1:04:23 PM      2026-08-18, 3:49:26 AM      Yes           [red Revoke button]
229d78c5    test-key2     read        2026-08-13, 3:01:04 AM      2026-08-19, 8:25:35 AM      Yes           [red Revoke button]
```

### Test Suites tab detail

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

Name              Type
----------------------
short_sha         text
commit_info       text
etc...


Machine Fields (subtitle font)

Name              Type
----------------------
hardware         text
os               text
compiler         text
etc...
```

This is followed by a red "Delete This Suite" button. Clicking it shows an inline
confirmation panel explaining that deleting a suite permanently destroys all machines,
runs, commits, samples, and regressions, and is irreversible. The user must type the
exact suite name to confirm. On confirmation, calls the API to delete the test suite.
Deleting requires an API key with `manage` scope set in the navigation bar; without
it, the delete fails with a permission error. Viewing schemas requires no key.

### Create Suite tab detail

This tab requires an API key with `manage` scope set in the navigation bar. Otherwise, a
red banner saying `Permission denied. Set an API token with the required scope in Settings.`
is shown.

This tab provides a name input and a JSON text area where the user pastes the full suite
definition (name, metrics, commit fields, machine fields). The JSON format matches what
the test-suite creation API endpoint expects. On success, switches to the "Test Suites"
tab with the new suite auto-selected.
