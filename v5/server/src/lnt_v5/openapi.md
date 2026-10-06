LNT is LLVM's performance-monitoring server. Build bots submit benchmark results to it, and it
stores them as time series so that performance changes can be found, investigated and tracked.
This page documents its REST API. For an introduction to the concepts (test suites, machines,
commits, runs, samples, profiles and regressions) and to common workflows, see
[/llms.txt](/llms.txt).

## Authentication

Reading data doesn't require an API key. Everything else does: send the key's token in an
`Authorization: Bearer <token>` header. To try those operations from this page, click
**Authorize** and paste your token. It is saved in your browser until you log out.

Each operation lists the scope it requires, and the `Scope` schema describes what each scope
allows. Scopes are ordered `read` < `submit` < `triage` < `manage` < `admin`, and a key can do
everything its scope and the scopes below it allow. Keys are created with
`POST /api/admin/api-keys`, which requires the `admin` scope; ask the instance's administrator for
your first key.

If you do send a key, it must be valid: a malformed, unknown or revoked key gets a 401, even on
operations that don't need a key. A valid key without the required scope gets a 403.

## Lists and pagination

Lists are never returned as a bare array. The results are always under `items`, in one of three
shapes:

| Kind | Shape |
|------|-------|
| Cursor-paginated | `{"items": [...], "cursor": {"next": "...", "previous": null}}` |
| Offset-paginated | `{"items": [...], "total": 240}` |
| Not paginated | `{"items": [...]}` |

Use `limit` to set the page size. It defaults to 25, and can be at most 10000.

**Cursor pagination.** To get the next page, repeat the same request with `cursor` set to the
`cursor.next` value from the previous response. Keep the same filters and sort; only `limit` may
change. When `cursor.next` is null, there are no more pages. Treat cursors as opaque strings. If a
cursor is rejected (for example because the suite's schema changed in the meantime), start over
from the first page.

Most cursor-paginated operations take `cursor` as a query parameter. The few that take their
filters in a JSON body (`POST .../query` and `POST .../regressions/indicators/query`) expect
`cursor` and `limit` in the body too.

**Offset pagination.** Use `offset` to skip results. `total` is the number of results matching
the filters, across all pages.

## Filtering and sorting

- Filters are query parameters, except on the operations that take a JSON body.
- To give several values for a parameter, repeat it: `?state=active&state=detected`.
- Unknown query parameters are rejected with a 400 rather than ignored, so a typo can't silently
  return the wrong results. So is a parameter given twice when it only takes one value.
- `sort=<name>` sorts in ascending order and `sort=-<name>` in descending order. Each operation
  lists the sort orders it supports, and its default if it has one. If it has none and `sort` is
  left out, results come back in an unspecified but stable order, which is the fastest way to page
  through everything.

## Errors

All errors have the same body:

```json
{"error": {"code": "not_found", "message": "No machine named 'foo' in test suite 'libcxx'"}}
```

Check `code` in your code. `message` is meant for people and may change.

| Code | Status | Meaning |
|------|--------|---------|
| `invalid_request` | 400 | The request is malformed or invalid. |
| `unauthorized` | 401 | The operation needs an API key and none was sent, or the key is malformed, unknown or revoked. |
| `forbidden` | 403 | The API key doesn't have the required scope. |
| `not_found` | 404 | The path doesn't exist, or something the request refers to doesn't exist. |
| `method_not_allowed` | 405 | The path exists, but not with this HTTP method. The `Allow` header lists the methods it supports. |
| `duplicate` | 409 | The thing you are creating already exists. If you chose the UUID of a run or a regression yourself, a previous attempt probably succeeded: don't resend it with a new UUID, or you'll store it twice. |
| `conflict` | 409 | The request contradicts data that is already stored. Sending it again won't help: change the request or the stored data first. |
| `retry` | 409 | The suite's schema changed at the same time, or the suite was too busy for a schema change to start. Nothing was saved: send the same request again. |
| `internal_error` | 500 | Something went wrong on the server. |

A request body that is too large is rejected with a 413, which may not have this body.

## Conventions

- Things are identified by name (test suites, machines, tests), by value (commits), by UUID
  (runs, regressions, indicators and profiles), or by prefix (API keys). Responses refer to
  related things by that identifier, as in `"machine": "linux-x86_64"`, rather than nesting them.
- Timestamps are ISO 8601 strings, returned in UTC with a `Z` suffix. A timestamp sent without a
  time zone is treated as UTC.
- Values of the metrics and fields a suite's schema declares must have the right JSON type: a
  number for `real` and `integer`, a string for `text`, and an ISO 8601 string for `datetime`.
  Types are not converted, so `"5"` is not a valid `integer`.
- A `fields` object in a response always lists every field the schema declares, with `null` for
  those that have no value. In general, every documented key is present in a response, with
  `null` when there is no value.
- In a `PATCH` request, leave out the keys you don't want to change. Set a key to `null` to clear
  it, where that is allowed.
