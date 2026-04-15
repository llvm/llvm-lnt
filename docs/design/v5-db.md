# v5 Database Layer Design

This document captures the design constraints and decisions for the v5 database
layer. It is the authoritative reference for what the v5 DB does and why.

For the exploration and discussion that led to these decisions, see
`v5-discussion-about-orders.md` in this directory.


## D1: Architecture and Separation

- The v5 DB layer lives in `lnt/server/db/v5/`, a self-contained package with
  its own schema parsing, models, and CRUD interface.
- No imports from v4 DB code (`lnt.server.db.testsuite`, `testsuitedb`,
  `v4db`, `fieldchange`, `regression`). The v5 package is fully independent.
- v4 and v5 coexist in the same codebase, selected by `db_version` in the LNT
  config file (`'0.4'` for v4, `'5.0'` for v5).
- A v5 instance serves only v5 API endpoints. A v4 instance serves v4 views
  and the v4 REST API only. The v5 REST API and v5 frontend are available
  only on v5 instances.
- Postgres only. No SQLite or MySQL support.
- SQLAlchemy 1.3 (same version as v4, to avoid upgrade risk).
- All new code uses Python 3.10+ idioms: type hints (`X | Y`, `list[T]`),
  dataclasses, f-strings, `match` where appropriate.


## D2: The Commit Concept (replaces Orders)

The v4 "Order" concept conflated three concerns: identity (what groups runs),
ordering (sequential position for time-series), and display (what the UI shows).
The v5 "Commit" concept cleanly separates these.

- **Commit**: A named point that groups runs. The `commit` column is a single
  string (e.g., a Git SHA, version number, or ad-hoc label like
  `"experiment-vectorizer-v2"`). It is the identity of the commit. By default,
  the UI also uses it for display, but a `commit_field` marked `display: true`
  overrides what is shown (see D4). Every run must have a commit.
- **Ordinal**: An optional integer that places the commit in a total order.
  Always assigned via PATCH, never inferred from the commit string (even if the
  string is numeric). `NULL` means unordered.

Two tiers of runs:
1. Run with ordered commit (ordinal set): full time-series participation.
2. Run with unordered commit (ordinal NULL): grouped but not positioned in the
   time series. Used for throwaway A/B comparisons (use an ad-hoc commit
   string like `"experiment-vectorizer-v2"`), or as the transient state before
   an external process assigns an ordinal.

Cleanup: unordered commits that are no longer needed can be deleted via the API,
which cascades to their runs and samples.


## D3: Schema Storage and Lifecycle

Test suite schemas are created via the API (`POST /api/v5/test-suites`) and
persisted in the database, not on the filesystem. The `schemas/*.yaml` files
in the repository are documentation/examples only -- the server does not read
them.

**Global tables** (not per-suite, shared across all suites):

| Table | Columns |
|---|---|
| `v5_schema` | `name` (String PK), `schema_json` (Text), `created_at` (DateTime) |
| `v5_schema_version` | `id` (Integer PK, always 1), `version` (Integer) |

On startup, `V5DB` reads all rows from `v5_schema`, parses each into a
`TestSuiteSchema`, and builds in-memory models. The `v5_schema_version` counter
is cached.

**Multi-process safety**: In a multi-worker deployment (e.g., gunicorn), when
one worker creates or deletes a suite, it bumps the `v5_schema_version` counter
in the same transaction. The v5 API middleware calls `V5DB.ensure_fresh()` at
the start of every request, which compares the cached version against the DB
and reloads all schemas when they differ. The check is a single-row integer
read per request.


## D4: Schema Format

Each test suite is defined by a YAML schema file. The v5 format is a clean
break from v4 (no backward compatibility required).

```yaml
name: nts

metrics:
- name: compile_time
  type: real                    # real | status | hash
  display_name: Compile Time
  unit: seconds
  unit_abbrev: s
  bigger_is_better: false
- name: execution_time
  type: real
- name: compile_status
  type: status

machine_fields:
- name: hardware
  searchable: true
- name: os
  searchable: true

commit_fields:
- name: git_sha
  searchable: true
- name: author
  searchable: true
- name: commit_message
  type: text                    # default (String 256) | text | integer | datetime
- name: commit_timestamp
  type: datetime
```

Key differences from v4:
- `run_fields` with `order: true` is gone. The commit is a built-in concept.
- `run_fields` section is removed entirely — extra run data goes in
  `run_parameters` (JSONB).
- `commit_fields` defines optional typed metadata columns on the Commit table.
- `searchable: true` on commit_fields or machine_fields enables `?search=`
  prefix matching on the corresponding list API endpoint.
- `display: true` on at most one commit_field is a hint for the UI: when set
  and the field has a non-null value, the UI shows that value instead of the
  raw commit string (e.g., a shortened SHA, a version tag). This is purely a
  UI concern -- the DB layer does not treat display fields specially.
- No `format_version` in the schema file (only one format exists for v5).


## D5: Data Model

Per-suite tables are dynamically named (e.g., `nts_Commit`, `nts_Run`).

### `{suite}_Commit`

| Column | Type | Constraints |
|--------|------|-------------|
| id | Integer | PK |
| commit | String(256) | unique, not null |
| ordinal | Integer | nullable, unique |
| _(dynamic)_ | per commit_fields | nullable |

- `commit` is the identity string provided by submitters. Used as the default
  display value in the UI unless a `commit_field` with `display: true` is
  defined and populated.
- `ordinal` has a regular unique constraint. Ordinals are assigned once by an
  external process and are not expected to be reassigned.
- Dynamic columns are created from `commit_fields` in the schema.
- No linked list (NextOrder/PreviousOrder from v4 are gone).
- No `label` built-in column. If labeling is needed, define a `label` field
  in `commit_fields`.
- Commits are deletable. Deleting a commit cascades to its runs (and their
  samples). FieldChanges referencing a deleted commit must be deleted first
  (the API enforces this).
- Schema-defined `commit_fields` names must not collide with built-in column
  names (`id`, `commit`, `ordinal`). The schema parser rejects these.

### `{suite}_Machine`

| Column | Type | Constraints |
|--------|------|-------------|
| id | Integer | PK |
| name | String(256) | unique, not null |
| parameters | JSONB | not null, default `{}` |
| _(dynamic)_ | per machine_fields | nullable |

- `name` uniqueness is enforced (fixes a v4 bug).
- `parameters` stores extra key-value data as Postgres JSONB.
- Schema-defined `machine_fields` names must not collide with built-in column
  names (`id`, `name`, `parameters`). The schema parser rejects these.

### `{suite}_Run`

| Column | Type | Constraints |
|--------|------|-------------|
| id | Integer | PK |
| uuid | String(36) | unique, not null, indexed |
| machine_id | Integer FK → Machine | not null, indexed |
| commit_id | Integer FK → Commit | not null, indexed |
| submitted_at | DateTime | not null |
| run_parameters | JSONB | not null, default `{}` |

- Every run must have a commit (`commit_id` is not null).
- `submitted_at` replaces v4's `start_time`/`end_time` (client-side timing
  goes in `run_parameters` if needed).
- Cascade: deleting a machine cascades to its runs; deleting a commit cascades
  to its runs. Deleting a run cascades to its samples.

### `{suite}_Test`

| Column | Type | Constraints |
|--------|------|-------------|
| id | Integer | PK |
| name | String(256) | unique, not null |

### `{suite}_Sample`

| Column | Type | Constraints |
|--------|------|-------------|
| id | Integer | PK |
| run_id | Integer FK → Run | not null |
| test_id | Integer FK → Test | not null |
| _(dynamic)_ | per metrics | nullable |

- Compound index on `(run_id, test_id)`.
- Dynamic columns from schema metrics: `real` → Float, `status` → Integer,
  `hash` → String(256).

### `{suite}_FieldChange`

| Column | Type | Constraints |
|--------|------|-------------|
| id | Integer | PK |
| uuid | String(36) | unique, not null, indexed |
| test_id | Integer FK → Test | not null |
| machine_id | Integer FK → Machine | not null |
| field_name | String(256) | not null |
| start_commit_id | Integer FK → Commit | not null |
| end_commit_id | Integer FK → Commit | not null |
| old_value | Float | nullable |
| new_value | Float | nullable |

- `field_name` is a plain string (metric name), not a FK to a metatable.
  Simpler for an API-driven system.
- Compound index on `(machine_id, test_id, field_name)`.

### `{suite}_Regression`

| Column | Type | Constraints |
|--------|------|-------------|
| id | Integer | PK |
| uuid | String(36) | unique, not null, indexed |
| title | String(256) | nullable |
| bug | String(256) | nullable |
| state | Integer | not null, indexed |

Regression state values:

| Value | Name             |
|-------|------------------|
| 0     | detected         |
| 1     | staged           |
| 2     | active           |
| 3     | not_to_be_fixed  |
| 4     | ignored          |
| 5     | fixed            |
| 6     | detected_fixed   |

The DB layer validates state values on create and update.

### `{suite}_RegressionIndicator`

| Column | Type | Constraints |
|--------|------|-------------|
| id | Integer | PK |
| regression_id | Integer FK → Regression | not null, indexed |
| field_change_id | Integer FK → FieldChange | not null |

- Unique constraint on `(regression_id, field_change_id)`.
- Many-to-many join table between Regression and FieldChange.

### Tables dropped from v4

- **Baseline**: v5 comparisons are stateless API operations.
- **ChangeIgnore**: There is no "ignore" state on FieldChanges. If a field
  change is not relevant, it should not be created. The external process that
  creates field changes is responsible for filtering.
- **Profile**: Profiling is a separate concern.
- **Order**: Replaced by Commit.


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

All FieldChanges and Regressions are created, updated, and deleted via the API.
There is no `regenerate_fieldchanges_for_run()` or
`identify_related_changes()`. The v5 DB layer provides CRUD only.

Regression detection is the responsibility of an external process (a separate
tool or CI job) that analyzes time-series data and creates FieldChanges via the
API when it detects significant changes.


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

- Orders → Commits: primary order field value becomes the commit string,
  linked-list position becomes the ordinal.
- v4 `tag` column on Order → a `label` commit_field (if defined in the schema).
- Run.order_id → Run.commit_id; Run.start_time → Run.submitted_at.
- FieldChange.field_id FK → FieldChange.field_name string (resolved from
  the SampleField metatable).
- Baseline, ChangeIgnore, Profile tables are not migrated.


## D13: Profiles (Deferred)

Profile support is not part of the initial v5 database layer. The v4 Profile
table is dropped and no replacement is provided. Profile support will be
designed and added in a future iteration.
