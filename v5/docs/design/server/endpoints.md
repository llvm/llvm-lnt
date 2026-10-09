# v5 REST API: Endpoints

This document specifies all entity endpoints in the v5 REST API. The
conventions they share -- URL structure, envelopes, filtering, error codes and
authentication -- are in infrastructure.md.

Each section lists its routes, then gives as applicable: the auth scope, the
objects the routes accept and return, the responses of each route, and the
filters and sort orders of its list endpoint.

The following hold for every route in this document except the two
documentation routes of E1, which are outside the REST API (see I5), and are
not repeated in each section:

- A route returns 404 if the suite, or the entity its path addresses, does not
  exist.
- A UUID in a path is matched case-insensitively. A path segment that is not a
  well-formed UUID names no entity, and is a 404 like any other unknown UUID.
- Deleting a machine, commit, run or regression does not require
  `?confirm=true`, unlike the destructive suite operations (see E10).
- Each route's errors are given where the route is described. Errors that do
  not depend on the route are not necessarily repeated: 400 for a request that
  does not follow the documented format, 401 and 403 as I5 describes, the 404s
  above, I3's answers for a filter naming something that does not exist, and
  the 409 `retry` of a suite-scoped request that a concurrent change to its
  suite's schema prevented from completing (see D2).


## E1: Discovery

```
GET    /api                       -- API index: links to the suite list endpoint and API documentation
GET    /api/openapi.json          -- OpenAPI 3.x specification for this instance
GET    /api/docs                  -- Interactive API documentation viewer
```

**Auth scope:** `read` for the index. The two documentation routes are outside
the scope system and never authenticate (see I5 and I8).

`GET /api` returns `{"links": {...}}`, where `links` holds `suites` (the path
of the test suite list endpoint), `openapi` (the path of the OpenAPI
specification) and `docs` (the path of the interactive documentation viewer).
The index does not list the suites itself: `GET /api/suites` is the way to do
that.


## E2: Machines

```
GET    /api/suites/{testsuite}/machines                     -- List (searchable)
POST   /api/suites/{testsuite}/machines                     -- Create machine independently
GET    /api/suites/{testsuite}/machines/{machine_name}      -- Detail
PATCH  /api/suites/{testsuite}/machines/{machine_name}      -- Update fields/tracked (including rename)
DELETE /api/suites/{testsuite}/machines/{machine_name}      -- Delete machine, its runs, and its regression indicators
```

Machines are also created implicitly when a run is submitted for a machine that
does not exist yet (see O2). A machine's runs are listed by
`GET /api/suites/{testsuite}/runs?machine={machine_name}` (see E4).

**Auth scope:** `read` for GET, `manage` for POST, PATCH and DELETE.

**Machine object.** `POST` and `PATCH` take the same object that a run
submission nests under `machine` (see O1):

- `name`: the machine's identity.
- `tracked`: a built-in boolean (see D5), `true` when omitted at creation.
  Untracked machines are excluded only from *automatic* machine selection, and
  every endpoint otherwise returns them like any other machine. A run
  submission can also set it when it creates the machine (see O1).
- `fields`: the values of the suite's declared `machine_fields`. An undeclared
  key is rejected with 400 (see O2).

`name` and `tracked` are not nullable, so sending either as `null` is rejected
with 400.

Responses use the same object, in list and detail responses alike, plus a
read-only `last_run_at`: the `submitted_at` of the machine's most recent run, or
null if it has no runs. It is derived rather than stored (see D5).

**Updating.** On `PATCH`, an omitted key is left unchanged, and supplying
`name` renames the machine. `PATCH` can flip `tracked` at any time. Inside
`fields`, an explicit `null` clears a stored value, the same convention as
`PATCH /api/suites/{testsuite}/commits/{value}`.

**Responses.**

| Route | Success | Errors |
|-------|---------|--------|
| `POST /machines` | 201 with the created machine, and a `Location` header pointing at its detail route | 400 for an undeclared key in `fields`; 409 `duplicate` if a machine of that name already exists |
| `PATCH /machines/{machine_name}` | 200 with the updated machine | 400 for an undeclared key in `fields`; 409 `duplicate` when renaming to the name of an existing machine |
| `DELETE /machines/{machine_name}` | 204 | |

`DELETE` removes the machine, its runs (with their samples and profiles), and
every regression indicator naming it (see D5). Regressions left with no
indicators are kept.

**Filters:**

- `search=`: case-insensitive substring match on `name` or any searchable
  machine field (see O4).
- `tracked=`: boolean. Omitting it returns both tracked and untracked machines.

**Sort:** `sort=name` (the default, ascending), `-name`, `last_run_at`, and
`-last_run_at`. Machines with no runs sort after every machine that has one, in
both directions. Ties are broken by `name` ascending whatever the primary
direction, so that the order is deterministic.

Not paginated: every matching machine, in I2's unpaginated envelope (a suite
has few machines; see D5).


## E3: Commits

```
GET    /api/suites/{testsuite}/commits                      -- List (cursor-paginated, searchable)
POST   /api/suites/{testsuite}/commits                      -- Create with metadata (fields) and, optionally, an ordinal and a tag
GET    /api/suites/{testsuite}/commits/{value}              -- Detail (includes previous/next commit by ordinal)
PATCH  /api/suites/{testsuite}/commits/{value}              -- Update ordinal, tag, and/or fields
DELETE /api/suites/{testsuite}/commits/{value}              -- Delete commit (cascades to runs/samples; 409 if referenced by regressions)
POST   /api/suites/{testsuite}/commits/resolve              -- Batch resolve commit strings to summaries
```

The `{value}` in a path is the commit's identity string. Commits are also
created implicitly during run submission (see O1).

**Auth scope:** `read` for GET (including `POST /commits/resolve`), `submit`
for `POST /commits`, `manage` for PATCH and DELETE.

**Commit object.** `POST` and `PATCH` take the same object that a run
submission nests under `commit` (see O1):

- `value`: the commit's identity. It is immutable (commits cannot be renamed),
  and sending it to `PATCH` is rejected with 400.
- `ordinal` and `tag`: built-in attributes. A run submission can set them
  inline (see O1), and they can be set at creation or at any time with `PATCH`
  (see O2 and O6).
- `fields`: the values of the suite's declared `commit_fields`. An undeclared
  key is rejected with 400 (see O2).

Responses use the same object. The detail response adds `previous` and `next`:
the commits with the nearest lower and nearest higher `ordinal`, as commit
objects without their own `previous` and `next`. Commits with no ordinal are
skipped. Both keys are `null` at either end of the ordered range, and on a
commit that has no ordinal itself.

**Updating.** On `PATCH`, an omitted key is left unchanged. Sending
`ordinal: null` or `tag: null` clears a previously set value.

**Responses.**

| Route | Success | Errors |
|-------|---------|--------|
| `POST /commits` | 201 with the created commit's detail body, and a `Location` header pointing at its detail route | 400 for an undeclared key in `fields`; 409 `duplicate` if a commit with that value already exists; 409 `conflict` if the ordinal is held by another commit (see O6) |
| `PATCH /commits/{value}` | 200 with the commit's detail body | 400 for an undeclared key in `fields`; 409 `conflict` if the ordinal is held by another commit (see O6) |
| `DELETE /commits/{value}` | 204 | 409 `conflict` if a regression references the commit |

`DELETE` removes the commit, its runs, and their samples and profiles (see D5).

**Filters:**

- `search=`: case-insensitive substring match on the commit string, the tag,
  and searchable commit fields (see O4).
- `machine=`: only commits with at least one run on this machine. 404 if the
  machine does not exist.
- `has_profiles=`: boolean. `true` returns only commits where at least one run
  has profile data, and `false` only commits where no run does. Combined with
  `machine=`, only the runs on that machine are considered.
- `after_commit=`, `before_commit=`: exclusive bounds on the ordinal (strictly
  after, strictly before the named commit's). When either is given, commits
  with no ordinal are excluded, whatever the `sort`. Combined with `machine=`
  and `sort=-ordinal&limit=1`, `before_commit=` finds the commit before a given
  one at which a machine has runs. An unknown commit is 404, and one that has
  no ordinal is 400 (see I3).

**Sort:**

- `sort=first_seen` (the default) orders commits by when the server first saw
  each one, oldest first, and `sort=-first_seen` most recently seen first. The
  server first sees a commit when the commit is created, explicitly or by a run
  submission, and its place in this order never changes: neither a later run nor
  a change to its ordinal moves it. Both directions include every commit,
  including those with no ordinal, which makes `-first_seen` the order for a
  commit picker (see AR2).
- `sort=ordinal` orders by ordinal ascending (oldest first), and
  `sort=-ordinal` by ordinal descending (newest first). Both exclude commits
  with no ordinal.

### Batch Resolve

`POST /api/suites/{testsuite}/commits/resolve` looks up many commits at once.
The body is `{"commits": ["abc", "def", ...]}`, with at least one commit string
and no more than I2's maximum page size. Duplicates in the request are
ignored: each commit appears at most once in the response.

```json
{
  "results": {
    "abc": {"value": "abc", "ordinal": 42, "tag": null, "fields": {"git_sha": "..."}},
    "def": {"value": "def", "ordinal": null, "tag": null, "fields": {}}
  },
  "not_found": ["unknown"]
}
```

`results` maps each commit string that was found to its commit object
(`{value, ordinal, tag, fields}`), without the `previous` and `next` the detail
response adds. Strings that match no commit are listed in `not_found`,
including ones no commit could ever have, such as a string longer than the
column holds. A string containing a NUL character is the exception: it is
rejected with 400 (see D5).

Not paginated: the response is bounded by the size of the request.


## E4: Runs

```
GET    /api/suites/{testsuite}/runs                         -- List (cursor-paginated, searchable, filterable by machine=, commit=, after=, before=, has_profiles=; sortable by sort=)
POST   /api/suites/{testsuite}/runs                         -- Submit run (accepts optional client UUID or generates one, returns it)
GET    /api/suites/{testsuite}/runs/{uuid}                  -- Detail
DELETE /api/suites/{testsuite}/runs/{uuid}                  -- Delete run
```

**Auth scope:** `read` for GET, `submit` for POST, `manage` for DELETE.

**Run object:** `uuid`, `machine` (the machine's name), `commit` (the commit's
identity string), `submitted_at`, and `run_parameters`. `run_parameters` is the
free-form blob the submission supplied, or `{}` if it supplied none. It
appears in the detail response only, because it is unbounded and no list view
displays it -- the same reason a regression's `notes` is detail-only.

```json
{
  "uuid": "573af861-8303-4a5b-a643-b8321e0142c4",
  "machine": "linux-x86_64",
  "commit": "014621ede7c1",
  "submitted_at": "2026-08-25T14:22:41Z",
  "run_parameters": {"build_config": "Release"}
}
```

The list returns the same object as the detail, without `run_parameters`. A
client that wants to show a commit's display value in a list of runs resolves
the page's commits in one batch through `POST /commits/resolve`. The server
does not embed the display value, whose meaning is purely a UI concern (see
D4).

**Submitting a run.** `POST` requires a JSON submission with `format_version`
`'5'` (see O1). The run's UUID is either supplied in the submission or
generated by the server; O1 gives the rules. The machine and the commit the
submission names are created if they do not exist, and otherwise reconciled
with the submission (see O2). A profile that O7 refuses is rejected with 400.

**Responses.**

| Route | Success | Errors |
|-------|---------|--------|
| `POST /runs` | 201 with the created run in its detail form, and a `Location` header pointing at its detail route | 400 for an undeclared key in `machine.fields` or `commit.fields`; 409 `duplicate` for a UUID a run already has (see O1); 409 `conflict` for metadata that contradicts what is stored, including a contradicted `ordinal` (see O2), or for an `ordinal` already held by another commit (see O6) |
| `DELETE /runs/{uuid}` | 204 | |

**Filters:**

- `search=`: matches the run's machine or commit, as the machine and commit
  lists' `search=` match them, or a prefix of the run's `uuid` (see O4).
- `machine=`, `commit=`, `after=`, `before=` (see I3).
- `has_profiles=`: boolean. `true` returns only runs with at least one profile
  attached, and `false` only runs without profiles.

**Sort:** `sort=submitted_at` returns oldest first, and `sort=-submitted_at`
newest first. Without `sort`, results come in an arbitrary but deterministic
order suitable for pagination (see I2).


## E5: Tests

```
GET    /api/suites/{testsuite}/tests                        -- List (cursor-paginated, filterable)
```

Read-only: tests are created implicitly by run submission.

**Auth scope:** `read`.

**Test object:** `name`. It is an object rather than a bare string so that it
can gain keys later.

**Filters:**

- `search=`: case-insensitive substring match on the test name (see O4).
- `machine=`: only tests with data for this machine.
- `metric=`: only tests with non-null values for this metric.

Given together, `?machine=m&metric=execution_time` returns the tests that have
an `execution_time` value *on that machine*. Both filters consider every sample
ever submitted: deleting runs or commits does not remove a test from their
results, while deleting a machine does (see `{suite}.test_coverage` in D5).

**Sort:** none. Results come in an arbitrary but deterministic order suitable
for pagination (see I2 and O5).


## E6: Samples

```
GET    /api/suites/{testsuite}/runs/{uuid}/samples   -- Samples for a run (cursor-paginated, filterable by test=)
```

Samples have no external identifier of their own, so they are always read through their
run. They are read-only: samples are created by run submission.

**Auth scope:** `read`.

**Sample object:** `test` (the test's name) and `metrics`, a dict of metric name
to value that contains only the metrics with a value, typed per D3 (see I4):

```json
{"test": "test.suite/benchmark", "metrics": {"execution_time": 1.23, "compile_status": 0}}
```

A test measured several times within one run gives one object per repetition
(see O1). By design, the repetitions cannot be told apart.

**Filters:** `test=`: only the samples of this test. A test that exists but
that this run did not measure gives an empty page rather than an error.

**Sort:** none. Results come in an arbitrary but deterministic order suitable
for pagination (see I2 and O5).


## E7: Profiles

Profiles store hardware performance counter data at the instruction level.
Each profile has a server-generated UUID, which gives the profile data
endpoints stable, bookmarkable identifiers. The per-run list endpoint maps
human-readable run and test coordinates to those UUIDs.

Profiles are submitted within the run submission (see O1 and O7). There is no
separate upload endpoint. Every counter these endpoints return is a raw count
(see O7).

**Auth scope:** `read` for every route in this section.

### Listing (per run)

```
GET  /api/suites/{testsuite}/runs/{uuid}/profiles              -- List profiles for a run
```

Returns `{test, uuid}` objects for all the profiles attached to the run,
ordered by test name, in I2's unpaginated envelope (the list is bounded by the
tests of one run).

### Profile Data (by UUID)

```
GET  /api/suites/{testsuite}/profiles/{uuid}                       -- Metadata + top-level counters
GET  /api/suites/{testsuite}/profiles/{uuid}/functions             -- Function list with counters
GET  /api/suites/{testsuite}/profiles/{uuid}/disassembly           -- Disassembly + per-instruction counters
GET  /api/suites/{testsuite}/profiles/{uuid}/document              -- The whole profile, as one profile document
```

**Metadata** (`GET /api/suites/{testsuite}/profiles/{uuid}`): `uuid`, `test`
(the test's name), `run_uuid`, `counters` (counter name to integer: the
profile's top-level counters), and `disassembly_format` (string).

**Functions** (`GET /api/suites/{testsuite}/profiles/{uuid}/functions`): I2's
unpaginated envelope over `{name, counters, length}` objects. `counters` maps
each counter name to a number: the function's counter, summed over its
instructions. `length` is the function's number of instructions. Sorted by
name, in ascending code-point order. How hot a function is depends on which
counter the user picks, so the client sorts by that itself (see PF4).

**Disassembly** (`GET /api/suites/{testsuite}/profiles/{uuid}/disassembly?function={name}`):

- `function` is required, and is the function's name as given in the functions
  response. It is a query parameter because a name can contain `/` (see I1). A
  name the profile does not contain is a 404.
- Returns `name`, `counters` (the function's counters, as in the functions
  response), `disassembly_format`, and `instructions`: an array of
  `{address, counters, text}`, one per instruction, in the order the profile
  document listed them. `address` is an integer, and `counters` maps counter
  names to numbers.

**Document** (`GET /api/suites/{testsuite}/profiles/{uuid}/document`): the
whole profile in one response, as the profile document defined in O7:
`disassembly_format`, the top-level `counters`, and `functions`, each with its
`name` and `instructions`.

- It is plain JSON, rather than the gzip-compressed, base64-encoded string a
  submission carries. Once compressed and encoded that way, it can be used as a
  test entry's `profile` to store an equivalent profile, so that a profile can
  be copied to another run or instance without one request per function. The
  server's encoding of it may be larger than the submitted one, so a profile
  submitted close to O7's size limits may exceed them when read back.
- It contains only what a profile document contains, so the functions' derived
  counters and lengths are absent.
- `functions` are in the order of the functions response, not necessarily the
  order they were submitted in. Each function's `instructions` are in the order
  the disassembly response gives them.


## E8: Regressions

```
GET    /api/suites/{testsuite}/regressions                              -- List (cursor-paginated, searchable, filterable by state=, machine=, test=, metric=, commit=, has_commit=; sortable by sort=)
POST   /api/suites/{testsuite}/regressions                              -- Create (accepts uuid, title, bug, notes, state, commit, indicators)
GET    /api/suites/{testsuite}/regressions/{uuid}                       -- Detail (indicators embedded)
PATCH  /api/suites/{testsuite}/regressions/{uuid}                       -- Update title, bug, notes, state, commit
DELETE /api/suites/{testsuite}/regressions/{uuid}                       -- Delete (cascades indicators)
POST   /api/suites/{testsuite}/regressions/{uuid}/indicators            -- Add indicator(s) (batch)
DELETE /api/suites/{testsuite}/regressions/{uuid}/indicators            -- Remove indicator(s) (batch, UUIDs in body)
POST   /api/suites/{testsuite}/regressions/indicators/query             -- Look up indicators across regressions (cursor-paginated, filterable by machine, test, metric, state, commit)
```

Regressions and their indicators are identified by UUIDs. A regression's UUID
may be supplied by the client at creation (see below); an indicator's is always
generated by the server.

**Auth scope:** `read` for GET and for the indicator lookup; `triage` for POST,
PATCH, DELETE and indicator management.

**States** (string enum): `detected`, `active`, `not_to_be_fixed`, `fixed`,
`false_positive`. State transitions are unconstrained: `PATCH` can change any
state to any other.

**Creating.** Every key of the `POST` body is optional:

- `uuid` (string): validated, normalized, and generated when omitted or
  `null`, exactly like a run submission's `uuid` (see O1).
- `title` (string): `null` when omitted. The server never generates one.
- `bug` (string): a URL to an external bug tracker.
- `notes` (string): investigation findings, A/B results, etc.
- `state` (string): `detected` by default.
- `commit` (string): the commit suspected of introducing the regression, by
  value. 404 if no commit has that value.
- `indicators` (array): a list of `{machine, test, metric}` objects, all resolved by
  name. 404 if a machine or test does not exist, 400 if `metric` is not a
  metric of the suite. Duplicates within the list are stored once, and the
  list's length is bounded, both as on the add route below.

A `title` or `bug`, here or on update, is a non-empty string of at most 256
characters (see D5).

**Updating.** `PATCH` accepts `title`, `bug`, `notes`, `state`, and `commit`.
An omitted key is left unchanged, and sending `title`, `bug`, `notes`, or
`commit` as `null` clears a previously set value -- the same convention as
`PATCH /api/suites/{testsuite}/commits/{value}`. `state` is not nullable, so
`state: null` is rejected with 400. `commit` is resolved by value, with 404 if
no commit has that value. `PATCH` does not touch indicators, which are managed
through the indicator routes below.

**Detail response:**

- `uuid`, `title`, `bug`, `notes`, `state`
- `commit`: the commit's identity string, or `null`
- `created_at`: when the regression was created (see D5)
- `indicators`: a list of `{uuid, machine, test, metric}`, oldest first. It may
  be empty (see D5).

**List items** contain exactly `uuid`, `title`, `bug`, `state`, `commit`,
`created_at`, `machine_count`, and `test_count`. `notes` is in the detail
response only. `machine_count` and `test_count` are the numbers of distinct
machines and tests among the regression's indicators. They describe the
regression, not the query, so a `machine=` or `test=` filter does not change
them.

**Responses.**

| Route | Success | Errors |
|-------|---------|--------|
| `POST /regressions` | 201 with the created regression's detail body, and a `Location` header pointing at its detail route | 400 if an indicator's `metric` is not a metric of the suite; 404 if `commit`, or an indicator's machine or test, does not exist; 409 `duplicate` if a regression with that UUID already exists in the suite |
| `PATCH /regressions/{uuid}` | 200 with the regression's detail body | 404 if `commit` does not exist |
| `DELETE /regressions/{uuid}` | 204 | |

**Filters:**

- `search=`: case-insensitive substring match on `title`, or prefix match on
  `uuid` (see O4).
- `state=`: any number of state names, repeated (see I3). An unknown name is
  400.
- `machine=`, `test=` and `metric=`: only regressions with an indicator naming
  it. Given together, they must match the *same* indicator, as with
  `GET /api/suites/{testsuite}/tests`.
- `commit=` and `has_commit=`.

An unknown machine or test is 404, an unknown metric is 400, and an unknown
`commit=` gives an empty result (see I3).

**Sort:** `sort=created_at` returns oldest first, and `sort=-created_at` newest
first. Without `sort`, results come in an arbitrary but deterministic order
suitable for pagination (see I2 and O5).

### Adding indicators

`POST /api/suites/{testsuite}/regressions/{uuid}/indicators`

- The body is `{"indicators": [{machine, test, metric}, ...]}`, with at least
  one indicator and no more than I2's maximum page size, as for
  `POST /commits/resolve`. Each object is one indicator, resolved the same way
  as `indicators` on creation: 404 if the machine or test does not exist, 400
  for an invalid metric name.
- Duplicates (same regression, machine, test and metric) are silently ignored,
  whether they are already stored or repeated within the list.
- Returns 200 with `{"added": N, "indicators": [...]}`. `indicators` is the
  regression's full indicator list afterwards, and `added` counts only the
  indicators this request actually created. It is 200 rather than 201 because
  a request whose indicators all exist already creates nothing.

### Removing indicators

`DELETE /api/suites/{testsuite}/regressions/{uuid}/indicators`

- The body is `{"indicator_uuids": ["...", "..."]}`, bounded like the add
  request. UUIDs are matched case-insensitively.
- Returns 200 with `{"removed": N, "indicators": [...]}`, like the add
  response.
- A UUID that names no indicator of this regression is ignored rather than a
  404, so that retrying a removal is not an error. An indicator of another
  regression is never removed.

### Looking up indicators across regressions

`POST /api/suites/{testsuite}/regressions/indicators/query` lists indicators
across every regression of the suite. A client holding many (machine, test,
metric) combinations can learn which regressions cover which of them without
one request per combination -- for the Graph page's regression annotations
(GR15), or for a detector checking whether what it found is already tracked
(O3). It is a `read`-scoped POST for the same reason as `POST /query` (E9).

- The body is `{machine, test, metric, state, commit, limit, cursor}`, and
  every key is optional. `machine`, `test` and `state` are lists of names, each
  no longer than I2's maximum page size. `metric` and `commit` are single
  names.
- An indicator is returned when its machine, test and metric are each among
  those named, its regression is in one of the named states, and its regression
  is attributed to the named commit. An omitted key does not filter at all,
  whereas an empty list matches nothing, as with `POST /query`'s `test`.
- An unknown machine or test is 404, an unknown metric is 400, and an unknown
  commit gives an empty result (see I3). An unknown state name is 400, as for
  the list.
- Returns I2's cursor envelope over `{uuid, regression_uuid, machine, test,
  metric}`: the indicator as the detail response gives it, plus the UUID of the
  regression it belongs to.
- Sort: none. Results come in an arbitrary but deterministic order suitable for
  pagination (see I2 and O5).


## E9: Time Series

### Query

```
POST   /api/suites/{testsuite}/query
```

Returns time-series data for graphing. It is a `read`-scoped POST because its
list of test names, which may be long and whose names may contain any
character, does not fit in a query string.

**Auth scope:** `read`.

**Body** (JSON): `{metric, machine, test, commit, after_commit, before_commit,
after_time, before_time, sort, limit, cursor}`.

- `metric` is required, and every other key is optional. Only samples with a
  value for that metric are returned, so every point has a non-null `value`.
- `test` is a list of names, no longer than I2's maximum page size, and a point
  matches if its test is any of them. An empty list matches nothing, unlike an
  omitted one.
- `commit` keeps only the samples of that commit. It cannot be combined with
  `after_commit` or `before_commit` (400 if both are supplied).
- The time and commit bounds are exclusive (strictly after, strictly before).
  When either commit bound is given, samples on commits with no ordinal are
  excluded, whatever the `sort`.
- `sort` names one ordering, optionally prefixed with `-` for descending (see
  I3): `test`, `commit` (by ordinal), or `submitted_at`. Sorting by `commit`
  excludes the samples on commits with no ordinal, since they have no position
  in that order. Without `sort`, results come in an arbitrary but stable order
  suitable for cursor pagination, and no data is excluded.
- An unknown machine or test is 404 and an unknown metric is 400. An unknown
  `commit` gives an empty result. An unknown `after_commit` or `before_commit`
  is 404, and one that has no ordinal is 400 (see I3).

**Response:** I2's cursor envelope, whose `limit` and `cursor` are keys of the
body. Each point contains `test`, `machine`, `metric`, `value`, `commit`,
`ordinal`, `run_uuid`, `submitted_at`, and `tag` (the commit's tag, or null if
unset). `metric` is repeated on every point even though the request names
exactly one, so that each point is self-describing.

### Trends (Aggregated)

```
GET    /api/suites/{testsuite}/trends
```

Returns one aggregated value per machine and commit.

**Auth scope:** `read`.

**Query parameters:**

- `metric` (required): must be numeric (see D3). A non-numeric metric is
  rejected with 400.
- `machine` (required): one or more machine names, repeated (see I3), so that
  several machines' data can be fetched in one call -- unlike the query
  endpoint, which takes a single machine. It is required so that no request
  aggregates the whole suite at once. An unknown name is 404. A machine named
  here is returned whether or not it is tracked.
- `sample_agg`: `median` (the default), `mean`, `min` or `max`.
- `last_n`: an integer from 1 to 10000, 500 by default. It limits the result to
  the N most recent commits, by ordinal, at which any of the named machines has
  a run geomean (see O9) for `metric` under `sample_agg`. All the named machines
  share this window, so a machine that stopped reporting partway through it has
  a trend line that stops early. Only commits with an ordinal are included.

**Response:** one item per (machine, commit), in I2's unpaginated envelope; the
size is bounded by the number of machines times `last_n`. Items are ordered by
machine name, then by ordinal. Each item contains:

- `machine`: the machine's name
- `commit`: the commit's identity string
- `ordinal`: always present, never null
- `submitted_at`: the latest submission among the runs the value covers
- `tag`: the commit's tag, or null if unset
- `value`: the geomean of the run geomeans (see O9) of the runs at that machine
  and commit, for `metric` under `sample_agg`. It is a real number even for an
  `integer` metric.

A (machine, commit) with no run geomean is absent from the response. Unlike a
query point, an item does not repeat `metric`.


## E10: Test Suites

```
GET    /api/suites               -- List test suites defined on this instance
POST   /api/suites               -- Create a test suite from a schema definition
GET    /api/suites/{name}        -- Detail
PATCH  /api/suites/{name}/schema -- Add, update, or remove metrics and fields
DELETE /api/suites/{name}        -- Delete a test suite and all its data
```

**Auth scope:** `read` for GET, `manage` for POST, PATCH and DELETE.

**Suite object:** a suite's detail body is its normalized schema: the body
`POST /api/suites` accepts, with omitted optional keys filled in (see D4 for the
format and its normalization). Request and response are therefore the same
document, and a suite fetched from one instance can be posted unchanged to
another. There are no separate schema or metric-metadata endpoints.

**List** (`GET /api/suites`): the same objects, in I2's unpaginated envelope,
ordered by `name` ascending -- an order that is stable because suites cannot be
renamed. Whole schemas are returned rather than names alone, because suites
are few and parts of the client need every suite's metrics up front.

**Create** (`POST /api/suites`): the body is the schema itself: `name`,
`metrics`, `commit_fields`, `machine_fields` (see D4).

- 201 with the created suite's detail body, and a `Location` header pointing at
  `GET /api/suites/{name}`.
- 400 if the schema fails validation (see D4).
- 409 `duplicate` if a suite with that name already exists.
- 409 `conflict` if a database namespace of that name exists although no suite
  does.
- 409 `retry` if the creation could not take the locks it needs.

**Evolve** (`PATCH /api/suites/{name}/schema`): changes the suite's `metrics`,
`commit_fields`, and/or `machine_fields` after creation. D2 gives the semantics;
this is the wire format.

For each of the three lists, the body may supply any of `add`, `update`, and
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

- `add` entries use the schema format from D4.
- `update` entries have a `name`, plus only the presentation keys being
  changed.
- `remove` is a list of names.

Because `remove` destroys data, a request with a non-empty `remove` list
requires `?confirm=true`. Without it, or with `confirm=false`, the request is
rejected with 400. An empty `remove` list requires nothing. This mirrors
`DELETE /api/suites/{name}`.

- 200 with the suite's detail body. A request that asks for no change is a
  successful no-op.
- 400 if `update` tries to change a `type`, if `confirm=true` is required but
  missing, or if the resulting schema fails validation (see D3, D4, and D5).
  Validation covers the whole resulting schema, not just the entries the
  request touched.
- 404 if `update` or `remove` names an entry that is not in that list.
- 409 `duplicate` if `add` names an entry that already exists in that list.
- 409 `retry` if the change could not take the locks it needs.

**Delete** (`DELETE /api/suites/{name}`): permanently deletes the suite and all
of its data (machines, runs, commits, samples, regressions). Requires
`?confirm=true`: without it, or with `confirm=false`, the request is rejected
with 400.

- 204 on success.
- 409 `retry` if the deletion could not take the locks it needs.

Both this and `PATCH .../schema` look up the suite before checking `confirm`, so
an unknown name is a 404 whether or not `confirm=true` was supplied.


## E11: Admin

Instance-level API key management, outside any test suite.

```
GET    /api/admin/api-keys           -- List keys
POST   /api/admin/api-keys           -- Create key, returns the raw token once
DELETE /api/admin/api-keys/{prefix}  -- Revoke key
```

**Auth scope:** `admin` for all three, including the GET. These are the only
GET endpoints in the API that require more than `read`, and so the only ones
that anonymous access never reaches (see I5).

**Key object:** `prefix`, `name`, `scope`, `created_at`, `last_used_at`,
`is_active`. `last_used_at` is null until the key is first used, and
approximate after that (see D5). Neither the raw token nor its hash ever
appears, except for the raw token in the create response below.

**List** (`GET /api/admin/api-keys`): key objects in I2's unpaginated envelope,
newest first (`created_at` descending), with `prefix` as a tiebreaker. Since
`created_at` never changes, this order is stable across requests. Ordering by
`last_used_at` is deliberately avoided, because that column is mutable,
nullable, and only approximate (see D5). Revoked keys are included, with
`is_active: false`.

**Create** (`POST /api/admin/api-keys`): the body has `name` (string, required)
and `scope` (string, required: one of `read`, `submit`, `triage`, `manage`,
`admin`).

- 201 with the key object plus a `token` field holding the raw token. The token
  is shown only this once and cannot be retrieved afterwards (see I5). No
  `Location` header is set: there is deliberately no per-key detail route.
- 400 if `name` is missing, empty, or longer than 256 characters (see D5), or
  if `scope` is missing or not one of the five values. `name` is a label rather
  than an identifier, so two keys may share one.

**Revoke** (`DELETE /api/admin/api-keys/{prefix}`): sets `is_active` to false
rather than deleting the row, so that the revocation stays visible and the
prefix is never reused by a later key.

- 204 on success, and 204 again if the key was already revoked (revocation is
  idempotent).
- 404 if no key has that prefix, including when a caller passes a whole token
  instead of its prefix.

Revocation takes effect immediately (see I5) and cannot be undone: restoring
access means creating a new key. No `?confirm=true` is required, unlike the
destructive suite operations, because revoking a key destroys no data.

A key is otherwise immutable: there is no PATCH route, and changing a key's
scope means creating a replacement and revoking the original. Keys do not
expire.

Any `admin` key may revoke any key, including the one authenticating the
request and the last remaining active `admin` key. There is deliberately no
exception for either, because an operator's ability to revoke a leaked key must
not depend on which key leaked. After revoking the last `admin` key, an
operator creates a new one through the out-of-band interface described in I5,
which is also how an instance gets its first key.


## E12: Authentication

```
GET    /api/auth                  -- The API key the request authenticated with, if any
```

**Auth scope:** `read`.

Returns `{"key": ...}`, where `key` is the API key the request's credential
belongs to, as an object with E11's key fields, or `null` when the request has
no `Authorization` header. A credential that does not authenticate is a 401, as
on every endpoint under `/api/` (see I5). This makes the endpoint a way for a
client to check a token: whether it is usable, and which scope it grants.
