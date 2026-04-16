# v5 REST API: Endpoints

This document specifies all entity endpoints in the v5 REST API.

For framework, pagination, auth, and other infrastructure, see
[`infrastructure.md`](infrastructure.md).


## Machines

```
GET    /machines                     -- List (filterable, simple pagination)
POST   /machines                     -- Create machine independently
GET    /machines/{machine_name}      -- Detail
PATCH  /machines/{machine_name}      -- Update metadata/parameters (including rename)
DELETE /machines/{machine_name}      -- Delete machine and its runs
GET    /machines/{machine_name}/runs -- List runs for this machine (cursor-paginated)
```

Machines are also created implicitly if a run is submitted for a nonexistent machine.


## Commits

```
GET    /commits                      -- List (cursor-paginated, searchable)
POST   /commits                      -- Create with metadata (commit_fields)
GET    /commits/{value}              -- Detail (includes previous/next commit by ordinal)
PATCH  /commits/{value}              -- Update ordinal and/or commit_fields
DELETE /commits/{value}              -- Delete commit (cascades to runs/samples; 409 if referenced by regressions)
```

The `{value}` in the path is the commit identity string. Commits are also
created implicitly during run submission. Ordinals are always NULL on creation
and assigned exclusively via PATCH (see
[D11 in db/operations.md](../db/operations.md#d11-ordinal-management)).


## Runs

```
GET    /runs                         -- List (cursor-paginated, filterable by machine=, after=, before=)
POST   /runs                         -- Submit run (server generates UUID, returns it)
GET    /runs/{uuid}                  -- Detail
DELETE /runs/{uuid}                  -- Delete run
```

The UUID is a new field, generated server-side on submission. The submission
endpoint requires JSON format with `format_version '5'`. Legacy formats (v0,
v1, v2) and non-JSON payloads are rejected.


## Tests

```
GET    /tests                        -- List (cursor-paginated, filterable)
GET    /tests/{test_name}            -- Detail
```

Read-only. Tests are created implicitly via run submission.

Filters: `name_contains=`, `name_prefix=`, `machine=` (only tests with data
for this machine), `metric=` (only tests with non-NULL values for this metric).


## Samples

Samples are always accessed through their parent run -- they have no external
identifier of their own.

```
GET    /runs/{uuid}/samples                        -- All samples for a run (cursor-paginated)
GET    /runs/{uuid}/samples?has_profile=true        -- Filter to samples with profiles
GET    /runs/{uuid}/tests/{test_name}/samples       -- Samples for a specific test in a run
```

Read-only. Samples are created as part of run submission.


## Profiles

Profiles are accessed through run + test name. Under the hood, the API finds
the sample for that run+test that has a profile attached.

```
GET  /runs/{uuid}/tests/{test_name}/profile                      -- Profile metadata + top-level counters
GET  /runs/{uuid}/tests/{test_name}/profile/functions             -- List functions with counters
GET  /runs/{uuid}/tests/{test_name}/profile/functions/{fn_name}   -- Disassembly + per-instruction counters
```

Profiles are submitted as base64-encoded data within the run submission payload
(existing format). No separate upload endpoint.


## Regressions

```
GET    /regressions                              -- List (cursor-paginated, filterable by state=, machine=, test=, metric=, commit=, has_commit=)
POST   /regressions                              -- Create (accepts title, bug, notes, state, commit, indicators)
GET    /regressions/{uuid}                       -- Detail (indicators embedded)
PATCH  /regressions/{uuid}                       -- Update title, bug, notes, state, commit
DELETE /regressions/{uuid}                       -- Delete (cascades indicators)
POST   /regressions/{uuid}/indicators            -- Add indicator(s) (batch)
DELETE /regressions/{uuid}/indicators            -- Remove indicator(s) (batch, UUIDs in body)
```

Auth scopes: read=GET, triage=POST/PATCH/DELETE and indicator management.

Regressions are identified by server-generated UUID.

**Regression states** (string enum):
`detected`, `active`, `not_to_be_fixed`, `fixed`, `false_positive`

State transitions are unconstrained -- any state can be set to any other
state via PATCH.

**Create request body:**
- `title` (string, optional -- auto-generated if omitted)
- `bug` (string, optional -- URL to external bug tracker)
- `notes` (string, optional -- investigation findings, A/B results, etc.)
- `state` (string, optional -- default: `detected`)
- `commit` (string, optional -- suspected introduction commit, resolved by value)
- `indicators` (array, optional -- list of `{machine, test, metric}` objects,
  all resolved by name)

**Detail response** (`GET /regressions/{uuid}`):
- `uuid`, `title`, `bug`, `notes`, `state`
- `commit` (commit identity string, or null)
- `indicators`: list of `{uuid, machine, test, metric}`

**List response items** include: `uuid`, `title`, `bug`, `state`, `commit`,
`machine_count`, `test_count`. The `notes` field is included in detail
responses only, not in list.

**Indicator add request** (`POST /regressions/{uuid}/indicators`):
- Array of `{machine, test, metric}` objects. Each object is one indicator.
  Duplicates (same regression+machine+test+metric) are silently ignored.

**Indicator remove request** (`DELETE /regressions/{uuid}/indicators`):
- Body: `{"indicator_uuids": ["...", "..."]}`


## Time Series

### Query

```
POST   /query
```

Body (JSON): `{metric, machine, test, commit, after_commit, before_commit,
              after_time, before_time, sort, limit, cursor}`

The `metric` field is required; all other fields are optional. The `test`
field accepts a list of names for disjunction queries. The `commit` field
filters for an exact commit match and cannot be combined with
`after_commit`/`before_commit`.

Returns cursor-paginated time-series data for graphing. Each data point
contains: `test`, `machine`, `metric`, `value`, `commit`, `ordinal`,
`run_uuid`, `submitted_at`.

Sort fields: `test`, `commit` (by ordinal), `submitted_at`. Default sort:
`commit,test`.

### Trends (Aggregated)

```
POST   /trends
```

Body (JSON): `{metric, machine, after_time, before_time}`

The `metric` field is required and must have type `real`; `status` and `hash`
metrics are rejected with 400. All other fields are optional. Unlike the query
endpoint's single machine string, `machine` accepts a list of names -- the
Dashboard needs data for multiple machines in one call. Order-based filters
are intentionally omitted; the Dashboard uses time-based filtering exclusively.

Returns geomean-aggregated trend data per (machine, commit). Not paginated --
the result set is bounded by (machines x commits in range), typically < 2000
rows. Each item contains: machine name, commit string, ordinal (nullable),
submitted_at (latest run submission time), and geomean value.

Geomean is computed in SQL: `exp(avg(ln(positive_values)))`, skipping
zero/negative values.


## Schema and Fields

Schema definitions and metric field metadata are returned as part of the test
suite detail response (`GET /api/v5/test-suites/{name}`) rather than as
standalone endpoints. The response includes a `"schema"` object containing
`machine_fields`, `commit_fields`, and `metrics` (with `name`, `type`,
`display_name`, `unit`, `unit_abbrev`, `bigger_is_better` for each).

There are no separate `/fields` or `/schema` endpoints.
