# v5 Database Layer: Operations

This document covers how data flows through the v5 database: submission, metadata
management, search, time-series queries, and ordinal management.


## D6: Submission Format

Runs are submitted as JSON via `POST /api/suites/{testsuite}/runs`.

Machine and Commit are each submitted as an entity object of the same shape:
the identity attribute, any built-in attributes, and a `fields` dict holding
the schema-declared metadata. Keeping declared metadata in its own namespace
means a field can never collide with an identity or built-in key, and makes the
object identical to the one the entity's own creation endpoint accepts (see D7).

```json
{
  "format_version": "5",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "machine": {
    "name": "my-machine",
    "tracked": true,
    "fields": {
      "hardware": "x86_64",
      "os": "linux"
    }
  },
  "commit": {
    "value": "abc123def456",
    "ordinal": 593922,
    "fields": {
      "git_sha": "abc123def456789...",
      "author": "Jane Doe",
      "commit_message": "Fix vectorizer regression"
    }
  },
  "run_parameters": {
    "build_config": "Release"
  },
  "tests": [
    {
      "name": "test.suite/benchmark",
      "execution_time": 1.23,
      "compile_time": 0.45,
      "profile": "<base64-encoded profile data>"
    }
  ]
}
```

- `format_version`: Required, must be `"5"`.
- `uuid`: Optional. Client-provided UUID for the run, in standard `8-4-4-4-12`
  hyphenated hex format (e.g., output of `uuidgen`). Case-insensitive on input;
  normalized to lowercase for storage. Any UUID version is accepted (v4, v5,
  v7, etc.) -- only the format is validated. If a run with the same UUID
  already exists in the test suite, the server returns 409 Conflict. If omitted,
  the server generates a random UUID v4.
- `machine`: Required object identifying the machine this run was measured on.
  - `name`: Required string. The machine's identity.
  - `fields`: Optional. Every key must be declared in the schema's
    `machine_fields`. See D7 for undeclared keys and for how metadata is
    reconciled when the machine already exists.
  - `tracked`: Optional boolean, a built-in attribute rather than a
    `machine_field`. Controls whether the machine participates in automatic
    machine selection. It applies only when the machine is created
    (first-write-wins) and defaults to `true` when omitted; submitting it for a
    machine that already exists is ignored. Use
    `PATCH /api/suites/{testsuite}/machines/{name}` to change it afterwards.
- `commit`: Required object identifying the commit this run belongs to.
  - `value`: Required string. The commit's identity.
  - `fields`: Optional. Every key must be declared in the schema's
    `commit_fields`. See D7 for undeclared keys and for how metadata is
    reconciled when the commit already exists.
  - `ordinal`: Optional integer, a built-in attribute rather than a
    `commit_field`. Places the commit in the suite's total order. It is set
    when the commit has no ordinal yet; when the commit already has a
    different one, the submission is rejected with 409. Use
    `PATCH /api/suites/{testsuite}/commits/{value}` to change an ordinal once
    set. Ordinals are unique within a suite, so a value already held by a
    different commit is also rejected with 409 (see D11).
  - A run submission never sets `tag`: it is an editorial label applied after
    the fact, not something a submitter knows in advance (see D5).
- `run_parameters`: Optional. Stored as JSONB on the Run. Run has no declared
  field list, so this is a free-form blob rather than a `fields` dict.
- `tests`: Required. Each entry has `name` plus metric values. Metric values
  may be scalars or arrays. An array value (e.g. `"execution_time": [0.1, 0.2]`)
  creates one Sample row per element. All arrays in a single test entry must
  have the same length; scalar values are repeated across the resulting rows.
  Metrics with null values must be omitted from the test entry (not sent as
  `"metric": null`); only include metrics that have actual values. An optional
  `profile` field may contain base64-encoded profile binary data; if present,
  a Profile row is created and linked to the run+test. `name` and `profile` are
  reserved keys within a test entry, so neither may be a metric name -- this is
  enforced when the schema is created rather than at submission (see D5), so a
  suite can never hold a metric that no submission could populate.


## D7: Machine and Commit Metadata Population

Machine and Commit are the two entities that carry schema-declared metadata
(`machine_fields` and `commit_fields`, see D4) and that a run submission may
create implicitly. Both are represented by an entity object of the same shape
-- identity attribute, built-in attributes, and a `fields` dict of declared
metadata -- and that same object is what every write path accepts:

1. **Inline during run submission**: the payload's `machine` and `commit`
   objects populate the record when it is first created. If the record already
   exists, its metadata is NOT overwritten, and the submitted values must match
   the stored ones (otherwise the submission is rejected).
2. **Explicit creation**: `POST /api/suites/{testsuite}/machines` and
   `POST /api/suites/{testsuite}/commits` take the same entity object, creating
   the record directly without a run.
3. **Via PATCH**: `PATCH /api/suites/{testsuite}/machines/{name}` and
   `PATCH /api/suites/{testsuite}/commits/{value}` set or update metadata at any
   time, overwriting existing values.

**Declared keys only**: on every path, each metadata key must be declared in
the suite's schema; an undeclared key is rejected with 400. Neither entity has
a catch-all blob, so the schema states exactly what may be stored on it.
Declaring a new field is a schema change (`PATCH /api/suites/{name}/schema`,
see D2), not something a submission can do implicitly.

**Matching on re-submission**: the match in path 1 considers only the keys
present in the submission. A key the submission omits is not compared, so its
stored value is left alone and can never cause a rejection. Submitters that
send different subsets of a record's metadata therefore coexist, and a field
introduced by a schema change does not break producers that do not send it yet.

Per-entity specifics:

| | Machine | Commit |
|---|---|---|
| Identity attribute | `name` | `value` |
| Declared metadata | `fields`, per `machine_fields` | `fields`, per `commit_fields` |
| Built-in mutable attributes | `tracked` | `ordinal`, `tag` |
| Settable during run submission | `tracked` (first-write-wins) | `ordinal` (must match if already set) |
| Settable at explicit creation | `tracked` | `ordinal` |
| Settable only via PATCH | -- | `tag` |
| Renameable via PATCH | yes | no |

Built-in mutable attributes sit beside the identity attribute rather than
inside `fields`. `tracked` is excluded from the match above: it is a
non-nullable policy flag that operators are expected to change, so
re-submitting it for an existing machine is never a mismatch. `ordinal` is
nullable and factual, so it matches like `fields` do -- set when unset,
rejected when it contradicts. `tag` is an editorial label applied after the
fact, which is why it is PATCH-only. See D5 for their columns and D11 for
ordinal assignment.

D3's typing rule covers these built-in attributes as well as the declared
metadata inside `fields`, on every write path: the JSON representation is the
only one accepted, so `"5"` and `true` are not an `ordinal` and `"true"` is not
a `tracked`, while a number with no fractional part is read as the integer it
is. An `ordinal` outside the range of its column (D5 makes it an `INTEGER`) is
likewise rejected with 400 rather than left to fail in the database, which would
be a 500 for a value the caller supplied.

Run metadata is deliberately not covered here: `run_parameters` is written once
at submission and never updated, so there is no reconciliation to specify.


## D8: No Regression Auto-Detection

All Regressions and their indicators are created, updated, and deleted via the
API. There is no auto-detection in LNT v5 -- it provides CRUD only.

Regression detection is the responsibility of an external process (a separate
tool or AI agent) that analyzes time-series data and creates Regressions via
the API when it detects significant changes.


## D9: Search

List endpoints for commits, machines, tests, runs, and regressions support a
unified `?search=` parameter.

- `GET /api/suites/{testsuite}/commits?search=abc` matches `commit` column, `tag` column, OR any
  `searchable` commit_field via case-insensitive substring matching (OR
  semantics).
- `GET /api/suites/{testsuite}/machines?search=x86` matches `name` column OR any `searchable`
  machine_field via case-insensitive substring matching (OR semantics).
- `GET /api/suites/{testsuite}/tests?search=bench` matches the `name` column via case-insensitive
  substring matching.
- `GET /api/suites/{testsuite}/runs?search=x86` matches the run's associated machine's
  `name` column OR any searchable machine_field via case-insensitive substring
  matching (OR semantics) -- the same predicate as the Machines `search=`
  above, applied through the run's machine.
- `GET /api/suites/{testsuite}/regressions?search=slowdown` matches the `title`
  column via case-insensitive substring matching.

Server-side `search=` always performs plain substring matching. It does not
interpret the client's `re:` regex-mode convention (see client
architecture.md) -- that convention is a client-side-only affordance for text
filters that operate over data already loaded in the browser, not for any
`search=` value sent to the API.


## D10: Time-Series Queries

The primary query pattern is: "give me metric values for (machine, test, metric)
ordered by commit ordinal."

This is `Sample JOIN Run JOIN Commit` filtered by `machine_id` and `test_id`,
ordered by `Commit.ordinal`.

When sorting by ordinal, commits without ordinals are excluded (they have no
meaningful position). When not sorting by ordinal, all runs are included
regardless of their commit's ordinal.

Cursor-based pagination requires a deterministic, non-repeating row ordering.
The server appends an internal unique tiebreaker to the caller's sort
specification to guarantee this. The tiebreaker is opaque to clients; cursors
are treated as opaque tokens. When no sort parameter is provided, results are
returned in an arbitrary but deterministic order suitable for pagination, and
no data is excluded.

A cursor names a *position* in that ordering -- the sort key values of the last
row served -- rather than the row it was produced from. A resumption therefore
stays correct when that row is deleted before the next request arrives, which an
implementation storing the row's identity and re-reading its sort values could
not manage. Pagination is forward-only (R2), so a row inserted before the
position a cursor names is not served and one inserted after it is; no row whose
sort values stay put for the length of the traversal is ever skipped or served
twice. A row whose sort values *change* mid-traversal can be, and no cursor
scheme prevents it: reassigning an ordinal (D11) while a client is paging by
ordinal can move a commit from behind the cursor to ahead of it, and the client
sees it twice.

A sort key must be a value no matching row can be missing, either because it is
never null or because the endpoint excludes the rows where it is -- as sorting
by ordinal does. A null compares as unknown against a cursor's value, so a row
carrying one would fall on neither side of the position and vanish from every
page.


## D11: Ordinal Management

- Ordinals can be set on three paths: inline as `commit.ordinal` during run
  submission, at creation via `POST /api/suites/{testsuite}/commits`, or
  assigned/updated at any time via `PATCH /api/suites/{testsuite}/commits/{value}`.
- Inline submission sets the ordinal when the commit has none, and is rejected
  with 409 when the commit already has a different one. `PATCH` is the only way
  to change an ordinal once set.
- A commit whose ordinal is never set on any of those paths stays `NULL`, which
  means unordered.
- Even numeric commit strings (e.g., `"311066"`) do not auto-assign ordinals
  -- an ordinal must be explicitly provided via one of the three paths above.
- The unique constraint on ordinal is a regular (non-deferred) constraint.
  Ordinals are assigned once and are not expected to be commonly reassigned. A
  write that would give two different commits the same ordinal is rejected with
  409, including when it arrives inline with a run submission.
- `previous` and `next` navigation on a commit is computed by querying for
  the nearest lower/higher ordinal (not a linked list).


## D12: Profile Submission and Storage

Profiles are submitted inline as part of run submission. Each test entry in
the submission JSON may include a `"profile"` field containing base64-encoded
profile binary data.

On submission:
1. The `profile` field is recognized as a reserved key (not a metric) and
   excluded from metric name validation.
2. The base64 data is decoded to raw bytes. Invalid base64 is rejected
   with 400.
3. The format version byte is validated (must be 2). Invalid format is
   rejected with 400.
4. A Profile row is created with `(run_id, test_id, created_at, data)`.
5. The unique constraint on `(run_id, test_id)` prevents duplicate profiles.

Profiles are read-only after creation -- there is no PATCH endpoint.
Deleting a run cascades to its profiles.

Profile data is stored as Postgres BYTEA. Postgres automatically applies
TOAST compression for large values. The blob is excluded from default query
results and is only loaded when a request explicitly needs it.


## D13: Concurrent Submission

Run submission (`POST /api/suites/{testsuite}/runs`) is atomic from the API user's perspective: it
either fully succeeds (201) or fully fails with no partial side effects.

Machines, commits, and tests are created via a get-or-create pattern. When
two concurrent sessions race to create the same entity, the loser's INSERT
hits a unique constraint violation. All three get-or-create methods handle
this with **savepoint-based retry**:

1. The INSERT is wrapped in a Postgres SAVEPOINT.
2. On a unique-constraint violation, only the savepoint is rolled back -- prior work in
   the same transaction (e.g., a machine created earlier) is preserved.
3. The method re-queries by name and returns the row created by the winner.

This makes concurrent submissions for the same machine, commit, or test
names safe. No client-side retry is needed.

For tests specifically, a batch resolution path exists that resolves all test
names in O(1) DB round-trips regardless of test count. It provides the same
concurrency safety guarantee as the single-test path: concurrent submissions
with overlapping test sets never produce errors or partial results.
