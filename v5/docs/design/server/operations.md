# v5 Database Layer: Operations

This document covers how data flows through the v5 database: run submission,
machine and commit metadata, search, time-series queries, ordinal management,
profiles, concurrent submission, and run summaries.


## O1: Submission Format

Runs are submitted as JSON via `POST /api/suites/{testsuite}/runs`.

The machine and the commit are each submitted as an entity object of the same
shape: the identity attribute, any built-in attributes, and a `fields` dict
holding the schema-declared metadata. Keeping declared metadata in its own dict
means a field can never collide with an identity or built-in key, and makes the
object identical to the one the entity's own creation endpoint accepts (see
O2).

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
      "profile": "<base64 of a gzip-compressed profile document>"
    }
  ]
}
```

- `format_version`: required, must be `"5"`.
- `uuid`: optional. A client-provided UUID for the run, in the standard
  hyphenated `8-4-4-4-12` hex format (e.g. the output of `uuidgen`). It is
  case-insensitive on input, and stored in lowercase. Any UUID version is
  accepted (v4, v5, v7, etc.): only the format is checked. If a run with the
  same UUID already exists in the test suite, the server returns 409
  `duplicate` (see I4). If omitted, the server generates a random UUID v4.
- `machine`: required object identifying the machine this run was measured on.
  - `name`: required string, the machine's identity.
  - `fields`: optional. Every key must be declared in the schema's
    `machine_fields`. See O2 for undeclared keys, and for how metadata is
    reconciled when the machine already exists.
  - `tracked`: optional boolean, a built-in attribute rather than a
    `machine_field`. It controls whether the machine takes part in automatic
    machine selection. It only applies when the machine is created (first write
    wins), and defaults to `true` when omitted. Submitting it for a machine
    that already exists has no effect. Use
    `PATCH /api/suites/{testsuite}/machines/{name}` to change it afterwards.
- `commit`: required object identifying the commit this run belongs to.
  - `value`: required string, the commit's identity.
  - `fields`: optional. Every key must be declared in the schema's
    `commit_fields`. See O2 for undeclared keys, and for how metadata is
    reconciled when the commit already exists.
  - `ordinal`: optional integer, a built-in attribute rather than a
    `commit_field`. It places the commit in the suite's total order. It is set
    if the commit has no ordinal yet. If the commit already has a different
    one, the submission is rejected with 409 (see O2). Use
    `PATCH /api/suites/{testsuite}/commits/{value}` to change an ordinal once
    set. Ordinals are unique within a suite, so a value already held by another
    commit is also rejected with 409 (see O6).
  - `tag`: optional string, a built-in attribute rather than a `commit_field`:
    a human-readable label such as a release name. Several commits may share a
    tag (see D5). It is set if the commit has no tag yet. If the commit already
    has a different one, the submission is rejected with 409 (see O2). Use
    `PATCH /api/suites/{testsuite}/commits/{value}` to change or clear a tag
    once set.
- `run_parameters`: optional, stored as JSONB on the run. Runs have no declared
  field list, so this is a free-form blob rather than a `fields` dict. Its only
  validation is D3's rule on values that cannot be stored.
- `tests`: required list of test entries, which may be empty. Each entry has a
  `name` plus metric values.
  - `name` is required, non-empty, and no longer than `{suite}.test.name`
    allows (see D5).
  - Two entries with the same test name are rejected with 400: repetitions are
    expressed with arrays, and D5 allows only one profile per run and test.
  - A metric value may be a scalar or an array. An array (e.g.
    `"execution_time": [0.1, 0.2]`) creates one sample per element. All arrays
    in one test entry must have the same length, and scalar values are
    repeated in every resulting sample. An empty array is rejected with 400.
  - An entry creates `max(1, array length)` samples, so an entry with no
    metric values still records that the test ran.
  - Every metric key must be declared in the schema's `metrics`; an undeclared
    one is rejected with 400. Values are typed per D3.
  - A metric with no value must be omitted from the entry rather than sent as
    `"metric": null`, and a `null` element inside an array is rejected.
  - An optional `profile` holds the test's profile: a JSON profile document,
    gzip-compressed and base64-encoded (see O7).
  - `name` and `profile` are reserved keys in a test entry, so neither can be a
    metric name. This is enforced when the schema is created rather than at
    submission (see D5), so that a suite can never have a metric that no
    submission could fill.

**Null values.** An explicit `null` means "omitted" on `uuid`,
`commit.ordinal`, `commit.tag`, a test entry's `profile`, and each entry of
`machine.fields` and `commit.fields`. Anywhere else, `null` is rejected with
400. Unlike with `PATCH`, a `null` in `fields` never clears a stored value (see
O2). This lets a client submit the `fields` dict a response returned, which has a
`null` for every unset field (see I4).


## O2: Machine and Commit Metadata Population

Machines and commits are the two entities that carry schema-declared metadata
(`machine_fields` and `commit_fields`, see D4), and that a run submission can
create implicitly. Both are represented by an entity object of the same shape
-- identity attribute, built-in attributes, and a `fields` dict of declared
metadata -- and every write path accepts that same object:

1. **Inline in a run submission**: the submission's `machine` and `commit`
   objects fill in the record when it is first created. If the record already
   exists, its metadata is NOT overwritten, and the submitted values must match
   the stored ones, or the submission is rejected.
2. **Explicit creation**: `POST /api/suites/{testsuite}/machines` and
   `POST /api/suites/{testsuite}/commits` take the same entity object, and
   create the record without a run.
3. **PATCH**: `PATCH /api/suites/{testsuite}/machines/{name}` and
   `PATCH /api/suites/{testsuite}/commits/{value}` set or update metadata at
   any time, overwriting existing values.

**Declared keys only.** On every path, each metadata key must be declared in
the suite's schema; an undeclared key is rejected with 400. Neither entity has
a catch-all blob, so the schema states exactly what can be stored on it.
Declaring a new field is a schema change (`PATCH /api/suites/{name}/schema`,
see D2); a submission cannot do it implicitly.

**Matching on re-submission.** In path 1, only the keys present in the
submission are compared, and a key sent as `null` counts as absent (see O1). An
omitted key is not compared, so its stored value is left alone and never causes
a rejection. Submitters that send different subsets of a record's metadata can
therefore coexist, and a field added by a schema change does not break
producers that don't send it yet.

For each key the submission sends:
- if the record has no value for it, the submitted value is filled in;
- if the stored value is equal to it, it is accepted;
- otherwise, the submission is rejected with 409 `conflict` (see I4).

Stored metadata is never overwritten by a submission: `PATCH` is the only way to
change it.

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
inside `fields`:

- `tracked` is not matched. It is a non-nullable policy flag that operators are
  expected to change, so re-submitting it for an existing machine is never a
  mismatch.
- `ordinal` and `tag` are nullable and describe the commit, so they are matched
  like `fields`: set when unset, rejected when they contradict the stored
  value. As with `fields`, once `ordinal` or `tag` is changed through `PATCH`, a
  submitter still sending the old value is rejected until it is updated.

See D5 for their columns and O6 for ordinal assignment.

Run metadata is deliberately not covered here: `run_parameters` is written once
at submission and never updated, so there is nothing to reconcile.


## O3: No Regression Auto-Detection

All regressions and their indicators are created, updated, and deleted through
the API. LNT v5 does not detect regressions automatically: it only provides
CRUD operations.

Detecting regressions is the job of an external process (a separate tool or an
AI agent), which analyzes time-series data and creates regressions through the
API when it finds significant changes.


## O4: Search

List endpoints for commits, machines, tests, runs, and regressions accept a
`?search=` parameter. It is a case-insensitive substring match unless specified
otherwise, and when it covers several columns or related entities, a row
matches if any of them does. A UUID is matched by case-insensitive prefix
instead. An empty term matches every row.

| Endpoint | Matches against |
|----------|-----------------|
| `GET /api/suites/{testsuite}/commits?search=abc` | The `commit` column, the `tag` column, and any `searchable` commit field |
| `GET /api/suites/{testsuite}/machines?search=x86` | The `name` column and any `searchable` machine field |
| `GET /api/suites/{testsuite}/tests?search=bench` | The `name` column |
| `GET /api/suites/{testsuite}/runs?search=x86` | The run's machine, as the Machines `search=` above matches it; the run's commit, as the Commits `search=` above matches it; and the run's `uuid`, by prefix |
| `GET /api/suites/{testsuite}/regressions?search=slowdown` | The `title` column, and the `uuid` by prefix |

The term is plain text: `%`, `_` and regex syntax have no special meaning.


## O5: Time-Series Queries

The primary query pattern is: "give me metric values for (machine, test,
metric), ordered by commit ordinal." This is `Sample JOIN Run JOIN Commit`,
filtered by `machine_id` and `test_id`, and ordered by `Commit.ordinal`.

When sorting by ordinal, commits without an ordinal are excluded, since they
have no position in that order. When not sorting by ordinal, all runs are
included, whatever their commit's ordinal.

**Cursor pagination** requires a deterministic row order with no repeats. The
server appends an internal unique tiebreaker to the caller's sort to guarantee
this. The tiebreaker is opaque to clients, and cursors are treated as opaque
tokens. When no sort is requested, results come in an arbitrary but
deterministic order suitable for pagination, and no data is excluded.

A cursor names a *position* in that order -- the sort key values of the last
row served -- rather than the row itself, so that resuming still works after
that row has been deleted. Re-reading a stored row's sort values would not.
Each page reads the database as of its own request, and pagination is
forward-only (I2): a row that starts matching mid-traversal, because it was
inserted or because it now matches the filters, is served only if it falls
after the cursor. A row that matches throughout is served exactly once, unless
its sort values change: reassigning an ordinal (O6) while a client pages by
ordinal can move a commit from behind the cursor to ahead of it, and the client
then sees it twice. No cursor scheme prevents that.

A sort key must have a value in every matching row: either it is never null, or
the endpoint excludes the rows where it is null, as sorting by ordinal does. A
null compares as unknown against a cursor's value, so a row with one would fall
on neither side of the position and vanish from every page.


## O6: Ordinal Management

- Ordinals can be set in three ways: inline as `commit.ordinal` in a run
  submission, at creation with `POST /api/suites/{testsuite}/commits`, or at
  any time with `PATCH /api/suites/{testsuite}/commits/{value}`.
- An inline ordinal is set if the commit has none, and a submission that sends
  a different one from the commit's current ordinal is rejected with 409.
  `PATCH` is the only way to change an ordinal once set.
- A commit whose ordinal is never set in any of these ways stays `NULL`, which
  means unordered.
- The server never assigns an ordinal from the commit string, even a numeric
  one (e.g. `"311066"`): an ordinal must be provided explicitly in one of the
  three ways above.
- The unique constraint on ordinal is a regular (non-deferred) constraint.
  Ordinals are assigned once and are not expected to be reassigned often. A
  write that would give two different commits the same ordinal is rejected with
  409, including one that arrives inline in a run submission.
- `previous` and `next` navigation on a commit is computed by querying for the
  nearest lower and higher ordinal (not with a linked list).
- An ordinal is typed like a declared `integer` (D3): `"5"` and `true` are
  rejected, and `8.0` is read as 8. An ordinal outside the range of its
  `INTEGER` column (D5) is rejected with 400 rather than failing in the
  database.


## O7: Profile Submission and Storage

A profile records hardware performance counters per instruction, for one test
in one run. It is submitted inline as a test entry's `profile` (see O1): a JSON
**profile document**, gzip-compressed and base64-encoded.

```json
{
  "disassembly_format": "llvm-objdump",
  "counters": {"cycles": 9123456, "instructions": 12000000},
  "functions": [
    {
      "name": "main",
      "instructions": [
        {"address": 4096, "counters": {"cycles": 1200, "instructions": 900}, "text": "push rbp"},
        {"address": 4100, "counters": {"cycles": 300, "instructions": 450}, "text": "ret"}
      ]
    }
  ]
}
```

- `disassembly_format`: how the instruction text was produced.
- `counters`: the profile's top-level counters, each a non-negative `integer`
  as D3 reads one. They are totals for the whole profile, including functions
  it does not list.
- `functions`: each function's `name` and its `instructions`, in order. Each
  instruction has its `address` (a non-negative `integer`), its `counters`
  (non-negative `real`s) and its disassembled `text`. Either list may be empty.

Every counter value is a **raw count**, never a percentage. A function's own
counters are not submitted: the server computes each one as the sum of that
counter over the function's instructions.

**Decoding and validation.** The `profile` string is decoded as standard,
padded base64, ignoring ASCII whitespace (so line-wrapped output is accepted),
and then as exactly one gzip member. Each of the following is rejected with
400:

- Any other character outside the base64 alphabet, bad padding, or data that is
  not one complete gzip member.
- More than 4 MiB (4,194,304 bytes) compressed, or more than 32 MiB
  (33,554,432 bytes) decompressed.
- A document that is not valid JSON of the shape above, with exactly those keys
  and types as D3 reads them.
- An empty function or counter name, a NUL in any string (see D3), or two
  functions with the same name.
- More than 10,000 functions, a function name longer than 2,048 bytes in UTF-8,
  or a function with more than 100,000 instructions.
- Instructions of one function that do not all have the same counters.
- An instruction counter that is not one of the profile's top-level counters.
- A function whose sum for some counter is too large to be a finite `real`.

**Storage and reading back.** A stored profile is returned with the values it
was submitted with, each typed as above (an address `8.0` is returned as `8`,
an instruction counter `5` as a `real`), with each function's counters computed
as above, and with each function's instructions in the order the document
listed them. It is stored as D5's `{suite}.profile` and
`{suite}.profile_function` rows. Since everything is validated at submission,
the read endpoints can serve any stored profile. Profiles are read-only after
creation, and deleting a run deletes its profiles.

The order of a profile's functions is not stored, so a profile read back whole,
as a document (see E7), may list its functions in a different order than the
one submitted.


## O8: Concurrent Submission

Run submission (`POST /api/suites/{testsuite}/runs`) is atomic from the API
user's point of view: it either fully succeeds (201) or fully fails, with no
partial side effects.

Machines, commits, and tests are created with a get-or-create pattern, so
concurrent submissions naming the same entity race to create it. An
implementation must guarantee that:

- **A lost race resolves to the winner's row.** The submission that loses the
  race to create a machine, a commit, or a test uses the row the winner
  created, and does not fail. Any other integrity failure is reported as its
  own error (e.g. a taken `ordinal`, see O6).
- **O2 holds under concurrency.** Two submissions filling in the same unset
  value cannot both succeed with different values.
- **Concurrent submissions cannot deadlock each other.**
- **Resolving test names takes a fixed number of round trips**, however many
  names a submission carries.

The payload should be validated outside the write transaction, so that reading
a large submission does not hold a connection and an open transaction. A
schema change between validation and the write then gets D2's retryable 409
(`retry`).

With PostgreSQL, this is achieved as follows:

- Machines and commits are resolved with a **savepoint-based retry**: the
  INSERT runs inside a SAVEPOINT, and if it fails, only the savepoint is rolled
  back and the row is re-read by its identity. If the row is there now, the race
  was lost and the winner's row is used, whichever unique index reported the
  failure. Otherwise the failure (e.g. a taken `ordinal`) fails the submission.
- An existing row is reconciled against the submission (see O2). If a NULL must
  be filled in, the row is re-read `FOR NO KEY UPDATE` and reconciled again, and
  that second reconciliation decides the write. A submission with nothing to
  fill in takes no lock.
- Every submission resolves the machine, then the commit, then the test names.
  Inserting the run then takes key-share locks on its machine and commit
  through the foreign keys, so the fill lock must not be `FOR UPDATE`: that
  conflicts with key-share, and two submissions could deadlock.
- Test names are resolved as a set: read the ones that exist, insert the rest
  while skipping conflicts, and re-read the ones that were skipped. Names are
  inserted in ascending order, so that submissions with overlapping sets lock
  them in the same order.
- `{suite}.test_coverage` is written last, in one statement, with its rows in
  `(machine_id, test_id)` order, so that submissions for the same machine lock
  them in the same order.


## O9: Run Summaries

Run submission also stores, in the same transaction, a summary of the run for
every numeric metric (see D3) and every sample aggregation: `median`, `mean`,
`min` and `max`. A summary holds statistics computed from the run's samples, so
that later reads do not have to read every sample again. The only statistic so
far is the run's geomean, computed in two steps:

1. Each test's samples in the run that have a value for the metric are reduced
   to one value with the sample aggregation. The median of an even number of
   values is the mean of the middle two. A test with no value for the metric is
   left out.
2. The geomean, `exp(mean(ln(v)))`, is taken over those per-test values,
   skipping any that are zero or negative.

If a metric and aggregation have no positive per-test value, there is no
geomean, and no summary is stored for them. Summaries are stored in
`{suite}.run_summary` (see D5), which lets a trend read a few rows per commit
rather than every sample (see `GET /api/suites/{testsuite}/trends`).

Adding a metric needs no backfill: existing samples have no value for it, so
existing runs have no summary of it either.
