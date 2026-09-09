# v5 REST API: Endpoints

This document specifies all entity endpoints in the v5 REST API.


## Discovery

```
GET    /api/                      -- API index: links to the suite list and API documentation
```

Response is a `links` object with `suites` (path to the test suite list),
`openapi` (path to the OpenAPI JSON spec) and `swagger_ui` (path to the
interactive API documentation viewer). The index does not enumerate suites
itself -- `GET /api/suites` is the canonical suite list.

Auth: none. Always public, regardless of server configuration.


## Machines

```
GET    /api/suites/{testsuite}/machines                     -- List (searchable, simple pagination)
POST   /api/suites/{testsuite}/machines                     -- Create machine independently
GET    /api/suites/{testsuite}/machines/{machine_name}      -- Detail
PATCH  /api/suites/{testsuite}/machines/{machine_name}      -- Update fields/tracked (including rename)
DELETE /api/suites/{testsuite}/machines/{machine_name}      -- Delete machine and its runs
GET    /api/suites/{testsuite}/machines/{machine_name}/runs -- List runs for this machine (cursor-paginated)
```

Machines are also created implicitly if a run is submitted for a nonexistent machine
(see D7).

**Machine object**: `POST` and `PATCH` take the same entity object that a run
submission nests under `machine` (see D6): `name` (identity), `tracked`
(built-in attribute), and `fields` (declared `machine_fields`). Responses use
the same shape. On `PATCH`, supplying `name` renames the machine, and omitting
any key leaves it unchanged.

Auth scopes: `read` for GET, `manage` for POST/PATCH/DELETE.

Filters: `search=` (case-insensitive substring match on `name` or any
searchable machine_field; see D9), `tracked=` (boolean; omitting it returns
both tracked and untracked machines).

**`tracked`** (boolean, see D5) appears in machine list and detail responses.
`POST` accepts it at creation and `PATCH` can flip it at any time; it defaults
to `true` when omitted. Run submission may also set it at creation time (see D6).
Untracked machines are excluded only from *automatic* machine selection and are
otherwise returned by every endpoint like any other machine.

`GET /api/suites/{testsuite}/machines/{machine_name}/runs` filters: `after=`/`before=`
(submitted_at; exclusive), same convention as `GET /api/suites/{testsuite}/runs`.
Sort: `sort=-submitted_at` returns newest-first; omitting `sort` returns
results in an arbitrary but deterministic order suitable for pagination (see
R2).


## Commits

```
GET    /api/suites/{testsuite}/commits                      -- List (cursor-paginated, searchable)
POST   /api/suites/{testsuite}/commits                      -- Create with metadata (fields) and, optionally, an ordinal
GET    /api/suites/{testsuite}/commits/{value}              -- Detail (includes previous/next commit by ordinal)
PATCH  /api/suites/{testsuite}/commits/{value}              -- Update ordinal, tag, and/or fields
DELETE /api/suites/{testsuite}/commits/{value}              -- Delete commit (cascades to runs/samples; 409 if referenced by regressions)
POST   /api/suites/{testsuite}/commits/resolve              -- Batch resolve commit strings to summaries
```

The `{value}` in the path is the commit identity string. Commits are also
created implicitly during run submission, which may set an `ordinal` inline
(see D6). `ordinal` may also be set at creation via
`POST /api/suites/{testsuite}/commits`,
or at any time via `PATCH /api/suites/{testsuite}/commits/{value}` (see D11). `tag`
is set exclusively via `PATCH /api/suites/{testsuite}/commits/{value}`, never at
creation. On `PATCH`, sending `ordinal: null` or `tag: null` explicitly clears
a previously-set value; omitting the field instead leaves it unchanged.

**Commit object**: `POST` and `PATCH` take the same entity object that a run
submission nests under `commit` (see D6): `value` (identity), `ordinal` and
`tag` (built-in attributes), and `fields` (declared `commit_fields`). Responses
use the same shape. `value` is immutable -- commits cannot be renamed. Keys in
`fields` must be declared in the suite's schema; an undeclared key is rejected
with 400 (see D7).

Auth scopes: `read` for GET (including `/commits/resolve`), `submit` for
`POST /commits`, `manage` for PATCH/DELETE.

Filters: `search=` (case-insensitive substring match on commit string, tag, and
searchable commit fields; see D9), `machine=` (only commits with at least one
run on this machine; 404 if machine not found), `has_profiles=` (boolean;
`true` returns only commits where at least one run has profile data, `false`
returns only commits where no run has profile data; when combined with
`machine=`, only considers runs on that machine). Sort: `sort=ordinal` sorts
by ordinal ascending (oldest first) and `sort=-ordinal` sorts by ordinal
descending (newest first); both exclude commits with NULL ordinals. Default
sort is by internal ID ascending, which reflects the order in which commits
were first seen by the server, not their ordinal order.

### Batch Resolve

`POST /api/suites/{testsuite}/commits/resolve` accepts a JSON body
`{"commits": ["abc", "def", ...]}` (at least one commit string) and returns
each found commit's summary in a dict keyed by commit string:

```json
{
  "results": {
    "abc": {"value": "abc", "ordinal": 42, "tag": null, "fields": {"git_sha": "..."}},
    "def": {"value": "def", "ordinal": null, "tag": null, "fields": {}}
  },
  "not_found": ["unknown"]
}
```

Each value in `results` has the same shape as `CommitSummarySchema`
(`{value, ordinal, tag, fields}`). Commit strings not found in the database
are returned in a separate `not_found` list. Duplicates in the request
are deduplicated; each commit appears at most once in the response.

Auth scope: `read`. Not paginated (response is bounded by request size).


## Runs

```
GET    /api/suites/{testsuite}/runs                         -- List (cursor-paginated, searchable, filterable by machine=, commit=, after=, before=, has_profiles=; sortable by sort=)
POST   /api/suites/{testsuite}/runs                         -- Submit run (accepts optional client UUID or generates one, returns it)
GET    /api/suites/{testsuite}/runs/{uuid}                  -- Detail
DELETE /api/suites/{testsuite}/runs/{uuid}                  -- Delete run
```

The UUID is either provided by the client in the submission body or generated
server-side (UUID v4) when omitted. Client-provided UUIDs must be in standard
`8-4-4-4-12` hyphenated hex format and are normalized to lowercase. If a run
with the same UUID already exists, the server returns 409 Conflict. The
submission endpoint requires JSON format with `format_version '5'`. Legacy
formats (v0, v1, v2) and non-JSON payloads are rejected. There is no
`on_existing_run` parameter -- v5 always creates a new run (multiple runs per
machine+commit are allowed). Deleting a run cascades to its samples and
profiles.

`has_profiles=` (boolean): `true` returns only runs that have at least one
profile attached; `false` returns only runs without profiles.

`search=` (case-insensitive substring match against the run's machine `name`
or any searchable machine_field; see D9) -- the same predicate as
`GET /api/suites/{testsuite}/machines?search=`, applied through the run's machine.

`sort=-submitted_at` returns newest-first; omitting `sort` returns results in
an arbitrary but deterministic order suitable for pagination (see R2).

If the submitted run's machine already exists with `machine.fields` values that
differ from what's submitted, the submission is rejected. Only keys present in
the submission are compared, and the built-in `tracked` attribute is excluded
from the comparison (see D7). Keys in `machine.fields` that are not declared as
`machine_fields` are rejected with 400 rather than stored.

If the submission supplies `commit.ordinal`, it is rejected with 409 when the
commit already has a different ordinal, or when that ordinal is already held by
a different commit (see D11).

Auth scopes: `read` for GET, `submit` for POST, `manage` for DELETE.


## Tests

```
GET    /api/suites/{testsuite}/tests                        -- List (cursor-paginated, filterable)
```

Read-only. Tests are created implicitly via run submission.

Auth scope: `read`.

Filters: `search=` (case-insensitive substring match on test name; see D9), `machine=` (only tests with data
for this machine), `metric=` (only tests with non-NULL values for this metric).


## Samples

Samples are always accessed through their parent run -- they have no external
identifier of their own.

```
GET    /api/suites/{testsuite}/runs/{uuid}/samples                        -- All samples for a run (cursor-paginated)
GET    /api/suites/{testsuite}/runs/{uuid}/tests/{test_name}/samples      -- Samples for a specific test in a run
```

Read-only. Samples are created as part of run submission.

Auth scope: `read`.


## Profiles

Profiles store hardware performance counter data at the instruction level.
Each profile is identified by a server-generated UUID. The UUID-based approach
enables stable bookmarkable identifiers for profile data endpoints, while the
listing endpoint provides the bridge from human-readable run+test coordinates
to UUIDs.

### Listing (per run)

```
GET  /api/suites/{testsuite}/runs/{uuid}/profiles              -- List profiles for a run
```

Returns an array of `{test, uuid}` objects for all profiles attached to
the given run. No pagination (bounded by tests-per-run).

Auth scope: `read`.

### Profile Data (by UUID)

```
GET  /api/suites/{testsuite}/profiles/{uuid}                       -- Metadata + top-level counters
GET  /api/suites/{testsuite}/profiles/{uuid}/functions             -- Function list with counters
GET  /api/suites/{testsuite}/profiles/{uuid}/functions/{fn_name}   -- Disassembly + per-instruction counters
```

Auth scope: `read` for all three endpoints.

**Metadata response** (`GET /api/suites/{testsuite}/profiles/{uuid}`):
- `uuid`, `test` (test name), `run_uuid`, `counters` (dict of counter
  name -> integer value; raw top-level counts), `disassembly_format` (string)

**Functions response** (`GET /api/suites/{testsuite}/profiles/{uuid}/functions`):
- `functions`: array of `{name, counters, length}` where `counters` is
  a dict of counter name -> float (the raw aggregated counter value for the
  function), `length` is instruction count. Sorted by total counter value
  descending (hottest first).

**Function detail response** (`GET /api/suites/{testsuite}/profiles/{uuid}/functions/{fn_name}`):
- `name`, `counters` (function-level aggregate, same raw float convention as
  the functions response above), `disassembly_format`,
  `instructions`: array of `{address, counters, text}` per instruction, where
  `counters` is again a dict of counter name -> raw float value (same
  convention, not a percentage).
  Function names may contain special characters (e.g. C++ mangled names) and
  must be percent-encoded when used as a path segment, per standard URL
  encoding rules.

**Error handling**: If the stored profile blob is corrupt and cannot be
deserialized, the profile data endpoints return 500 with a descriptive
error message.

Profiles are submitted as base64-encoded data within the run submission
payload (see D6). No separate upload endpoint.


## Regressions

```
GET    /api/suites/{testsuite}/regressions                              -- List (cursor-paginated, searchable, filterable by state=, machine=, test=, metric=, commit=, has_commit=)
POST   /api/suites/{testsuite}/regressions                              -- Create (accepts title, bug, notes, state, commit, indicators)
GET    /api/suites/{testsuite}/regressions/{uuid}                       -- Detail (indicators embedded)
PATCH  /api/suites/{testsuite}/regressions/{uuid}                       -- Update title, bug, notes, state, commit
DELETE /api/suites/{testsuite}/regressions/{uuid}                       -- Delete (cascades indicators)
POST   /api/suites/{testsuite}/regressions/{uuid}/indicators            -- Add indicator(s) (batch)
DELETE /api/suites/{testsuite}/regressions/{uuid}/indicators            -- Remove indicator(s) (batch, UUIDs in body)
```

Auth scopes: `read` for GET, `triage` for POST/PATCH/DELETE and indicator management.

Regressions are identified by server-generated UUID.

`search=` (case-insensitive substring match on `title`; see D9).

**Regression states** (string enum):
`detected`, `active`, `not_to_be_fixed`, `fixed`, `false_positive`

State transitions are unconstrained -- any state can be set to any other
state via PATCH.

**Create request body:**
- `title` (string, optional -- auto-generated if omitted)
- `bug` (string, optional -- URL to external bug tracker)
- `notes` (string, optional -- investigation findings, A/B results, etc.)
- `state` (string, optional -- default: `detected`)
- `commit` (string, optional -- suspected introduction commit, resolved by
  value; 404 if no commit with that value exists)
- `indicators` (array, optional -- list of `{machine, test, metric}` objects,
  all resolved by name; 404 if any referenced machine or test does not
  exist, 400 if `metric` is not a valid metric name for the suite)

**Detail response** (`GET /api/suites/{testsuite}/regressions/{uuid}`):
- `uuid`, `title`, `bug`, `notes`, `state`
- `commit` (commit identity string, or null)
- `indicators`: list of `{uuid, machine, test, metric}`

**List response items** include: `uuid`, `title`, `bug`, `state`, `commit`,
`machine_count`, `test_count`. The `notes` field is included in detail
responses only, not in list.

**Indicator add request** (`POST /api/suites/{testsuite}/regressions/{uuid}/indicators`):
- Body: `{"indicators": [{machine, test, metric}, ...]}`. Each object is one
  indicator, resolved the same way as `indicators` on create (404 if the
  machine or test does not exist, 400 for an invalid metric name).
  Duplicates (same regression+machine+test+metric) are silently ignored.

**Indicator remove request** (`DELETE /api/suites/{testsuite}/regressions/{uuid}/indicators`):
- Body: `{"indicator_uuids": ["...", "..."]}`


## Time Series

### Query

```
POST   /api/suites/{testsuite}/query
```

Body (JSON): `{metric, machine, test, commit, after_commit, before_commit,
              after_time, before_time, sort, limit, cursor}`

The `metric` field is required; all other fields are optional. The `test`
field accepts a list of names for disjunction queries. The `commit` field
filters for an exact commit match and cannot be combined with
`after_commit`/`before_commit` (400 if both are supplied). Time and commit
range filters use exclusive
bounds (strictly after / strictly before the given value).

Returns cursor-paginated time-series data for graphing. Each data point
contains: `test`, `machine`, `metric`, `value`, `commit`, `ordinal`,
`run_uuid`, `submitted_at`, `tag` (the commit's tag, or null if unset).

Sort fields: `test`, `commit` (by ordinal), `submitted_at`. When `sort` is
omitted, results are returned in an arbitrary but stable order suitable for
cursor pagination; no data is excluded. When `commit` is included in the sort,
samples for commits without ordinals are excluded (they have no meaningful
position in ordinal order).

Auth scope: `read`.

### Trends (Aggregated)

```
POST   /api/suites/{testsuite}/trends
```

Body (JSON): `{metric, machine, last_n}`

The `metric` field is required and must be numeric (see D3). Non-numeric metrics
are rejected with 400. For an `integer` metric the geomean is computed in floating
point and returned as a real, like any other. All other fields are optional. Unlike
the query endpoint's single machine string, `machine` accepts a list of names -- the
Dashboard needs data for multiple machines in one call. `last_n` (integer,
min 1, max 10000) limits the result to the most recent N commits by ordinal.
Only commits with a non-null ordinal are included.

This endpoint does not filter on `tracked`: an explicitly named machine is
returned whether or not it is tracked.

Returns geomean-aggregated trend data per (machine, commit). Not paginated --
the result set is bounded by (machines x last_n), typically < 5000 rows. Each
item contains: machine name, commit string, ordinal (always present, never
null), submitted_at (latest run submission time), tag (the
commit's tag, or null if unset), and geomean value.

Geomean is computed in SQL: `exp(avg(ln(positive_values)))`, skipping
zero/negative values.

Auth scope: `read`.


## Test Suites

```
GET    /api/suites               -- List test suites defined on this instance
POST   /api/suites               -- Create a test suite from a schema definition
GET    /api/suites/{name}        -- Detail (includes schema)
PATCH  /api/suites/{name}/schema -- Add, update, or remove metrics and fields
DELETE /api/suites/{name}        -- Delete a test suite and all its data
```

Auth scopes: `read` for GET, `manage` for POST/PATCH/DELETE.

**Create** (`POST /api/suites`): the request body is the schema definition
itself -- `name`, `metrics`, `commit_fields`, `machine_fields` (see D4 in
data-model.md for the schema format). On success, returns 201 with the
created suite's detail body and a `Location` header pointing at
`GET /api/suites/{name}`. Returns 409 if a suite with that name already
exists, 400 if the schema definition fails validation (e.g. more than one
`commit_field` marked `display: true`; see D4), or 409 if suite creation
otherwise fails after passing schema validation.

**Evolve** (`PATCH /api/suites/{name}/schema`): changes the suite's `metrics`,
`commit_fields`, and/or `machine_fields` after creation. See D2 for the semantics;
what follows is the wire format.

The body supplies, for any of the three lists, any of `add`, `update`, and
`remove`:

```json
{
  "machine_fields": {
    "add":    [{"name": "kernel", "type": "text", "searchable": true}],
    "update": [{"name": "hardware", "display_name": "Hardware"}],
    "remove": ["hardwrae"]
  }
}
```

`add` entries take the schema format defined in D4. `update` entries carry a
`name` plus only the presentation keys being changed. `remove` is a list of
names.

Because `remove` destroys data, a request containing a non-empty `remove` list
requires a `?confirm=true` query parameter; omitting it returns 400. This
mirrors `DELETE /api/suites/{name}`.

On success, returns 200 with the suite's detail body. Returns 404 if the suite
does not exist, or if `update` or `remove` names an entry that is not in that
list. Returns 409 if `add` names an entry that already exists in that list.
Returns 400 if `update` attempts to change a `type`, if `confirm=true` is
required but missing, or if the resulting schema fails validation (see D3, D4,
and D5) -- validation runs against the whole resulting schema, not just the
entries the request touched.

**Delete** (`DELETE /api/suites/{name}`): permanently deletes the suite and
all of its data (machines, runs, commits, samples, regressions). Requires a
`?confirm=true` query parameter; omitting it returns 400. Returns 404 if the
suite does not exist, 204 on success.

Schema definitions and metric field metadata are returned as part of the test
suite detail response (`GET /api/suites/{name}`) rather than as
standalone endpoints. The response includes a `"schema"` object containing
`machine_fields`, `commit_fields`, and `metrics` (with `name`, `type`,
`display_name`, `unit`, `unit_abbrev`, `bigger_is_better` for each).
