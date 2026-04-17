# v5 Database Layer: Data Model

This document defines the v5 database architecture, the Commit concept, schema
storage and format, and all table definitions.

For the exploration and discussion that led to the Commit concept, see
[`../v5-discussion-about-orders.md`](../v5-discussion-about-orders.md).
For operations (submission, queries, migration), see
[`operations.md`](operations.md).


## D1: Architecture and Separation

- The v5 DB layer lives in `lnt/server/db/v5/`, a self-contained package with
  its own schema parsing, models, and CRUD interface.
- No imports from v4 DB code (`lnt.server.db.testsuite`, `testsuitedb`,
  `v4db`, `regression`). The v5 package is fully independent.
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
in the same transaction. Every v5 request path -- API endpoints and SPA shell
pages alike -- must compare its cached version counter against the database
before reading the in-memory suite registry. When a mismatch is detected, all
schemas are reloaded from the database. The check is a single-row integer read
per request.


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
- `run_fields` section is removed entirely -- extra run data goes in
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

**Timestamp convention**: All `DateTime` columns store timezone-aware UTC
timestamps (`TIMESTAMP WITH TIME ZONE` in PostgreSQL). Implementations
must ensure timestamps are converted to UTC before storage. API responses
serialize timestamps as ISO 8601 with `Z` suffix
(e.g., `"2026-04-15T14:30:00Z"`).

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
  samples). Commits referenced by a Regression's commit_id cannot be deleted
  (the API returns 409).
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
| machine_id | Integer FK -> Machine | not null, indexed |
| commit_id | Integer FK -> Commit | not null, indexed |
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
| run_id | Integer FK -> Run | not null |
| test_id | Integer FK -> Test | not null |
| _(dynamic)_ | per metrics | nullable |

- Compound index on `(run_id, test_id)`.
- Dynamic columns from schema metrics: `real` -> Float, `status` -> Integer,
  `hash` -> String(256).

### `{suite}_Regression`

| Column | Type | Constraints |
|--------|------|-------------|
| id | Integer | PK |
| uuid | String(36) | unique, not null, indexed |
| title | String(256) | nullable |
| bug | String(256) | nullable |
| notes | Text | nullable |
| state | Integer | not null, indexed |
| commit_id | Integer FK -> Commit | nullable, indexed |

Regression state values:

| Value | Name             |
|-------|------------------|
| 0     | detected         |
| 1     | active           |
| 2     | not_to_be_fixed  |
| 3     | fixed            |
| 4     | false_positive   |

The DB layer validates state values on create and update.

### `{suite}_RegressionIndicator`

| Column | Type | Constraints |
|--------|------|-------------|
| id | Integer | PK |
| uuid | String(36) | unique, not null, indexed |
| regression_id | Integer FK -> Regression | not null, indexed |
| machine_id | Integer FK -> Machine | not null |
| test_id | Integer FK -> Test | not null |
| metric | String(256) | not null |

- Unique constraint on `(regression_id, machine_id, test_id, metric)`.
- Each indicator represents one (machine, test, metric) combination
  affected by the regression.

### Tables Dropped from v4

- **Baseline**: v5 comparisons are stateless API operations.
- **ChangeIgnore**: Dropped. Noise dismissal happens at the regression level
  via the `false_positive` state with notes.
- **FieldChange**: Dropped. Regressions directly reference affected machines,
  tests, and metrics via RegressionIndicator.
- **Profile**: Profiling is a separate concern.
- **Order**: Replaced by Commit.
