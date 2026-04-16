# v5 Database Layer: Operations

This document covers how data flows through the v5 database: submission, metadata
management, search, time-series queries, ordinal management, and migration from v4.

For the data model and table definitions, see [`data-model.md`](data-model.md).


## D6: Submission Format

Runs are submitted as JSON via `POST /api/v5/{suite}/runs`.

```json
{
  "format_version": "5",
  "machine": {
    "name": "my-machine",
    "hardware": "x86_64",
    "os": "linux"
  },
  "commit": "abc123def456",
  "commit_fields": {
    "git_sha": "abc123def456789...",
    "author": "Jane Doe",
    "commit_message": "Fix vectorizer regression"
  },
  "run_parameters": {
    "build_config": "Release"
  },
  "tests": [
    {
      "name": "test.suite/benchmark",
      "execution_time": 1.23,
      "compile_time": 0.45
    }
  ]
}
```

- `format_version`: Required, must be `"5"`.
- `machine`: Required. `name` is required; other keys match `machine_fields`
  from the schema and are stored in the corresponding columns. Keys that do not
  match any `machine_fields` entry go into the `parameters` JSONB blob.
- `commit`: Required string. Identifies which commit this run belongs to.
- `commit_fields`: Optional. Keys match `commit_fields` from the schema.
  First-write-wins: if the commit already exists, metadata is not overwritten.
  Use PATCH on the commit to update metadata after creation.
- `run_parameters`: Optional. Stored as JSONB on the Run.
- `tests`: Required. Each entry has `name` plus metric values. Metric values
  may be scalars or arrays. An array value (e.g. `"execution_time": [0.1, 0.2]`)
  creates one Sample row per element. All arrays in a single test entry must
  have the same length; scalar values are repeated across the resulting rows.


## D7: Commit Metadata Population

Commit metadata (`commit_fields`) can be set via two paths:

1. **Inline during run submission**: The `commit_fields` dict in the submission
   JSON populates metadata on the Commit record when it is first created.
   If the commit already exists, metadata is NOT overwritten (first-write-wins).
2. **Via PATCH**: `PATCH /api/v5/{suite}/commits/{value}` can set or update
   metadata fields at any time, overwriting existing values.

Ordinals are set exclusively via PATCH (see D11).


## D8: No Regression Auto-Detection

All Regressions and their indicators are created, updated, and deleted via the
API. There is no auto-detection in the v5 DB layer -- it provides CRUD only.

Regression detection is the responsibility of an external process (a separate
tool or AI agent) that analyzes time-series data and creates Regressions via
the API when it detects significant changes.


## D9: Search

List endpoints for commits and machines support a unified `?search=` parameter.

- `GET /commits?search=abc` matches `commit` column OR any `searchable`
  commit_field via case-insensitive prefix matching (OR semantics).
- `GET /machines?search=x86` matches `name` column OR any `searchable`
  machine_field.
- This replaces v4's ad-hoc `tag_prefix`, `name_prefix`, `name_contains`
  parameters with a consistent pattern.


## D10: Time-Series Queries

The primary query pattern is: "give me metric values for (machine, test,
metric) ordered by commit ordinal."

This is `Sample JOIN Run JOIN Commit` filtered by `machine_id` and `test_id`,
ordered by `Commit.ordinal`.

When sorting by ordinal, commits without ordinals are excluded (they have no
meaningful position). When not sorting by ordinal, all runs are included
regardless of their commit's ordinal.

Cursor-based pagination (encoding, decoding, tiebreakers) is an API-layer
concern. The DB layer provides filtering, sorting, and limit parameters only.


## D11: Ordinal Management

- Ordinals are always `NULL` on commit creation.
- Ordinals are assigned exclusively via `PATCH /commits/{value}`.
- Even numeric commit strings (e.g., `"311066"`) do not auto-assign ordinals.
- The unique constraint on ordinal is a regular (non-deferred) constraint.
  Ordinals are assigned once by an external process and are not expected to
  be reassigned.
- `previous` and `next` navigation on a commit is computed by querying for
  the nearest lower/higher ordinal (not a linked list).


## D12: Migration from v4

A separate offline tool (`lnt admin migrate-to-v5`) converts a v4 database to
a v5 Postgres database:

- Orders -> Commits: primary order field value becomes the commit string,
  linked-list position becomes the ordinal.
- v4 `tag` column on Order -> a `label` commit_field (if defined in the schema).
- Run.order_id -> Run.commit_id; Run.start_time -> Run.submitted_at.
- v4 FieldChange + RegressionIndicator -> v5 RegressionIndicator (machine_id,
  test_id, metric resolved from FieldChange; field_change_id FK removed).
- Baseline, ChangeIgnore, Profile tables are not migrated.


## D13: Profiles (Deferred)

Profile support is not part of the initial v5 database layer. The v4 Profile
table is dropped and no replacement is provided. Profile support will be
designed and added in a future iteration.


## D14: Concurrent Submission

Run submission (`POST /runs`) is atomic from the API user's perspective: it
either fully succeeds (201) or fully fails with no partial side effects.

Machines, commits, and tests are created via a get-or-create pattern. When
two concurrent sessions race to create the same entity, the loser's INSERT
hits a unique constraint violation. All three get-or-create methods handle
this with **savepoint-based retry**:

1. The INSERT is wrapped in `session.begin_nested()` (Postgres SAVEPOINT).
2. On `IntegrityError`, only the savepoint is rolled back -- prior work in
   the same transaction (e.g., a machine created earlier in the same
   `import_run` call) is preserved.
3. The method re-queries by name and returns the row created by the winner.

This makes concurrent submissions for the same machine, commit, or test
names safe. No client-side retry is needed.
