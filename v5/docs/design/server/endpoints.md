# v5 REST API: Endpoints

This document specifies all entity endpoints in the v5 REST API.


## Discovery

```
GET    /api                       -- API index: links to the suite list and API documentation
GET    /api/openapi.json          -- OpenAPI 3.x specification for this instance
GET    /api/docs                  -- Interactive API documentation viewer
```

Response is `{"links": {...}}`, where `links` holds `suites` (path to the test
suite list), `openapi` (path to the OpenAPI JSON spec) and `docs` (path to the
interactive API documentation viewer). The index does not enumerate suites
itself -- `GET /api/suites` is the canonical suite list.

Auth scope: `read` for the index. The two documentation routes sit outside the
scope system entirely and never authenticate (see R5 and R8).


## Machines

```
GET    /api/suites/{testsuite}/machines                     -- List (searchable, offset-paginated)
POST   /api/suites/{testsuite}/machines                     -- Create machine independently
GET    /api/suites/{testsuite}/machines/{machine_name}      -- Detail
PATCH  /api/suites/{testsuite}/machines/{machine_name}      -- Update fields/tracked (including rename)
DELETE /api/suites/{testsuite}/machines/{machine_name}      -- Delete machine, its runs, and its regression indicators
GET    /api/suites/{testsuite}/machines/{machine_name}/runs -- List runs for this machine (cursor-paginated)
```

Machines are also created implicitly if a run is submitted for a nonexistent machine
(see D7).

**Machine object**: `POST` and `PATCH` take the same entity object that a run
submission nests under `machine` (see D6): `name` (identity), `tracked`
(built-in attribute), and `fields` (declared `machine_fields`). Responses use
the same shape, in the list and the detail alike, plus a read-only `last_run_at`
(see Sort below). On `PATCH`, supplying `name` renames the machine, and omitting
any key leaves it unchanged -- inside `fields` as well as beside it, so a caller
that knows one field can send that field alone. An explicit `null` inside `fields`
clears a stored value, the same convention as
`PATCH /api/suites/{testsuite}/commits/{value}`; `name` and `tracked` are not
nullable, so sending either as `null` is rejected with 400. Keys in `fields` must
be declared in the suite's schema; an undeclared key is rejected with 400 (see D7).

`POST` returns 201 with the created machine and a `Location` header pointing at
`GET /api/suites/{testsuite}/machines/{machine_name}`; `PATCH` returns 200 with the
same body; `DELETE` returns 204. Both `POST` and a `PATCH` that renames return 409
`duplicate` if a machine of that name already exists. Every route in this section
returns 404 if the suite does not exist, and every route that addresses a machine
returns 404 if no machine in the suite has that name. Unlike the destructive suite
operations, `DELETE` requires no `?confirm=true`.

`DELETE` removes the machine, its runs (and their samples and profiles), and
every regression indicator naming it (see D5). Regressions left with no
indicators are kept.

Auth scopes: `read` for GET, `manage` for POST/PATCH/DELETE.

Filters: `search=` (case-insensitive substring match on `name` or any
searchable machine_field; see D9), `tracked=` (boolean; omitting it returns
both tracked and untracked machines).

Sort: `sort=name` (the default, ascending), `-name`, `last_run_at`, and
`-last_run_at`. `last_run_at` is the `submitted_at` of the machine's most recent
run, or null for a machine with no runs; it is derived rather than stored (see
D5). Machines with no runs sort after every machine that has one, in both
directions, and ties are broken by `name` ascending regardless of the primary
direction, so that a page boundary is reproducible. This sort is used by the
Dashboard for picking which trendlines to query.

**`tracked`** (boolean, see D5) appears in machine list and detail responses.
`POST` accepts it at creation and `PATCH` can flip it at any time; it defaults
to `true` when omitted. Run submission may also set it at creation time (see D6).
Untracked machines are excluded only from *automatic* machine selection and are
otherwise returned by every endpoint like any other machine.

`GET /api/suites/{testsuite}/machines/{machine_name}/runs` returns run objects
(see Runs). Filters: `after=`/`before=`
(submitted_at; exclusive), same convention as `GET /api/suites/{testsuite}/runs`.
Sort: `sort=submitted_at` returns oldest-first and `sort=-submitted_at`
newest-first; omitting `sort` returns results in an arbitrary but deterministic
order suitable for pagination (see R2).


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
use the same shape. `value` is immutable -- commits cannot be renamed, and
sending it to `PATCH` is rejected with 400 rather than ignored, unlike
`PATCH /api/suites/{testsuite}/machines/{machine_name}`, where `name` renames.
For the same reason -- a key that could not take effect is refused rather than
dropped -- `tag` sent to `POST` is rejected with 400, since D7 makes it
settable only by `PATCH`. Keys in `fields` must be declared in the suite's
schema; an undeclared key is rejected with 400 (see D7).

The detail response adds `previous` and `next`: the commit objects with the
nearest lower and nearest higher `ordinal`, each without its own
`previous`/`next`. Commits with no ordinal are skipped as neighbours; both keys
are `null` at either end of the ordered range, and on a commit whose own
`ordinal` is unset.

`POST` returns 201 with the created commit's detail body and a `Location` header
pointing at `GET /api/suites/{testsuite}/commits/{value}`; `PATCH` returns 200
with the same body; `DELETE` returns 204. `POST` returns 409 `duplicate` if a
commit with that value already exists, and both `POST` and `PATCH` return 409
`ordinal_conflict` if the ordinal they set is already held by another commit
(see D11 and R4). `DELETE` returns 409 `in_use` if a regression references the
commit; otherwise it removes the commit, its runs, and their samples and
profiles (see D5). Every route in this section returns 404 if the suite does not
exist, and every route that addresses a commit returns 404 if no commit in the
suite has that value. Unlike the destructive suite operations, `DELETE` requires
no `?confirm=true`.

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
`{"commits": ["abc", "def", ...]}` (at least one commit string, and no more than
R2's maximum page size) and returns each found commit's summary in a dict keyed
by commit string:

```json
{
  "results": {
    "abc": {"value": "abc", "ordinal": 42, "tag": null, "fields": {"git_sha": "..."}},
    "def": {"value": "def", "ordinal": null, "tag": null, "fields": {}}
  },
  "not_found": ["unknown"]
}
```

Each value in `results` is a commit object (`{value, ordinal, tag, fields}`),
without the `previous`/`next` that the detail endpoint adds. Commit strings not
found in the database are returned in a separate `not_found` list -- including
ones no commit could possibly have, such as a string longer than the column
holds, since a lookup for something absent is what `not_found` reports.
Duplicates in the request are deduplicated; each commit appears at most once in
the response.

Auth scope: `read`. Not paginated (response is bounded by request size).


## Runs

```
GET    /api/suites/{testsuite}/runs                         -- List (cursor-paginated, searchable, filterable by machine=, commit=, after=, before=, has_profiles=; sortable by sort=)
POST   /api/suites/{testsuite}/runs                         -- Submit run (accepts optional client UUID or generates one, returns it)
GET    /api/suites/{testsuite}/runs/{uuid}                  -- Detail
DELETE /api/suites/{testsuite}/runs/{uuid}                  -- Delete run
```

**Run object**: `uuid`, `machine` (the machine's name), `commit` (the commit's
identity string), `submitted_at`, and `run_parameters`. `run_parameters` is the
free-form blob the submission supplied, `{}` when it supplied none, and appears
in the detail response only -- it is unbounded and no list view renders it, the
same reason a regression's `notes` is detail-only.

```json
{
  "uuid": "573af861-8303-4a5b-a643-b8321e0142c4",
  "machine": "linux-x86_64",
  "commit": "014621ede7c1",
  "submitted_at": "2026-08-25T14:22:41Z",
  "run_parameters": {"build_config": "Release"}
}
```

A client that wants a commit's display value for a column of runs resolves the
page's commits in one batch through `POST /commits/resolve`, rather than the
server embedding a field whose meaning is purely a UI concern (see D4).

`submitted_at` is recorded by the server when it accepts the run and can never
be supplied by the submission (see D6). It comes from the database's clock rather
than from the worker's, so runs stored by different workers carry comparable
timestamps and every row one submission writes carries the same instant. What it
does *not* provide is an order by commit time: the value is taken when the
storing transaction begins, so a submission that commits later can carry the
earlier timestamp. It records when a submission was accepted, not the sequence in
which runs became visible.

Run lists and the detail return the same object, minus `run_parameters` in
lists. `POST` returns 201 with the created run in its detail form and a
`Location` header pointing at `GET /api/suites/{testsuite}/runs/{uuid}` for the
UUID the run ended up with -- the client's, normalized, or the one the server
generated. `DELETE` returns 204.

The UUID is either provided by the client in the submission body or generated
server-side (UUID v4) when omitted. Client-provided UUIDs must be in standard
`8-4-4-4-12` hyphenated hex format and are normalized to lowercase. If a run
with the same UUID already exists, the server returns 409 `duplicate` (see R4),
which a submitting bot recovers from by retrying with a fresh UUID. The
submission endpoint requires JSON format with `format_version '5'`. Legacy
formats (v0, v1, v2) and non-JSON payloads are rejected. There is no
`on_existing_run` parameter -- v5 always creates a new run (multiple runs per
machine+commit are allowed). Deleting a run cascades to its samples and
profiles; the tests those samples named are left behind, since nothing deletes a
test (see D5).

The `{uuid}` in a path is matched against the stored, lowercased form, so it is
accepted in either case. Every route in this section returns 404 if the suite
does not exist, and every route that addresses a run returns 404 if no run in
the suite has that UUID -- including when the path segment is not a well-formed
UUID at all, which names no run rather than being a malformed request. Unlike
the destructive suite operations, `DELETE` requires no `?confirm=true`.

A submission is atomic (see D13): it either stores the run together with
everything it creates -- its machine, its commit, its tests, its samples and its
profiles -- or it changes nothing at all.

The machine and the commit a submission names are created if they do not exist
(see D7). If the machine already exists with `machine.fields` values that differ
from what's submitted, the submission is rejected with 409 `conflict`. Only keys
present in the submission are compared, and the built-in `tracked` attribute is
excluded from the comparison (see D7). Keys in `machine.fields` that are not
declared as `machine_fields` are rejected with 400 rather than stored; the same
holds for `commit.fields`.

If the submission supplies `commit.ordinal`, it is rejected with 409
`ordinal_conflict` when the commit already has a different ordinal, or when that
ordinal is already held by a different commit (see D11 and R4).

A profile the submission carries but the server will not accept is 400
`invalid_request`: data that is not standard base64, a format version other than
the one D12 fixes, or a decoded blob over D5's 50 MB cap. That cap is on a single
profile, and one submission may legitimately carry many; a request *body* too
large for the deployment is a separate matter, refused at the transport layer
with 413 and not one of this endpoint's documented responses (see R4).

`machine=` keeps only the runs measured on that machine, and returns 404 if the
suite holds no machine of that name. `commit=` keeps only the runs belonging to
that commit, and a value no commit has is an empty page rather than an error --
R3 draws that asymmetry deliberately. `after=`/`before=` bound `submitted_at`,
both exclusive.

`has_profiles=` (boolean): `true` returns only runs that have at least one
profile attached; `false` returns only runs without profiles.

`search=` (case-insensitive substring match against the run's machine `name`
or any searchable machine_field; see D9) -- the same predicate as
`GET /api/suites/{testsuite}/machines?search=`, applied through the run's machine.

`sort=submitted_at` returns oldest-first and `sort=-submitted_at` newest-first;
omitting `sort` returns results in an arbitrary but deterministic order suitable
for pagination (see R2). Both directions, because R3's `-` prefix already spells
one from the other and a list that offered only the descending spelling would be
the sole exception to that convention; newest-first is merely the direction the
UI asks for. `submitted_at` is not unique -- nothing stops two runs being
accepted in the same instant -- so the server appends an internal tiebreaker to
it, as D10 requires of every cursor-paginated ordering.

Auth scopes: `read` for GET, `submit` for POST, `manage` for DELETE.


## Tests

```
GET    /api/suites/{testsuite}/tests                        -- List (cursor-paginated, filterable)
```

Read-only. Tests are created implicitly via run submission.

**Test object**: `name` -- an object rather than a bare string, so the list can
gain a key later.

A test name is the one natural key no path ever carries, because it legitimately
contains `/` (see R1). A request names a test in a `test=` query parameter, or in
a request body where one is already being sent -- `POST /query` and the
regression indicators do the latter.

Auth scope: `read`.

Filters: `search=` (case-insensitive substring match on test name; see D9), `machine=` (only tests with data
for this machine), `metric=` (only tests with non-NULL values for this metric).
An unknown `machine=` is 404 and an unknown `metric=` is 400, per R3. Given
together, the two describe one set of samples rather than two independent ones:
`?machine=m&metric=execution_time` returns the tests that have an
`execution_time` value *on that machine*.

Results come back in an arbitrary but deterministic order suitable for
pagination (R2, D10); this list takes no `sort`.


## Samples

Samples are always accessed through their parent run -- they have no external
identifier of their own.

```
GET    /api/suites/{testsuite}/runs/{uuid}/samples   -- Samples for a run (cursor-paginated, filterable by test=)
```

Read-only. Samples are created as part of run submission.

**Sample object**: `test` (the test's name) and `metrics`, a dict of metric name
to value holding only the metrics that have a value, typed per D3 (see R4):

```json
{"test": "test.suite/benchmark", "metrics": {"execution_time": 1.23, "compile_status": 0}}
```

A test measured repeatedly within one run yields one object per repetition (see
D6), and those repetitions are indistinguishable by design.

Filters: `test=` (only the samples for this test). A name the suite has no test
for is 404, the rule R3 gives every `test=` filter; a test that exists but that
this run did not measure is an empty page rather than an error, exactly as a
`machine=` naming a machine with no runs is.

**Why `test=` and not a path segment.** R1 keeps a test name out of every path,
because it legitimately contains `/` and no percent-encoding survives routing;
this is the endpoint where that bites. Earlier drafts specified
`GET /runs/{uuid}/tests/{test_name}/samples`, which can only ever address the
minority of test names with no slash in them. Folding the test into the run's own
sample list as a filter, rather than giving it a sibling route, keeps one way to
read a run's samples and one pagination contract: the filtered list is
cursor-paginated like the unfiltered one, and a client asking for a single test
gets its handful of repetitions in one page with a null `cursor.next`. An
unpaginated variant would buy that client nothing and would oblige every client
to handle two shapes of response for one kind of data.

Results come back in an arbitrary but deterministic order suitable for
pagination (R2, D10); this list takes no `sort`. In particular it is not ordered
by test name -- the client sorts and filters the table it renders (see the Run
Detail page in the client docs), and ordering by name on the server would cost a
sort of the whole run on every page.

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

Returns `{test, uuid}` objects for all profiles attached to the given run, in
R2's unpaginated envelope. Bounded by tests-per-run.

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
- R2's unpaginated envelope over `{name, counters, length}` objects, where
  `counters` is a dict of counter name -> float (the raw aggregated counter value
  for the function), `length` is instruction count. Sorted by total counter value
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

Regressions are identified by server-generated UUID, and so are their indicators.
The `{uuid}` in a path is matched against the stored, lowercased form, so it is
accepted in either case, the same convention as
`GET /api/suites/{testsuite}/runs/{uuid}`. Every route in this section returns 404
if the suite does not exist, and every route that addresses a regression returns
404 if no regression in the suite has that UUID -- including when the path segment
is not a well-formed UUID at all, which names no regression rather than being a
malformed request. Unlike the destructive suite operations, `DELETE` requires no
`?confirm=true`.

Filters: `search=` (case-insensitive substring match on `title`; see D9),
`state=` (a comma-separated list of state names, such as `?state=active,detected`;
a name that is not one of the five is rejected with 400), `machine=`, `test=`,
`metric=` (keep only regressions with an indicator naming it), `commit=` and
`has_commit=`. R3's three answers to a filter naming something absent all apply:
an unknown `machine=` or `test=` is 404, an unknown `metric=` is 400, and a
`commit=` value no commit has is an empty page. `machine=`, `test=` and `metric=`
given together describe *one* indicator rather than three independent ones --
`?machine=m&metric=execution_time` returns the regressions with an indicator
naming `execution_time` on that machine -- the same reading
`GET /api/suites/{testsuite}/tests` gives the same pair. Where a request gets
both an unknown `metric=` and an unknown `machine=`/`test=`, the 400 wins: a
metric the schema does not declare is a request that could never be answered,
whereas an absent machine is a fact about the suite. The same precedence applies
to a request body naming both. This list takes no `sort` and returns results in
an arbitrary but deterministic order suitable for pagination (R2, D10).

**Regression states** (string enum):
`detected`, `active`, `not_to_be_fixed`, `fixed`, `false_positive`

State transitions are unconstrained -- any state can be set to any other
state via PATCH.

**Create request body:**
- `title` (string, optional -- null when omitted. The server never invents one:
  D8 leaves it nothing to generate a title *from*, and `PATCH title: null` puts a
  titled regression back into that state anyway, so an untitled regression is an
  ordinary state and a client renders a placeholder for it -- see
  `client/details.md`)
- `bug` (string, optional -- URL to external bug tracker)
- `notes` (string, optional -- investigation findings, A/B results, etc.)
- `state` (string, optional -- default: `detected`)
- `commit` (string, optional -- suspected introduction commit, resolved by
  value; 404 if no commit with that value exists)
- `indicators` (array, optional -- list of `{machine, test, metric}` objects,
  all resolved by name; 404 if any referenced machine or test does not
  exist, 400 if `metric` is not a valid metric name for the suite). Duplicates
  within the list are stored once, and the list is bounded, both as on the add
  route below.

**Update request body** (`PATCH /api/suites/{testsuite}/regressions/{uuid}`):
accepts `title`, `bug`, `notes`, `state`, and `commit`. Sending `title: null`,
`bug: null`, `notes: null`, or `commit: null` explicitly clears a previously-set
value; omitting a field instead leaves it unchanged -- the same convention as
`PATCH /api/suites/{testsuite}/commits/{value}`. `state` is not nullable, so
`state: null` is rejected with 400; omitting it leaves the current state.
`commit` is resolved by value, with 404 if no commit with that value exists.
`PATCH` does not touch indicators, which are managed through the indicator
endpoints below.

**Detail response** (`GET /api/suites/{testsuite}/regressions/{uuid}`):
- `uuid`, `title`, `bug`, `notes`, `state`
- `commit` (commit identity string, or null)
- `indicators`: list of `{uuid, machine, test, metric}`, oldest first, so that a
  client rendering the table sees the same order twice running

An empty `indicators` list is a legal state and never means the regression is
gone: deleting a machine takes the indicators naming it and leaves the regression
(see D5).

**List response items** carry exactly: `uuid`, `title`, `bug`, `state`,
`commit`, `machine_count`, `test_count`. The `notes` field is included in detail
responses only, not in list. `machine_count` and `test_count` count the distinct
machines and tests across the regression's indicators, independent of any
`machine=` or `test=` filter on the request -- they describe the regression, not
the query.

`POST` returns 201 with the created regression's detail body and a `Location`
header pointing at its detail route; `PATCH` returns 200 with the same body;
`DELETE` returns 204.

**Indicator add request** (`POST /api/suites/{testsuite}/regressions/{uuid}/indicators`):
- Body: `{"indicators": [{machine, test, metric}, ...]}` -- at least one, and no
  more than R2's maximum page size, for the same reason `POST /commits/resolve`
  is bounded. Each object is one
  indicator, resolved the same way as `indicators` on create (404 if the
  machine or test does not exist, 400 for an invalid metric name).
  Duplicates (same regression+machine+test+metric) are silently ignored,
  whether the indicator is already stored or merely repeated within the list.
- Returns 200 with `{"added": N, "indicators": [...]}`, where `indicators` is
  the regression's full indicator list afterwards and `added` counts only those
  this request actually created. It is 200 rather than 201 because a request
  whose indicators all already exist creates nothing.

**Indicator remove request** (`DELETE /api/suites/{testsuite}/regressions/{uuid}/indicators`):
- Body: `{"indicator_uuids": ["...", "..."]}`, bounded like the add request
  above. Each UUID is matched case-insensitively, as one in a path segment is --
  a body and a path must agree about which indicator a UUID names
- Returns 200 with `{"removed": N, "indicators": [...]}`, mirroring the add
  response. A UUID naming no indicator on this regression is ignored rather than
  404, so a retried removal is not an error -- and so is one naming an indicator
  of a *different* regression, which is never removed by a request addressed to
  this one.


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

Returns cursor-paginated time-series data for graphing, in R2's cursor envelope.
Each data point carries: `test`, `machine`, `metric`, `value`, `commit`,
`ordinal`, `run_uuid`, `submitted_at`, `tag` (the commit's tag, or null if
unset). `metric` is echoed on every point even though the request names exactly
one, making each data point self-descriptive.

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

Returns geomean-aggregated trend data per (machine, commit), in R2's unpaginated
envelope -- the result set is bounded by (machines x last_n), typically < 5000
rows. Each item carries: `machine` (the machine's name), `commit` (the commit's
identity string), `ordinal` (always present, never null), `submitted_at` (latest
run submission time), `tag` (the commit's tag, or null if unset), and `value`
(the geomean). `metric` is not echoed per item, unlike a query point.

Geomean is computed in SQL: `exp(avg(ln(positive_values)))`, skipping
zero/negative values.

Auth scope: `read`.


## Test Suites

```
GET    /api/suites               -- List test suites defined on this instance
POST   /api/suites               -- Create a test suite from a schema definition
GET    /api/suites/{name}        -- Detail
PATCH  /api/suites/{name}/schema -- Add, update, or remove metrics and fields
DELETE /api/suites/{name}        -- Delete a test suite and all its data
```

Auth scopes: `read` for GET, `manage` for POST/PATCH/DELETE.

**Suite object**: a suite's detail body is its normalized schema -- the body
`POST /api/suites` accepts, with omitted optional keys filled in (see D4 for the
format, D5 for normalization). Request and response are therefore the same
document, and a suite fetched from one instance can be posted verbatim to
another. There are no standalone schema or metric-metadata endpoints.

`GET /api/suites` returns those same objects in R2's unpaginated envelope,
schemas included rather than names alone: suites are limited in number and
parts of the client need every suite's metric list up front. Suites are ordered by
`name` ascending, which is stable across requests because a suite cannot be renamed.

**Create** (`POST /api/suites`): the request body is the schema definition
itself -- `name`, `metrics`, `commit_fields`, `machine_fields` (see D4 in
data-model.md for the schema format). On success, returns 201 with the
created suite's detail body and a `Location` header pointing at
`GET /api/suites/{name}`. Returns 409 `duplicate` if a suite with that name already
exists, 400 if the schema definition fails validation (see D4), or 409 `conflict` if
suite creation otherwise fails after passing schema validation.

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
requires a `?confirm=true` query parameter; omitting it -- or sending it as false --
returns 400. An empty `remove` list requires nothing. This mirrors
`DELETE /api/suites/{name}`.

On success, returns 200 with the suite's detail body; a request that asks for no change
is a successful no-op. Returns 404 if the suite
does not exist, or if `update` or `remove` names an entry that is not in that
list. Returns 409 `duplicate` if `add` names an entry that already exists in that list,
and 409 `conflict` if the change could not take the locks it needs and should be retried.
Returns 400 if `update` attempts to change a `type`, if `confirm=true` is
required but missing, or if the resulting schema fails validation (see D3, D4,
and D5) -- validation runs against the whole resulting schema, not just the
entries the request touched.

**Delete** (`DELETE /api/suites/{name}`): permanently deletes the suite and
all of its data (machines, runs, commits, samples, regressions). Requires a
`?confirm=true` query parameter; omitting it -- or sending it as false -- returns 400.
Returns 404 if the suite does not exist, 409 `conflict` if the deletion could not take
the locks it needs and should be retried, and 204 on success.

Both this and `PATCH .../schema` resolve the suite before checking `confirm`, so an
unknown name is 404 whether or not `confirm=true` was supplied.


## Admin

Instance-level API key management, outside any test suite.

```
GET    /api/admin/api-keys           -- List keys
POST   /api/admin/api-keys           -- Create key, returns the raw token once
DELETE /api/admin/api-keys/{prefix}  -- Revoke key
```

Auth scope: `admin` for all three, including the GET -- the only GET endpoints
in the API requiring more than `read`, and so the only ones unauthenticated
access never reaches (see R5).

**Key fields**: `prefix`, `name`, `scope`, `created_at`, `last_used_at`,
`is_active`. `last_used_at` is null until the key is first used and approximate
thereafter (see D5). Neither the raw token nor its hash ever appears, except
for the raw token in the create response below.

**List** (`GET /api/admin/api-keys`): returns key objects in R2's unpaginated
envelope, ordered by `created_at` descending -- newest first -- with `prefix` as
a tiebreaker. `created_at` is immutable, so this order is stable across
requests. Ordering by `last_used_at` is deliberately avoided: that column is
mutable, nullable, and only approximate (see D5). Revoked keys are included, with
`is_active: false`.

**Create** (`POST /api/admin/api-keys`): body is `name` (string, required) and
`scope` (string, required -- one of `read`, `submit`, `triage`, `manage`,
`admin`). Returns 201 with the key's fields plus a `token` field carrying the
raw token, which is shown only this once and cannot be retrieved afterwards
(see R5). No `Location` header is set: there is deliberately no per-key detail
route, so the list is the only way to read a key back.

Returns 400 if `name` is missing, empty, or longer than 256 characters (see D5),
or if `scope` is missing or is not one of the five values. `name` is a
label rather than an identifier, so two keys may share one.

**Revoke** (`DELETE /api/admin/api-keys/{prefix}`): sets `is_active` to false
rather than deleting the row, so that the revocation stays visible and the
prefix is never reused by a later key. Returns 204 on success, 204 again if the
key was already revoked (revocation is idempotent), and 404 if no key has that
prefix -- including when a caller passes a whole token instead of its prefix.
Revocation takes effect immediately (see R5) and cannot be undone; restoring
access means creating a new key. No `?confirm=true` is required, unlike the
destructive suite operations above: revoking a key destroys no data.

A key is otherwise immutable: there is no PATCH route, and changing a key's
scope means creating a replacement and revoking the original. Keys do not
expire.

Any `admin` key may revoke any key, including the one authenticating the
request and the last remaining active `admin` key. There is deliberately no
special case for either, because an operator's ability to revoke a leaked key
must not depend on which key leaked. Recovering from revoking the last `admin`
key means creating one through the out-of-band interface described in R5, which
is also how an instance gets its first key.
