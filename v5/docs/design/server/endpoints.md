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

- A route returns 404 if the project, the suite, or the entity its path
  addresses does not exist.
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
GET    /api                       -- API index: links to the project list endpoint and API documentation
GET    /api/openapi.json          -- OpenAPI 3.x specification for this instance
GET    /api/docs                  -- Interactive API documentation viewer
```

**Auth scope:** `read` for the index. The two documentation routes are outside
the scope system and never authenticate (see I5 and I8).

`GET /api` returns `{"links": {...}, "revision": ...}`, where `links` holds
`projects` (the path of the project list endpoint), `openapi` (the path of the
OpenAPI specification) and `docs` (the path of the interactive documentation
viewer), and `revision` is the commit of LNT the server was built from, as a
lowercase hexadecimal commit hash, possibly abbreviated, or `null` when the
server does not know it. The index does not list the projects and their suites
itself: `GET /api/projects` is the way to do that.


## E2: Machines

```
GET    /api/projects/{project}/suites/{suite}/machines                     -- List (searchable)
POST   /api/projects/{project}/suites/{suite}/machines                     -- Create machine independently
GET    /api/projects/{project}/suites/{suite}/machines/{machine_name}      -- Detail
PATCH  /api/projects/{project}/suites/{suite}/machines/{machine_name}      -- Update fields/tracked (including rename)
DELETE /api/projects/{project}/suites/{suite}/machines/{machine_name}      -- Delete machine, its runs, and its regression indicators
```

Machines are also created implicitly when a run is submitted for a machine that
does not exist yet (see O2). A machine's runs are listed by
`GET /api/projects/{project}/suites/{suite}/runs?machine={machine_name}` (see
E4).

**Auth scope:** `read` for GET, `manage` for POST, PATCH and DELETE.

**Machine object.** `POST` and `PATCH` take the same object that a run
submission nests under `machine` (see O1):

- `name`: the machine's identity.
- `tracked`: a built-in boolean (see D5), `true` when omitted at creation.
  Untracked machines are excluded only from *automatic* machine selection, and
  every endpoint otherwise returns them like any other machine. A run
  submission can also set it when it creates the machine (see O1).
- `delete_after_inactive_days`: a built-in integer from 1 to 36500, or `null`:
  the number of days without activity after which the machine is deleted, along
  with everything `DELETE` deletes (see O10). `null` when omitted at creation,
  meaning the machine is never deleted that way. A run submission can also set
  it when it creates the machine (see O1).
- `fields`: the values of the suite's declared `machine_fields`. An undeclared
  key is rejected with 400 (see O2).

`name` and `tracked` are not nullable, so sending either as `null` is rejected
with 400.

Responses use the same object, in list and detail responses alike, plus a
read-only `last_run_at`: the latest `measured_at` among the machine's runs, or
null if it has no runs. It is derived rather than stored (see D5).

**Updating.** On `PATCH`, an omitted key is left unchanged, and supplying
`name` renames the machine. The old name is not kept as an alias: run
submissions find their machine by name (see O2), so those that still use the old
name create a new machine. `PATCH` can flip `tracked` at any time, and set
`delete_after_inactive_days` or clear it with `null`. Each key of `fields` is
likewise left unchanged when omitted and cleared by `null`.

**Responses.**

| Route | Success | Errors |
|-------|---------|--------|
| `POST /machines` | 201 with the created machine, and a `Location` header pointing at its detail route | 400 for an undeclared key in `fields`; 409 `duplicate` if a machine of that name already exists |
| `PATCH /machines/{machine_name}` | 200 with the updated machine | 400 for an undeclared key in `fields`, or a new name that I1 rejects; 409 `duplicate` when renaming to the name of an existing machine |
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
GET    /api/projects/{project}/suites/{suite}/commits                      -- List (cursor-paginated, searchable)
POST   /api/projects/{project}/suites/{suite}/commits                      -- Create with metadata (fields) and, optionally, an ordinal and a tag
GET    /api/projects/{project}/suites/{suite}/commits/{value}              -- Detail (includes previous/next commit by ordinal)
PATCH  /api/projects/{project}/suites/{suite}/commits/{value}              -- Update ordinal, tag, and/or fields
DELETE /api/projects/{project}/suites/{suite}/commits/{value}              -- Delete commit (cascades to runs/samples; keeps regressions, with no commit)
POST   /api/projects/{project}/suites/{suite}/commits/resolve              -- Batch resolve commit strings to summaries
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
- `delete_after_inactive_days`: a built-in attribute, as on a machine (see E2),
  after which the commit is deleted along with everything `DELETE` deletes. It
  has no effect while the commit has an ordinal (see O10).
- `fields`: the values of the suite's declared `commit_fields`. An undeclared
  key is rejected with 400 (see O2).

Responses use the same object. The detail response adds `previous` and `next`:
the commits with the nearest lower and nearest higher `ordinal`, as commit
objects without their own `previous` and `next`. Commits with no ordinal are
skipped. Both keys are `null` at either end of the ordered range, and on a
commit that has no ordinal itself.

**Updating.** On `PATCH`, an omitted key is left unchanged. Sending
`ordinal: null`, `tag: null` or `delete_after_inactive_days: null` clears a
previously set value. The same applies to each key of `fields`.

**Responses.**

| Route | Success | Errors |
|-------|---------|--------|
| `POST /commits` | 201 with the created commit's detail body, and a `Location` header pointing at its detail route | 400 for an undeclared key in `fields`; 409 `duplicate` if a commit with that value already exists; 409 `conflict` if the ordinal is held by another commit (see O6) |
| `PATCH /commits/{value}` | 200 with the commit's detail body | 400 for an undeclared key in `fields`; 409 `conflict` if the ordinal is held by another commit (see O6) |
| `DELETE /commits/{value}` | 204 | |

`DELETE` removes the commit, its runs, and their samples and profiles (see D5).
The regressions attributed to the commit are kept, with no commit (see D5).

**Filters:**

- `search=`: case-insensitive substring match on the commit string, the tag,
  and searchable commit fields (see O4).
- `commit=`: only the commit with this value, if it also satisfies the other
  filters. An unknown commit gives an empty result (see I3). A commit picker
  uses it to check that it would offer a commit it was given (see AR15).
- `machine=`: only commits with at least one run on this machine. 404 if the
  machine does not exist.
- `has_profiles=`: boolean. `true` returns only commits where at least one run
  has profile data, and `false` only commits where no run does. Combined with
  `machine=`, only the runs on that machine are considered.
- `has_ordinal=`: boolean. `true` returns only commits with an ordinal, and
  `false` only commits without one.
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
  a change to its ordinal moves it.
- `sort=ordinal` orders the commits with an ordinal by ordinal ascending
  (oldest first), and `sort=-ordinal` by ordinal descending (newest first),
  which makes `-ordinal` the order for a commit picker (see AR15). In both
  directions, the commits without an ordinal follow, in first-seen order in the
  same direction: oldest first under `ordinal`, most recently seen first under
  `-ordinal`. With `has_ordinal=false`, `ordinal` and `-ordinal` are therefore
  the `first_seen` and `-first_seen` orders.

No sort leaves out the commits without an ordinal: only `has_ordinal=true` and
the commit bounds do.

### Batch Resolve

`POST /api/projects/{project}/suites/{suite}/commits/resolve` looks up many
commits at once. The body is `{"commits": ["abc", "def", ...]}`, with at least
one commit string and no more than I2's maximum page size. Duplicates in the
request are ignored: each commit appears at most once in the response.

```json
{
  "results": {
    "abc": {"value": "abc", "ordinal": 42, "tag": null, "delete_after_inactive_days": null, "fields": {"git_sha": "..."}},
    "def": {"value": "def", "ordinal": null, "tag": null, "delete_after_inactive_days": 30, "fields": {}}
  },
  "not_found": ["unknown"]
}
```

`results` maps each commit string that was found to its commit object
(`{value, ordinal, tag, delete_after_inactive_days, fields}`), without the
`previous` and `next` the detail response adds. Strings that match no commit
are listed in `not_found`, including ones no commit could ever have, such as a
string longer than the column holds. A string containing a NUL character is the
exception: it is rejected with 400 (see D5).

Not paginated: the response is bounded by the size of the request.


## E4: Runs

```
GET    /api/projects/{project}/suites/{suite}/runs                         -- List (cursor-paginated, searchable, filterable by machine=, commit=, submitted_after=, submitted_before=, measured_after=, measured_before=, has_profiles=; sortable by sort=)
POST   /api/projects/{project}/suites/{suite}/runs                         -- Submit run (accepts optional client UUID or generates one, returns it)
GET    /api/projects/{project}/suites/{suite}/runs/{uuid}                  -- Detail
DELETE /api/projects/{project}/suites/{suite}/runs/{uuid}                  -- Delete run
```

**Auth scope:** `read` for GET, `submit` for POST, `manage` for DELETE.

**Run object:** `uuid`, `machine` (the machine's name), `commit` (the commit's
identity string), `submitted_at`, `measured_at`, and `run_parameters`.
`submitted_at` is when this instance accepted the run, and `measured_at` when
its data was measured (see D5). `run_parameters` is the free-form blob the
submission supplied, or `{}` if it supplied none. It
appears in the detail response only, because it is unbounded and no list view
displays it -- the same reason a regression's `notes` is detail-only.

```json
{
  "uuid": "573af861-8303-4a5b-a643-b8321e0142c4",
  "machine": "linux-x86_64",
  "commit": "014621ede7c1",
  "submitted_at": "2026-08-25T14:22:41Z",
  "measured_at": "2026-08-25T14:02:17Z",
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
| `POST /runs` | 201 with the created run in its detail form, and a `Location` header pointing at its detail route | 400 for an undeclared key in `machine.fields` or `commit.fields`, or an undeclared metric in a test's `samples`; 409 `duplicate` for a UUID a run already has (see O1); 409 `conflict` for metadata that contradicts what is stored, including a contradicted `ordinal` (see O2), or for an `ordinal` already held by another commit (see O6); 409 `retry` if the machine or the commit was deleted while the run was being stored (see O8) |
| `DELETE /runs/{uuid}` | 204 | |

**Filters:**

- `search=`: matches the run's machine or commit, as the machine and commit
  lists' `search=` match them, or a prefix of the run's `uuid` (see O4).
- `machine=`, `commit=` (see I3).
- `submitted_after=`, `submitted_before=`, `measured_after=`,
  `measured_before=`: exclusive bounds on `submitted_at` and `measured_at` (see
  I3).
- `has_profiles=`: boolean. `true` returns only runs with at least one profile
  attached, and `false` only runs without profiles.

**Sort:** `sort=submitted_at` and `sort=measured_at` return oldest first, and
`sort=-submitted_at` and `sort=-measured_at` newest first. Without `sort`,
results come in an arbitrary but deterministic order suitable for pagination
(see I2).


## E5: Tests

```
GET    /api/projects/{project}/suites/{suite}/tests                        -- List (cursor-paginated, filterable)
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
GET    /api/projects/{project}/suites/{suite}/runs/{uuid}/samples   -- Samples for a run (cursor-paginated, filterable by test=)
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

Profiles store hardware performance counter data at the instruction level. Each
profile has a server-generated UUID, which identifies it in the profile data
endpoints. The per-run list endpoint maps human-readable run and test
coordinates to those UUIDs.

Profiles are submitted within the run submission (see O1 and O7). There is no
separate upload endpoint. Every counter these endpoints return is a raw count
(see O7).

**Auth scope:** `read` for every route in this section.

### Listing (per run)

```
GET  /api/projects/{project}/suites/{suite}/runs/{uuid}/profiles              -- List profiles for a run
```

Returns `{test, uuid}` objects for all the profiles attached to the run,
ordered by test name, in I2's unpaginated envelope (the list is bounded by the
tests of one run).

### Profile Data (by UUID)

```
GET  /api/projects/{project}/suites/{suite}/profiles/{uuid}                       -- Metadata + top-level counters
GET  /api/projects/{project}/suites/{suite}/profiles/{uuid}/functions             -- Function list with counters
GET  /api/projects/{project}/suites/{suite}/profiles/{uuid}/disassembly           -- Disassembly + per-instruction counters
GET  /api/projects/{project}/suites/{suite}/profiles/{uuid}/document              -- The whole profile, as one profile document
```

**Metadata** (`GET /api/projects/{project}/suites/{suite}/profiles/{uuid}`):
`uuid`, `test` (the test's name), `run_uuid`, `counters` (counter name to
integer: the profile's top-level counters), and `disassembly_format` (string).

**Functions**
(`GET /api/projects/{project}/suites/{suite}/profiles/{uuid}/functions`): I2's
unpaginated envelope over `{name, counters, length}` objects. `counters` maps
each counter that at least one of the function's instructions has to a number:
the function's counter, summed over the instructions that have it (see O7).
`length` is the function's number of instructions. Sorted by name, in ascending
code-point order. How hot a function is depends on which counter the user picks,
so the client sorts by that itself (see PF4).

**Disassembly**
(`GET /api/projects/{project}/suites/{suite}/profiles/{uuid}/disassembly?function={name}`):

- `function` is required, and is the function's name as given in the functions
  response. It is a query parameter because a name can contain `/` (see I1). A
  name the profile does not contain is a 404.
- Returns `name`, `counters` (the function's counters, as in the functions
  response), `disassembly_format`, and `instructions`: an array of
  `{address, counters, text}`, one per instruction, in the order the profile
  document listed them. `address` is an integer, and `counters` maps each
  counter the instruction was submitted with to a number.

**Document**
(`GET /api/projects/{project}/suites/{suite}/profiles/{uuid}/document`): the
whole profile in one response, as the profile document defined in O7:
`disassembly_format`, the top-level `counters`, and `functions`, each with its
`name` and `instructions`.

- It is plain JSON, rather than the gzip-compressed, base64-encoded string a
  submission carries. Once compressed and encoded that way, it can be used as a
  test entry's `profile` to store the same profile, so that a profile can be
  copied to another run or instance without one request per function. The
  server's encoding of it may be larger than the submitted one, so a profile
  submitted close to O7's size limits may exceed them when read back.
- It contains only what a profile document contains, so the functions' derived
  counters and lengths are absent.
- `functions` are in the order of the functions response, not necessarily the
  order they were submitted in. Each function's `instructions` are in the order
  the disassembly response gives them.


## E8: Regressions

```
GET    /api/projects/{project}/suites/{suite}/regressions                              -- List (cursor-paginated, searchable, filterable by state=, machine=, test=, metric=, commit=, has_commit=; sortable by sort=)
POST   /api/projects/{project}/suites/{suite}/regressions                              -- Create (accepts uuid, title, bug, notes, state, commit, indicators)
GET    /api/projects/{project}/suites/{suite}/regressions/{uuid}                       -- Detail (indicators embedded)
PATCH  /api/projects/{project}/suites/{suite}/regressions/{uuid}                       -- Update title, bug, notes, state, commit
DELETE /api/projects/{project}/suites/{suite}/regressions/{uuid}                       -- Delete (cascades indicators)
POST   /api/projects/{project}/suites/{suite}/regressions/{uuid}/indicators            -- Add indicator(s) (batch)
DELETE /api/projects/{project}/suites/{suite}/regressions/{uuid}/indicators            -- Remove indicator(s) (batch, UUIDs in body)
POST   /api/projects/{project}/suites/{suite}/regressions/indicators/query             -- Look up indicators across regressions (cursor-paginated, filterable by machine, test, metric, state, commit)
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

**Updating.** `PATCH` accepts `title`, `bug`, `notes`, `state`, and `commit`. An
omitted key is left unchanged, and sending `title`, `bug`, `notes`, or `commit`
as `null` clears a previously set value -- the same convention as
`PATCH /api/projects/{project}/suites/{suite}/commits/{value}`. `state` is not
nullable, so `state: null` is rejected with 400. `commit` is resolved by value,
with 404 if no commit has that value. `PATCH` does not touch indicators, which
are managed through the indicator routes below.

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
  `GET /api/projects/{project}/suites/{suite}/tests`.
- `commit=` and `has_commit=`.

An unknown machine or test is 404, an unknown metric is 400, and an unknown
`commit=` gives an empty result (see I3).

**Sort:** `sort=created_at` returns oldest first, and `sort=-created_at` newest
first. Without `sort`, results come in an arbitrary but deterministic order
suitable for pagination (see I2 and O5).

### Adding indicators

`POST /api/projects/{project}/suites/{suite}/regressions/{uuid}/indicators`

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

`DELETE /api/projects/{project}/suites/{suite}/regressions/{uuid}/indicators`

- The body is `{"indicator_uuids": ["...", "..."]}`, bounded like the add
  request. UUIDs are matched case-insensitively.
- Returns 200 with `{"removed": N, "indicators": [...]}`, like the add
  response.
- A UUID that names no indicator of this regression is ignored rather than a
  404, so that retrying a removal is not an error. An indicator of another
  regression is never removed.

### Looking up indicators across regressions

`POST /api/projects/{project}/suites/{suite}/regressions/indicators/query` lists
indicators across every regression of the suite. A client holding many (machine,
test, metric) combinations can learn which regressions cover which of them
without one request per combination -- for the Graph page's regression
annotations (GR15), or for a detector checking whether what it found is already
tracked (O3). It is a `read`-scoped POST because its lists of names, which may
be long and whose names may contain any character, do not fit in a query string.

- The body is `{machine, test, metric, state, commit, limit, cursor}`, and
  every key is optional. `machine`, `test` and `state` are lists of names, each
  no longer than I2's maximum page size. `metric` and `commit` are single
  names.
- An indicator is returned when its machine, test and metric are each among
  those named, its regression is in one of the named states, and its regression
  is attributed to the named commit. An omitted key does not filter at all,
  whereas an empty list matches nothing.
- An unknown machine or test is 404, an unknown metric is 400, and an unknown
  commit gives an empty result (see I3). An unknown state name is 400, as for
  the list.
- Returns I2's cursor envelope over `{uuid, regression_uuid, machine, test,
  metric}`: the indicator as the detail response gives it, plus the UUID of the
  regression it belongs to.
- Sort: none. Results come in an arbitrary but deterministic order suitable for
  pagination (see I2 and O5).


## E9: Time Series

### Series

```
GET    /api/projects/{project}/suites/{suite}/series
```

Returns the values of one metric on one machine: its whole time series, for
tools that analyse it, or the part of it the filters below select, such as one
test's values to chart. It is a streaming endpoint (see I2): the whole result
comes in one response.

**Auth scope:** `read`.

**Query parameters:**

- `metric` (required): the metric to return values for. Only the samples that
  have a value for it are returned. 400 if the suite's schema does not declare
  it.
- `machine` (required): the name of the machine. 404 if it does not exist.
- `test`: only the samples of these tests, repeated for several (see I3). 404
  if one of them does not exist. Each name lengthens the URL, which proxies
  limit to a few kilobytes, so only a few dozen fit; a client that needs more
  reads the machine's whole series.
- `commit`: only the samples of runs at this commit. An unknown commit gives
  an empty result. It cannot be combined with `after_commit` or
  `before_commit` (400).
- `after_commit`, `before_commit`: only the samples at commits strictly after,
  or strictly before, the named commit, by ordinal. Commits without an ordinal
  are left out. An unknown commit is 404, and one that has no ordinal is 400.
- `submitted_after`, `submitted_before`, `measured_after`, `measured_before`:
  exclusive bounds on the `submitted_at` and `measured_at` of the run a sample
  belongs to. Each is an ISO 8601 timestamp (see D3), read as UTC if it has no
  offset.
- `has_ordinal`: boolean. `true` returns only the samples at commits with an
  ordinal, and `false` only those at commits without one. Without it, both are
  returned. As on the commit list (see E3), a commit bound leaves out the
  commits without an ordinal by itself, so combining one with
  `has_ordinal=false` returns nothing.

**Response:** 200, with one line per sample (see I2). Each line is a JSON
object with these keys:

- `test`, `machine`: the names of the sample's test and machine.
- `metric`: the name of the metric, the one the request names, so that each
  line stands on its own.
- `value`: the sample's value for the metric, never null, in the JSON
  representation of the metric's type (see D3).
- `commit`: the commit of the sample's run, by value.
- `ordinal`, `tag`: that commit's ordinal and tag, or null where it has none.
- `run_uuid`: the UUID of the sample's run.
- `submitted_at`, `measured_at`: the run's timestamps (see D5).

The errors above are all found before the response starts.

**Order:** by test name, by code point; then by commit ordinal, with the
commits that have none after the others, by commit value; then by run UUID.
The repetitions of a test within a run are adjacent, in an unspecified order.
The same data is always served in the same order.

**Promptness:** the samples are read and sent a batch of tests at a time, so
the time between two bytes depends on how long one batch takes to read, not on
the size of the series.

**Consistency:** each test's samples are read at a single point in time, but
different tests may be read at different times: a run submitted or deleted
while the response is sent, or an ordinal changed, may show up for some tests
and not for others. `submitted_before` bounds what can appear. Since a run's
`submitted_at` is taken when it starts being stored (D5), a request meant to
be repeatable uses a time a few minutes in the past.

**Interrupted responses:** besides any failure, the server aborts the response
(see I2) when a change would otherwise leave the rest of it silently empty: the
machine being deleted, or a schema change (possibly of another suite). The
client then requests it again.

### Trends (Aggregated)

```
GET    /api/projects/{project}/suites/{suite}/trends
```

Returns one aggregated value per machine and commit.

**Auth scope:** `read`.

**Query parameters:**

- `metric` (required): must be numeric (see D3). A non-numeric metric is
  rejected with 400.
- `machine` (required): one or more machine names, repeated (see I3), so that
  several machines' data can be fetched in one call -- unlike the series,
  which takes a single machine. It is required so that no request aggregates
  the whole suite at once. An unknown name is 404. A machine named
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
- `measured_at`: the latest `measured_at` among the runs the value covers
- `tag`: the commit's tag, or null if unset
- `value`: the geomean of the run geomeans (see O9) of the runs at that machine
  and commit, for `metric` under `sample_agg`. It is a real number even for an
  `integer` metric.

A (machine, commit) with no run geomean is absent from the response. Unlike a
line of the series, an item does not repeat `metric`.


## E10: Test Suites

```
GET    /api/projects/{project}/suites                -- List the project's test suites
POST   /api/projects/{project}/suites                -- Create a test suite in the project from a schema definition
GET    /api/projects/{project}/suites/{suite}        -- Detail
PATCH  /api/projects/{project}/suites/{suite}        -- Rename, or move to another project
PATCH  /api/projects/{project}/suites/{suite}/schema -- Add, update, or remove metrics and fields; change the display name or the repository
DELETE /api/projects/{project}/suites/{suite}        -- Delete a test suite and all its data
```

Every suite belongs to a project (see D7). `GET /api/projects` lists every suite
of the instance along with its project (see E13).

**Auth scope:** `read` for GET, `manage` for POST, PATCH and DELETE. POST
addresses the project, so a restricted key must cover the project in full. The
other writes address the suite, and a move needs the destination project covered
in full as well (see I5).

**Suite object:** a suite's detail body is its normalized schema: the body
`POST /api/projects/{project}/suites` accepts, with omitted optional keys filled
in (see D4 for the format and its normalization). Request and response are
therefore the same document, and a suite fetched from one instance or project
can be posted unchanged to another (see D4). There are no separate schema or
metric-metadata endpoints.

**List** (`GET /api/projects/{project}/suites`): the same objects, in I2's
unpaginated envelope, ordered by `name` ascending. A project with no suites
gives an empty list.

**Create** (`POST /api/projects/{project}/suites`): the body is the schema
itself: `name`, `display_name`, `metrics`, `commit_fields`, `machine_fields`,
`repository` (see D4).

- 201 with the created suite's detail body, and a `Location` header pointing at
  `GET /api/projects/{project}/suites/{name}`.
- 400 if the schema fails validation (see D4).
- 409 `duplicate` if the project already has a suite with that name.
- 409 `retry` if the creation could not take the locks it needs.

**Rename or move** (`PATCH /api/projects/{project}/suites/{suite}`): the body
has `name`, the suite's new name, and `project`, the name of the project to move
it to. Both are optional, and an omitted key is left unchanged; neither can be
`null`. A `project` other than the suite's own moves the suite. A body that
changes neither, an empty one included, is a successful no-op. Renaming and
moving change only names (see D7).

- 200 with the suite's detail body, under its new name.
- 400 if `name` or `project` is `null`, or `name` is not a valid suite name (see
  D4).
- 403 if the request moves the suite with a restricted key that does not cover
  the destination project in full, whether that project exists or not (see I5).
- 404 if `project` names no project.
- 409 `duplicate` if the project the suite ends up in already has another suite
  with its new name.
- 409 `retry` if the change could not take the locks it needs.

**Evolve** (`PATCH /api/projects/{project}/suites/{suite}/schema`): changes the
suite's `display_name`, `metrics`, `commit_fields`, `machine_fields` and/or
`repository` after creation. D2 gives the semantics; this is the wire format.

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

The body may also supply `display_name`, a string or `null`, and `repository`,
with only the keys being changed, `null` clearing one:

```json
{"display_name": "LLVM test-suite", "repository": {"commit_url": "https://github.com/llvm/llvm-project/commit/{commit}", "label": null}}
```

Because `remove` destroys data, a request with a non-empty `remove` list
requires `?confirm=true`. Without it, or with `confirm=false`, the request is
rejected with 400. An empty `remove` list requires nothing, and neither does a
change to `display_name` or `repository`. This mirrors
`DELETE /api/projects/{project}/suites/{suite}`.

- 200 with the suite's detail body. A request that asks for no change is a
  successful no-op.
- 400 if `update` tries to change a `type`, if `confirm=true` is required but
  missing, or if the resulting schema fails validation (see D3, D4, and D5).
  Validation covers the whole resulting schema, not just the entries the
  request touched.
- 404 if `update` or `remove` names an entry that is not in that list.
- 409 `duplicate` if `add` names an entry that already exists in that list.
- 409 `retry` if the change could not take the locks it needs.

**Delete** (`DELETE /api/projects/{project}/suites/{suite}`): permanently
deletes the suite and all of its data (machines, runs, commits, samples,
regressions), and removes it from the API keys that list it (see I5). Requires
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

**Key object:** `prefix`, `name`, `scope`, `restricted_to`, `created_at`,
`last_used_at`, `is_active`. `restricted_to` is null for an instance-wide key,
and otherwise the list of the entries the key is restricted to (see I5): each is
`{"project": "swift"}` for a whole project, or
`{"project": "swift", "suite": "benchmarks"}` for a single suite, under the
current names of what it lists. Entries are ordered by project name, a whole
project before the suites of that project, then by suite name. The list is empty
once every project and suite it listed has been deleted. `last_used_at` is null
until the key is first used, and approximate after that (see D5). Neither the
raw token nor its hash ever appears, except for the raw token in the create
response below.

**List** (`GET /api/admin/api-keys`): key objects in I2's unpaginated envelope,
newest first (`created_at` descending), with `prefix` as a tiebreaker. Since
`created_at` never changes, this order is stable across requests. Ordering by
`last_used_at` is deliberately avoided, because that column is mutable,
nullable, and only approximate (see D5). Revoked keys are included, with
`is_active: false`.

**Create** (`POST /api/admin/api-keys`): the body has `name` (string, required),
`scope` (string, required: one of `read`, `submit`, `triage`, `manage`,
`admin`), and `restricted_to` (optional: a non-empty list of entries, as in the
key object, to restrict the key to them, or null). An omitted or null
`restricted_to` makes the key instance-wide.

- 201 with the key object plus a `token` field holding the raw token. The token
  is shown only this once and cannot be retrieved afterwards (see I5). No
  `Location` header is set: there is deliberately no per-key detail route.
- 400 if `name` is missing, empty, or longer than 256 characters (see D5), or
  if `scope` is missing or not one of the five values. `name` is a label rather
  than an identifier, so two keys may share one.
- 400 if `restricted_to` is an empty list, has an entry without `project` or
  with a key other than `project` and `suite`, holds a name that is not a valid
  project or suite name (see D4 and D7) or a `null` one (a whole project is
  written without `suite`), lists an entry more than once, lists a suite along
  with its whole project, or is a list on a `read` or `admin` key, which cannot
  be restricted (see I5). These are checked on creation only: a move can later
  leave a key listing a suite along with its new project (see I5).
- 404 if an entry names a project that does not exist, or a suite that its
  project does not have.

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
scope or restrictions means creating a replacement and revoking the original.
Keys do not expire.

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
client to check a token: whether it is usable, which scope it grants, and where.


## E13: Projects

```
GET    /api/projects              -- List projects, each with its test suites
POST   /api/projects              -- Create a project
GET    /api/projects/{project}    -- Detail
PATCH  /api/projects/{project}    -- Change the display name, or rename
DELETE /api/projects/{project}    -- Delete a project that has no suites
```

A project groups test suites (see D7), which are managed through E10.

**Auth scope:** `read` for GET, `manage` for POST, PATCH and DELETE. Creating,
renaming and deleting a project require an instance-wide key, and changing a
project's display name a key that covers the project in full (see I5).

**Project object:** `name` and `display_name` (see D7), and `suites`: the
project's suites, as E10's suite objects, ordered by name. List and detail
responses return the same object.

```json
{"name": "libcxx", "display_name": "libc++", "suites": [{"name": "benchmarks", "display_name": null, "metrics": [...], ...}]}
```

**List** (`GET /api/projects`): the project objects, in I2's unpaginated
envelope, ordered by `name` ascending, those without suites included.

**Create** (`POST /api/projects`): the body has `name` (required) and
`display_name` (optional, `null` when omitted).

- 201 with the created project, and a `Location` header pointing at
  `GET /api/projects/{name}`.
- 400 if `name` is missing or not a valid project name, or `display_name` is
  empty or too long (see D7).
- 409 `duplicate` if a project with that name already exists.

**Update** (`PATCH /api/projects/{project}`): the body has `name` and
`display_name`, both optional. An omitted key is left unchanged, and
`display_name: null` clears the display name. A `name` other than the project's
own renames it (see D7). A body that changes nothing, an empty one included, is
a successful no-op.

- 200 with the project.
- 400 if `name` is `null` or not a valid project name, or `display_name` is
  empty or too long (see D7).
- 403 if the request renames the project with a restricted key, even one that
  covers the project in full (see I5).
- 409 `duplicate` if another project has the new name.
- 409 `retry` if the change could not take the locks it needs.

**Delete** (`DELETE /api/projects/{project}`): deletes a project that has no
suites, and removes it from the API keys that list it (see I5). Since it
destroys no data, it does not require `?confirm=true`.

- 204 on success.
- 409 `conflict` if the project has suites.
- 409 `retry` if the deletion could not take the locks it needs.
