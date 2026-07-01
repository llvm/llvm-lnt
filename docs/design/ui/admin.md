# v5 Web UI: Admin Page

Page specification for the Admin page.

For the SPA architecture and routing, see [`architecture.md`](architecture.md).


## Admin -- `/v5/admin`

Not test-suite specific. Served at `/v5/admin` (outside the `{ts}` namespace)
with its own Flask route. The SPA shell is served without a testsuite; the
admin page reads the list of available test suites from the HTML
`data-testsuites` attribute.

| Tab | Shows | API Calls |
|-----|-------|-----------|
| API Keys | List, create, revoke API keys (global to instance) | `GET/POST/DELETE admin/api-keys` |
| Test Suites | Suite selector, schema viewer, delete suite | `GET/DELETE test-suites` |
| Create Suite | Name input + JSON schema definition textarea | `POST test-suites` |

**Test Suites tab details**:
- **Suite selector**: Dropdown to switch between test suites. Selecting a suite loads and displays its schema (metrics, commit fields, machine fields, run fields).
- **Delete suite**: A delete button per suite. Clicking it shows an inline confirmation panel explaining that deleting a suite permanently destroys all machines, runs, commits, samples, and regressions, and is irreversible. The user must type the exact suite name to confirm. Calls `DELETE /api/v5/test-suites/{name}?confirm=true`. Requires `manage` scope.

**Create Suite tab**:
- A name input and a JSON textarea where the user pastes the full suite definition (name, metrics, commit_fields, machine_fields). The JSON format matches the `POST /api/v5/test-suites` API. On success, switches to the Schemas tab with the new suite auto-selected. Requires a token with `manage` scope.
