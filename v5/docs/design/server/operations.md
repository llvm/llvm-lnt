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
    "tag": "release-18.1",
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
  already exists in the test suite, the server returns 409 `duplicate` (see R4).
  If omitted, the server generates a random UUID v4.
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
    different one, the submission is rejected with 409 (see D7). Use
    `PATCH /api/suites/{testsuite}/commits/{value}` to change an ordinal once
    set. Ordinals are unique within a suite, so a value already held by a
    different commit is also rejected with 409 (see D11).
  - `tag`: Optional string, a built-in attribute rather than a `commit_field`.
    A human-readable label such as a release name; several commits may share
    one (see D5). It is set when the commit has no tag yet; when the commit
    already has a different one, the submission is rejected with 409 (see
    D7). Use `PATCH /api/suites/{testsuite}/commits/{value}` to change or
    clear a tag once set.
- `run_parameters`: Optional. Stored as JSONB on the Run. Run has no declared
  field list, so this is a free-form blob rather than a `fields` dict, validated
  only against D3's rule on values that cannot be stored.
- `tests`: Required list of test entries, which may be empty. Each entry has
  `name` plus metric values.
  - `name` is required, non-empty, and at most the length `{suite}.test.name`
    allows (see D5).
  - Two entries naming the same test are rejected with 400: repetitions are
    expressed with arrays, and D5 allows only one profile per run+test pair.
  - Metric values may be scalars or arrays. An array value (e.g.
    `"execution_time": [0.1, 0.2]`) creates one Sample row per element. All
    arrays in a single test entry must have the same length, and scalar values
    are repeated across the resulting rows. An empty array is rejected with 400.
  - An entry yields `max(1, array length)` Sample rows, so an entry with no
    metric values still records that the test ran.
  - Every metric key must be declared in the schema's `metrics`; an undeclared
    one is rejected with 400. Values are typed per D3.
  - Metrics with null values must be omitted from the test entry (not sent as
    `"metric": null`), and a null element inside an array is rejected.
  - An optional `profile` field may contain base64-encoded profile binary data;
    if present, a Profile row is created and linked to the run+test (see D12).
  - `name` and `profile` are reserved keys within a test entry, so neither may
    be a metric name -- this is enforced when the schema is created rather than
    at submission (see D5), so a suite can never hold a metric that no submission
    could populate.

An explicit `null` means "omitted" on `uuid`, `commit.ordinal`, `commit.tag`, a
test entry's `profile`, and each entry of `machine.fields` and `commit.fields`;
anywhere else it is rejected with 400. Unlike with `PATCH`, a `null` in `fields`
never clears a stored value (see D7), so a client can submit the `fields` dict a
response gave it, which carries a `null` for every unset field (see R4).


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
present in the submission, and a key present with an explicit `null` counts as
absent (see D6). A key the submission omits is not compared, so its stored value
is left alone and can never cause a rejection. Submitters that send different
subsets of a record's metadata therefore coexist, and a field introduced by a
schema change does not break producers that do not send it yet.

A key the submission sends fills in the value if the record has none, and is
accepted if it equals the stored value. Any other value rejects the submission
with 409 (`ordinal_conflict` for a commit's `ordinal`, `conflict` otherwise; see
R4): stored metadata is never overwritten, and `PATCH` is the only way to change
it.

Per-entity specifics:

| | Machine | Commit |
|---|---|---|
| Identity attribute | `name` | `value` |
| Declared metadata | `fields`, per `machine_fields` | `fields`, per `commit_fields` |
| Built-in mutable attributes | `tracked` | `ordinal`, `tag` |
| Settable during run submission | `tracked` (first-write-wins) | `ordinal`, `tag` (must match if already set) |
| Settable at explicit creation | `tracked` | `ordinal`, `tag` |
| Renameable via PATCH | yes | no |

Built-in mutable attributes sit beside the identity attribute rather than
inside `fields`. `tracked` is excluded from the match above: it is a
non-nullable policy flag that operators are expected to change, so
re-submitting it for an existing machine is never a mismatch. `ordinal` and
`tag` are nullable and describe the commit, so they match like `fields` do --
set when unset, rejected when they contradict. As with `fields`, changing one
through PATCH means a submitter still sending the old value is rejected until it
is updated. See D5 for their columns and D11 for ordinal assignment.

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
row served -- rather than the row itself, so a resumption survives that row's
deletion, which re-reading a stored row's sort values could not. Each page reads
the database as of its own request, and pagination is forward-only (R2): a row
that joins the list mid-traversal, by insertion or by newly matching its
filters, is served only if it falls after the cursor. A row in the list
throughout is served exactly once, unless its sort values change: reassigning an
ordinal (D11) while a client pages by ordinal can move a commit from behind the
cursor to ahead of it, and the client sees it twice. No cursor scheme prevents
that.

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
- An ordinal is typed as D3 types a declared `integer` -- `"5"` and `true` are
  refused, `8.0` is read as 8 -- and one outside the range of its `INTEGER`
  column (D5) is rejected with 400 rather than failing in the database.


## D12: Profile Submission and Storage

Profiles are submitted inline as part of run submission. Each test entry in
the submission JSON may include a `"profile"` field containing base64-encoded
profile binary data.

On submission:
1. The `profile` field is recognized as a reserved key (not a metric) and
   excluded from metric name validation.
2. The data is decoded as standard, padded base64, ignoring ASCII whitespace
   (so line-wrapped output is accepted). Any other character outside the
   alphabet, or bad padding, is rejected with 400.
3. A decoded blob larger than D5's cap is rejected with 400.
4. The first byte, the format version, must be 2; otherwise, or if the blob is
   empty, the profile is rejected with 400. Nothing else is parsed at
   submission time.
5. A Profile row is created with `(run_id, test_id, created_at, data)`.
6. The unique constraint on `(run_id, test_id)` prevents duplicate profiles.

Profiles are read-only after creation -- there is no PATCH endpoint.
Deleting a run cascades to its profiles.

Profile data is stored as Postgres BYTEA. Postgres automatically applies
TOAST compression for large values. The blob is excluded from default query
results and is only loaded when a request explicitly needs it.


## D13: Concurrent Submission

Run submission (`POST /api/suites/{testsuite}/runs`) is atomic from the API user's perspective: it
either fully succeeds (201) or fully fails with no partial side effects.

Machines, commits, and tests are created via a get-or-create pattern, so
concurrent submissions naming the same entity race to create it. An
implementation must guarantee that:

- **A lost race resolves to the winner's row.** The submission that loses the
  race for a machine, a commit, or a test name uses the row the winner created,
  and does not fail. Any other integrity failure is reported as its own error
  (e.g. a taken `ordinal`, see D11).
- **D7 holds under concurrency.** Two submissions filling the same unset value
  cannot both succeed with different values.
- **Concurrent submissions cannot deadlock against each other.**
- **Test-name resolution costs a fixed number of round trips**, however many
  names a submission carries.

The payload should be validated outside the write transaction, so that reading
a large submission does not hold a connection and an open transaction. A schema
change between validation and the write is then answered with D2's 409.

With PostgreSQL, this is achieved as follows:

- Machines and commits are resolved with a **savepoint-based retry**: the INSERT
  is wrapped in a SAVEPOINT, and if it fails only the savepoint is rolled back
  and the row is re-read by its identity. If it is there now, the race was lost
  and the winner's row is used, whichever unique index reported the failure;
  otherwise the failure (e.g. a taken `ordinal`) fails the submission.
- An existing row is reconciled against the submission (see D7). If a NULL must
  be filled in, the row is re-read `FOR NO KEY UPDATE` and reconciled again, and
  that second reconciliation decides the write. A submission with nothing to
  fill takes no lock.
- Every submission resolves the machine, then the commit, then the test names.
  Inserting the run then takes key-share locks on its machine and commit through
  the foreign keys, so the fill lock must not be `FOR UPDATE`: that conflicts
  with key-share, and two submissions could deadlock.
- Test names are resolved as a set: read the ones that exist, insert the rest
  while skipping conflicts, and re-read what was skipped. Names are inserted in
  ascending order, so that submissions with overlapping sets lock them in the
  same order.
- `{suite}.test_coverage` is written last, in one statement, with its rows in
  `(machine_id, test_id)` order, so that submissions for the same machine lock
  them in the same order.
