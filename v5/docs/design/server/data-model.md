# v5 Database Layer: Data Model

This document defines the v5 database architecture, the Commit concept, schema
storage and format, and all table definitions.

## D1: The Commit Concept (replaces Orders)

The v4 "Order" concept conflated three concerns: identity (what groups runs),
ordering (sequential position for time-series), and display (what the UI shows).
The v5 "Commit" concept separates these.

- **Commit**: A named point that groups runs. The `commit` column is a single
  string (e.g., a Git SHA, version number, or ad-hoc label like
  `"experiment-vectorizer-v2"`). It is the identity of the commit. By default,
  the UI also uses it for display, but a `commit_field` marked `display: true`
  overrides what is shown (see D4). Every run must have a commit.
- **Ordinal**: An optional integer that places the commit in a total order.
  Can be set at creation (`POST /api/suites/{testsuite}/commits`) or at any later
  time via PATCH;
  never inferred from the commit string (even if the string is numeric).
  `NULL` means unordered.

Two tiers of runs:
1. Run with ordered commit (ordinal set): full time-series participation.
2. Run with unordered commit (ordinal NULL): grouped but not positioned in the
   time series. Used for throwaway A/B comparisons (use an ad-hoc commit
   string like `"experiment-vectorizer-v2"`), or as the transient state before
   an external process assigns an ordinal.

Deletion: any commit can be deleted via the API (ordered or unordered),
which cascades to its runs, and transitively to their samples and profiles
(see D5). This is commonly used to clean up unordered commits (e.g. throwaway
A/B experiments) that are no longer needed, but ordered commits can be
deleted too.


## D2: Schema Storage and Lifecycle

Test suite schemas are created via the API (`POST /api/suites`) and
persisted in the database.

**Global tables** (not per-suite, shared across all suites):

| Table | Columns |
|---|---|
| `schema` | `name` (VARCHAR PK), `schema_json` (TEXT), `created_at` (TIMESTAMP WITH TIME ZONE) |
| `schema_version` | `id` (INTEGER PK), `version` (INTEGER) |

On startup, all rows from `schema` are read and in-memory models for the schemas are
built. The `schema_version` counter is cached.

**Multi-process safety**: In a multi-worker deployment, when one worker creates or
deletes a suite, it bumps the `schema_version` counter in the same transaction.
Every request path must compare its cached version counter against the database
before reading the in-memory suite registry. When a mismatch is detected, all
schemas are reloaded from the database. The check is a single-row integer read
per request.


## D3: Attribute Types

`metrics`, `commit_fields`, and `machine_fields` entries each declare a `type`
drawn from one shared set of attribute types. `type` is required on every
entry in all three lists -- there is no default type. Schema creation is
rejected (400) if `type` is missing or is not one of the values below.

| Type       | Meaning                | SQL column type             | JSON representation         |
|------------|------------------------|------------------------------|------------------------------|
| `real`     | Floating-point number  | DOUBLE PRECISION             | number                       |
| `integer`  | Whole number           | INTEGER                      | number                       |
| `text`     | Free-form string       | TEXT                         | string                       |
| `datetime` | Timestamp              | TIMESTAMP WITH TIME ZONE     | ISO 8601 string, `Z` suffix  |

Note that `searchable: true` (D4, D9) is only valid on `text`-typed entries. Setting
`searchable: true` on a `real`, `integer`, or `datetime` field is rejected (400) at
schema-creation time.

**Numeric types**: `real` and `integer` together are the *numeric* types.
Wherever the design needs a metric to be quantitative (e.g. geomean aggregation),
the requirement is that the metric be numeric. Arithmetic over both `real` and
`integer` metrics are well-defined, and both are useful to represent different
kinds of quanitites (e.g. code size, execution time).

Being numeric does not, however, guarantee a metric is a meaningful
*quantity*. An `integer` metric may encode an enum (a status code, say), and a
`real` metric may be signed, in which case a geomean silently skips its
non-positive samples. The type system deliberately does not try to catch this
-- type describes the data's representation, not its suitability for a given
aggregation. Picking a sensible metric is the schema author's responsibility.


## D4: Schema Format

Each test suite is defined by a YAML schema file. The v5 format is a clean
break from v4, but still shares similarities.

```yaml
name: nts

metrics:
- name: compile_time
  type: real
  display_name: Compile Time
  unit: seconds
  unit_abbrev: s
  bigger_is_better: false
- name: execution_time
  type: real
- name: compile_status
  type: integer

machine_fields:
- name: hardware
  type: text
  searchable: true
- name: os
  type: text
  searchable: true
- name: core_count
  type: integer

commit_fields:
- name: git_sha
  type: text
  searchable: true
- name: author
  type: text
  searchable: true
- name: commit_message
  type: text
- name: commit_timestamp
  type: datetime
```

Notes:
- `metrics`, `commit_fields`, and `machine_fields` entries all declare a
  `type` from the shared attribute types (see D3).
- `commit_fields` and `machine_fields` define optional metadata columns on
  the Commit and Machine tables, respectively.
- `searchable: true` on a commit_fields or machine_fields entry enables
  `?search=` substring matching on the corresponding list API endpoint (see
  D9). Only valid on `text`-typed fields (see D3).
- `display: true` on at most one `commit_field` is a hint for the UI: when set
  and the field has a non-null value, the UI shows that value instead of the
  raw commit string (e.g., a shortened SHA, a version tag). This is purely a
  UI concern -- the DB layer does not treat display fields specially. A schema
  with more than one `commit_field` marked `display: true` is rejected at
  schema-creation time (400).
- There is no `format_version` in the schema file (only one format exists for v5).


## D5: Data Model

Per-suite tables are dynamically named (e.g., `nts_Commit`, `nts_Run`).

**Timestamp convention**: All timestamp columns are `TIMESTAMP WITH TIME ZONE`,
storing timezone-aware UTC values. Implementations
must ensure timestamps are converted to UTC before storage. API responses
serialize timestamps as ISO 8601 with `Z` suffix (e.g., `"2026-04-15T14:30:00Z"`).

### `{suite}_Commit`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| commit | VARCHAR(256) | unique, not null |
| ordinal | INTEGER | nullable, unique |
| tag | VARCHAR(256) | nullable, indexed (partial: WHERE tag IS NOT NULL) |
| _(dynamic)_ | per commit_fields | nullable |

- `commit` is the identity string provided by submitters. Used as the default
  display value in the UI unless a `commit_field` with `display: true` is
  defined and populated.
- `ordinal` has a regular unique constraint. Ordinals are assigned once by an
  external process and are not expected to be reassigned.
- `tag` is an optional human-readable label (e.g., `release-18.1`). Set
  exclusively via `PATCH /api/suites/{testsuite}/commits/{value}` (never during submission).
  Multiple commits may share the same tag. The tag is always included in
  `?search=` substring matching (see D9). When set, the UI appends it to the
  display value as `<display_value> (tag)`.
- Dynamic columns are created from `commit_fields` in the schema (see D3 for
  the type-to-column mapping).
- Commits are deletable (regardless of whether `ordinal` is set). Deleting a
  commit cascades to its runs, which in turn cascade to their samples and
  profiles. Commits referenced by a Regression's `commit_id` cannot be
  deleted (409).
- Schema-defined `commit_fields` names must not collide with built-in column
  names (`id`, `commit`, `ordinal`, `tag`). The schema parser rejects these.

### `{suite}_Machine`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| name | VARCHAR(256) | unique, not null |
| tracked | BOOLEAN | not null, default `true` |
| parameters | JSONB | not null, default `{}` |
| _(dynamic)_ | per machine_fields | nullable |

- `name` uniqueness is enforced
- `tracked` marks whether the machine is part of the set LNT monitors over
  time. It governs *automatic* machine selection only -- untracked machines are
  excluded when the server or UI picks machines on the user's behalf (like the
  Dashboard's trend overview; see the client docs), but remain fully addressable
  everywhere a machine is chosen deliberately. It carries no lifetime policy:
  untracked machines are permanent and are not cleaned up. Typical uses are
  one-off comparison configurations (e.g. the same hardware built at `-O2`
  and `-O3`) and retired hardware whose history is worth keeping.
- `parameters` stores extra key-value data as Postgres JSONB.
- Dynamic columns are created from `machine_fields` in the schema (see D3 for
  the type-to-column mapping).
- Schema-defined `machine_fields` names must not collide with built-in column
  names (`id`, `name`, `tracked`, `parameters`). The schema parser rejects these.
- Cascade: deleting a machine cascades to its runs.

### `{suite}_Run`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| uuid | VARCHAR(36) | unique, not null, indexed |
| machine_id | INTEGER FK -> Machine | not null, indexed |
| commit_id | INTEGER FK -> Commit | not null, indexed |
| submitted_at | TIMESTAMP WITH TIME ZONE | not null |
| run_parameters | JSONB | not null, default `{}` |

- Every run must have a commit (`commit_id` is not null).
- `submitted_at` replaces v4's `start_time`/`end_time`.
- Cascade: deleting a run cascades to its samples and profiles.

### `{suite}_Test`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| name | VARCHAR(256) | unique, not null |

### `{suite}_Sample`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| run_id | INTEGER FK -> Run | not null |
| test_id | INTEGER FK -> Test | not null |
| _(dynamic)_ | per metrics | nullable |

- Compound index on `(run_id, test_id)` — covers "all samples for a run".
- Compound index on `(test_id, run_id)` — covers time-series queries.
- Dynamic columns from schema metrics (see D3 for the type-to-column mapping).

### `{suite}_Regression`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| uuid | VARCHAR(36) | unique, not null, indexed |
| title | VARCHAR(256) | nullable |
| bug | VARCHAR(256) | nullable |
| notes | TEXT | nullable |
| state | INTEGER | not null, indexed |
| commit_id | INTEGER FK -> Commit | nullable, indexed |

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
| id | INTEGER | PK |
| uuid | VARCHAR(36) | unique, not null, indexed |
| regression_id | INTEGER FK -> Regression | not null, indexed |
| machine_id | INTEGER FK -> Machine | not null |
| test_id | INTEGER FK -> Test | not null |
| metric | VARCHAR(256) | not null |

- Unique constraint on `(regression_id, machine_id, test_id, metric)`.
- Each indicator represents one (machine, test, metric) combination
  affected by the regression.

### `{suite}_Profile`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| uuid | VARCHAR(36) | unique, not null, indexed |
| run_id | INTEGER FK -> Run | not null |
| test_id | INTEGER FK -> Test | not null, indexed |
| created_at | TIMESTAMP WITH TIME ZONE | not null |
| data | BYTEA | not null |

- Unique constraint on `(run_id, test_id)` -- at most one profile per
  run+test pair.
- `data` stores the profile binary blob (base64-decoded on submission).
  It must be excluded from the default result set when querying this table;
  it may only be loaded when a request explicitly needs the blob.
- `uuid` is server-generated, used by the API for profile data endpoints.
  (Unlike Run UUIDs, which may be client-provided, Profile and Regression
  UUIDs are always server-generated.)
- Cascade: deleting a run cascades to its profiles.
- Maximum accepted profile size on submission: 50 MB (decoded). Submissions
  exceeding this are rejected.

### Tables Dropped from v4

- **Baseline**: v5 comparisons are stateless API operations.
- **ChangeIgnore**: Dropped. Noise dismissal happens at the regression level
  via the `false_positive` state with notes.
- **FieldChange**: Dropped. Regressions directly reference affected machines,
  tests, and metrics via RegressionIndicator.
- **Profile**: Redesigned for v5 (see `{suite}_Profile` above).
- **Order**: Replaced by Commit.
