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
  Can be set inline in a run submission, at creation via
  `POST /api/suites/{testsuite}/commits`, or at any later time via PATCH;
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

Test suite schemas are created via the API (`POST /api/suites`), evolved via
`PATCH /api/suites/{name}/schema`, and persisted in the database.

Two global tables hold this state: `schema`, with one row per suite, and
`schema_version`, a single-row counter. See D5 for their columns.

All rows from `schema` are read and in-memory models for the schemas are built, and
the `schema_version` counter is cached alongside them. This may happen at startup or on
first use; correctness does not depend on which, because of the comparison below. A
build that loads at startup must not refuse to serve when the load fails -- an
unreachable database is what `GET /healthz` exists to report (see R7), and it becomes
reachable again without the process restarting.

**Multi-process safety**: In a multi-worker deployment, when one worker creates,
modifies, or deletes a suite, it bumps the `schema_version` counter in the same
transaction. Every request path that reads the in-memory suite registry must first
compare its cached version counter against the database. When a mismatch is detected, all
schemas are reloaded from the database. The check is a single-row integer read
per request.

The counter and the schemas must be read consistently with each other -- from one
snapshot. Read separately they can straddle another worker's commit, and in one of the
two orders the reader ends up caching a counter *newer* than the schemas beside it, so it
stops reloading and serves stale schemas until the next unrelated change.

**Writes do not read the registry**: a write that changes a suite derives the schema it
is changing from the stored row, taken under a lock that serializes writes to that suite,
never from the cached copy. The cache is permitted to lag by a commit, so two concurrent
changes derived from it would each silently discard the other's -- while still applying
their own column changes, leaving the tables and the stored schema permanently
disagreeing. For the same reason every write takes that lock *before* it alters any
table, so that a change and a deletion of one suite cannot each hold what the other
needs.

**A stale reader is answered, not silently wrong**: between a reader's version check and
its next query, another worker can remove a field, so a request can reach a column that
no longer exists. That window cannot be closed cheaply and is not required to be. A
request that hits it must report a conflict (409) rather than a 500 -- the schema changed
underneath it, and retrying will succeed.

**Schema evolution**: A suite's `metrics`, `commit_fields`, and `machine_fields`
lists can be changed after creation via `PATCH /api/suites/{name}/schema`, which
adds, updates, and/or removes entries in any of the three. This is the only way a
suite comes to accept metadata it did not declare at creation: undeclared keys are
rejected on submission for both machines and commits (see D6).

- **Adding** an entry leaves existing rows with no value for it.
- Only presentation metadata can be **updated**: whichever of
  `display_name`, `unit`, `unit_abbrev`, `bigger_is_better`, `searchable`, and
  `display` the entry accepts (see D4). A `type` cannot be changed in place,
  because the conversion is not always defined (`text` to `integer` can fail
  per row, `real` to `integer` truncates).
- **Removing** an entry permanently destroys every value stored for it. Because
  those values are destroyed, an implementation may reuse whatever storage the
  removed entry occupied.

In an `update` entry, a key the request omits leaves the stored value unchanged. An
explicit `null` clears one of the nullable keys (`display_name`, `unit`, `unit_abbrev`);
the boolean keys (`bigger_is_better`, `searchable`, `display`) are not nullable, because
D4 normalizes them to `false` rather than to null, so `null` on one of them is rejected
(400).

Notes:
- Renaming is not supported; it is semantically a remove plus an add.
- A schema change is atomic -- it applies entirely or not at all.
- The same field cannot be the target of more than one add/update/remove operation in a
  given query, counting repeats within a single operation's own list.
- The resulting schema is validated in full, exactly as if it had been supplied to `POST /api/suites`,
  rather than only the entries the request touched.


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

A test suite's schema is a JSON document: it is the body of `POST /api/suites`,
the body `GET /api/suites/{name}` returns, and what the `schema` table stores
(see D2 and D5). This is a clean break from v4, where
suites were defined by YAML files shipped alongside the server -- in v5 a schema
only ever exists as JSON travelling over the API. The two formats still share
much of their vocabulary.

```json
{
  "name": "nts",
  "metrics": [
    {
      "name": "compile_time",
      "type": "real",
      "display_name": "Compile Time",
      "unit": "seconds",
      "unit_abbrev": "s",
      "bigger_is_better": false
    },
    {"name": "execution_time", "type": "real"},
    {"name": "compile_status", "type": "integer"}
  ],
  "machine_fields": [
    {"name": "hardware", "type": "text", "searchable": true},
    {"name": "os", "type": "text", "searchable": true},
    {"name": "core_count", "type": "integer"}
  ],
  "commit_fields": [
    {"name": "git_sha", "type": "text", "searchable": true},
    {"name": "author", "type": "text", "searchable": true},
    {"name": "commit_message", "type": "text"},
    {"name": "commit_timestamp", "type": "datetime"}
  ]
}
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
- There is no `format_version` in the schema (only one format exists for v5).

**Presentation keys**: beyond `name` and `type`, each list accepts only the
optional keys that mean something for it. A key outside its list's set is
rejected with 400.

| List | Accepts, in addition to `name` and `type` |
|------|-------------------------------------------|
| `metrics` | `display_name`, `unit`, `unit_abbrev`, `bigger_is_better` |
| `commit_fields` | `display_name`, `searchable`, `display` |
| `machine_fields` | `display_name`, `searchable` |

Only metrics allow `bigger_is_better`. Only commit or machine fields may be searchable,
and only a commit field can be the UI's display value.

**Normalization**: the stored and returned form of a schema carries every
optional key explicitly, filled in with the default below when the submitted
document omitted it. This makes a suite fetched from one instance postable
verbatim to another, so these defaults are part of the wire contract.

| Key | Default |
|-----|---------|
| `display_name` | `null` |
| `unit`, `unit_abbrev` | `null` |
| `bigger_is_better` | `false` |
| `searchable` | `false` |
| `display` | `false` |

An omitted `display_name` normalizes to `null`. A schema that omits one of the three
lists entirely gets it back as an empty list.

**Suite name**: `name` must match `^[a-z][a-z0-9_]*$` and be at most 63
characters; anything else is rejected with 400. The name is also the name of
the namespace holding the suite's tables (see D5), so some names that satisfy
the pattern are rejected with 400 anyway, because a namespace cannot be created
under them: `public` and `information_schema` already exist in every database,
and PostgreSQL reserves the `pg_` prefix for its own use -- so every name
beginning with `pg_` is rejected.

**Entry names**: every `name` in `metrics`, `commit_fields`, and
`machine_fields` follows the same rule as the suite name -- it must match
`^[a-z][a-z0-9_]*$` and be at most 63 characters -- for the same reason: an
entry becomes a column, so it is an identifier too. The rule deliberately does
not exclude the SQL reserved words (`order`, `user`, `table` are all legal
entry names); an implementation quotes identifiers rather than restricting
valid names for a metric.

A name must be unique within its list, but the three lists are independent: a
metric and a machine field may share a name, because they are columns on
different tables. A name that collides with a built-in column on the table the
entry extends is rejected (see D5 for each table's built-ins).


## D5: Data Model

The v5 tables fall into two groups: **global tables**, which exist once per
instance, and **per-suite tables**, which are created for each test suite.

**Timestamp convention**: All timestamp columns are `TIMESTAMP WITH TIME ZONE`,
storing timezone-aware UTC values. Implementations
must ensure timestamps are converted to UTC before storage. API responses
serialize timestamps as ISO 8601 with `Z` suffix (e.g., `"2026-04-15T14:30:00Z"`).

**Index convention**: A `unique` constraint or primary key implies an index, and
compound indexes are listed in each table's notes. `indexed` therefore marks
only those columns that need a single-column index of their own and are not
already unique.

### Global Tables

These exist once per instance, independent of any test suite. They live in the
database's default namespace, whereas every per-suite table lives in a namespace
of its own named after its suite (see below).

#### `schema`

| Column | Type | Constraints |
|--------|------|-------------|
| name | VARCHAR | PK |
| schema_json | TEXT | not null |
| created_at | TIMESTAMP WITH TIME ZONE | not null |

- One row per test suite, holding the suite's schema (see D4).
- `schema_json` holds the *normalized* schema -- the same content
  `GET /api/suites/{name}` returns, with omitted optional keys filled in --
  rather than the request body as submitted. It is stored as text rather than
  JSONB because the server never queries into it: it is read whole, parsed
  into the in-memory model, and written whole.
- See D4 for limits on the schema name.

#### `schema_version`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK, always `1` |
| version | INTEGER | not null |

- Exactly one row, created with `version = 0` when the database is initialized
  (see D14) and never deleted. Readers may rely on its presence; `id` is fixed
  at `1` so that the row is addressable without a search.
- Bumped whenever a suite is created, modified, or deleted, so that other
  workers can detect that their cached schemas are stale (see D2).

#### `api_key`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| prefix | VARCHAR(8) | unique, not null |
| key_hash | VARCHAR(64) | unique, not null |
| name | VARCHAR(256) | not null |
| scope | VARCHAR(32) | not null |
| created_at | TIMESTAMP WITH TIME ZONE | not null |
| last_used_at | TIMESTAMP WITH TIME ZONE | nullable |
| is_active | BOOLEAN | not null, default `true` |

- `prefix` is the leading 8 characters of the token (see R5). Because the token
  itself is unrecoverable once hashed, the prefix is the only stable handle to
  a key, and it is what the API uses to address one. It is unique, so a prefix
  is never reused. Since it is derived from the token rather than chosen
  independently, a freshly generated token whose prefix collides with an
  existing key's is discarded and a new token generated, rather than the
  request failing.
- `key_hash` is the token's hash (see R5). No part of the token beyond
  `prefix` is stored in recoverable form.
- `name` is a human-readable label and is deliberately not unique: two keys may
  share a name.
- `scope` is one of `read`, `submit`, `triage`, `manage`, `admin` (see R5). The
  DB layer validates it on create. It is stored as text rather than as an
  integer code (unlike `{suite}.regression.state`, below) because it is read
  once per authenticated request and never filtered or sorted on, so
  legibility in the database is worth more than compactness.
- `last_used_at` is null until the key is first used. It is recorded on
  successful authentication on a best-effort basis: an implementation may
  coalesce or drop these writes, so the value may lag actual use. It is not an
  audit log, and clients must not rely on its precision. Writing it must not
  participate in the request's transaction and no request's outcome may depend
  on it -- a single key may be shared by many submitting bots, so an in-transaction
  update would serialize every request using that key behind a single row lock held
  for the length of each request.
- `is_active` is false once the key has been revoked. Revocation does not
  delete the row (see the Admin section of the endpoints spec).

### Per-Suite Tables

Each suite's tables live in a namespace of their own, named after the suite: a
PostgreSQL schema called `{suite}`, holding `commit`, `machine`, `run`, `test`,
`sample`, `regression`, `regression_indicator` and `profile`. A table is
therefore addressed as `{suite}.commit`, and the entity names below are given in
that form.

#### `{suite}.commit`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| commit | VARCHAR(256) | unique, not null |
| ordinal | INTEGER | nullable, unique |
| tag | VARCHAR(256) | nullable, indexed (partial: WHERE tag IS NOT NULL) |
| _(dynamic)_ | per commit_fields | nullable |

- `commit` is the identity string, submitted as `commit.value` (see D6). Used
  as the default display value in the UI unless a `commit_field` with
  `display: true` is defined and populated.
- `ordinal` has a regular unique constraint.
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

#### `{suite}.machine`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| name | VARCHAR(256) | unique, not null |
| tracked | BOOLEAN | not null, default `true` |
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
- Dynamic columns are created from `machine_fields` in the schema (see D3 for
  the type-to-column mapping). Keys submitted for a machine that are not declared
  as `machine_fields` are rejected (see D6).
- Schema-defined `machine_fields` names must not collide with built-in column
  names (`id`, `name`, `tracked`). The schema parser rejects these.
- `last_run_at` is not a column. It is the `submitted_at` of the machine's most
  recent run, or null when the machine has no runs, derived on read; the machine
  endpoints expose it and can sort on it. It is deliberately not stored: a stored
  copy would have to be recomputed whenever a run is deleted and would entail
  additional synchronization on submission. Deriving it is cheap because a suite
  has few machines and the compound index on `{suite}.run(machine_id, submitted_at)`
  reduces it to one index probe each; an implementation must not compute it by
  aggregating over the whole run table.
- Cascade: deleting a machine cascades to its runs (and transitively to their
  samples and profiles), and to every RegressionIndicator naming it. A
  regression left with no indicators is not itself deleted: it keeps its title,
  bug, notes, and commit, and an empty indicator set is a legal state.

#### `{suite}.run`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| uuid | VARCHAR(36) | unique, not null |
| machine_id | INTEGER FK -> Machine | not null |
| commit_id | INTEGER FK -> Commit | not null, indexed |
| submitted_at | TIMESTAMP WITH TIME ZONE | not null |
| run_parameters | JSONB | not null, default `{}` |

- Every run must have a commit (`commit_id` is not null).
- `submitted_at` is recorded by the server when the run is accepted; a
  submission cannot supply it (see D6).
- Compound index on `(machine_id, submitted_at)`. Its leading column serves
  lookups of all runs for a machine, and the pair keeps both
  `GET /api/suites/{testsuite}/machines/{name}/runs?sort=-submitted_at` and the
  `last_run_at` aggregate described under `{suite}.machine` to a bounded index
  scan rather than a scan of this table.
- Cascade: deleting a run cascades to its samples and profiles.

#### `{suite}.test`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| name | VARCHAR(256) | unique, not null |

- Nothing deletes a test: the Tests endpoint is read-only and tests are created
  implicitly by run submission. The references to this table from `sample`,
  `profile`, and `regression_indicator` therefore cascade nowhere, and a
  deletion attempted anyway is refused.

#### `{suite}.sample`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| run_id | INTEGER FK -> Run | not null |
| test_id | INTEGER FK -> Test | not null |
| _(dynamic)_ | per metrics | nullable |

- Compound index on `(run_id, test_id)` -- covers "all samples for a run".
- Compound index on `(test_id, run_id)` -- covers time-series queries.
- Dynamic columns from schema metrics (see D3 for the type-to-column mapping).
- Metric names must not collide with built-in column names (`id`, `run_id`,
  `test_id`), nor with the keys the submission format reserves inside a test
  entry (see D6).

#### `{suite}.regression`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| uuid | VARCHAR(36) | unique, not null |
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

#### `{suite}.regression_indicator`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| uuid | VARCHAR(36) | unique, not null |
| regression_id | INTEGER FK -> Regression | not null |
| machine_id | INTEGER FK -> Machine | not null |
| test_id | INTEGER FK -> Test | not null |
| metric | VARCHAR(256) | not null |

- Unique constraint on `(regression_id, machine_id, test_id, metric)`. Its
  leading column also serves lookups of all indicators for a regression.
- Each indicator represents one (machine, test, metric) combination
  affected by the regression.

#### `{suite}.profile`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| uuid | VARCHAR(36) | unique, not null |
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
- **Profile**: Redesigned for v5 (see `{suite}.profile` above).
- **Order**: Replaced by Commit.


## D14: Database Initialization and Evolution

The two groups of tables in D5 come into being by two different mechanisms,
because they are defined by different things.

**Per-suite tables are defined by data.** A suite's schema decides which tables
exist and which columns they carry, so no description written in advance could
cover them. They are created by `POST /api/suites`, altered by
`PATCH /api/suites/{name}/schema`, and dropped by `DELETE /api/suites/{name}`
(see D2). This is ordinary request handling, not initialization.

**Global tables are defined by code.** `schema`, `schema_version`, and
`api_key` are fixed by the server build rather than by anything a user submits.
A database must therefore be brought to the structure the running build expects
before that build serves traffic, and must be brought forward again whenever a
later build changes it. This is what "when the database is initialized" in D5
refers to.

Requirements on that mechanism:

- **Ordered and recorded.** Changes to the global tables form a sequence, and
  the database records how far along it is, so that a build can tell what
  remains to be applied. Creating the tables in an empty database is the first
  step of that sequence, not a separate path.
- **Idempotent.** Applying it against an already-current database does nothing
  and succeeds. The server applies it on every start, so doing nothing is the
  common case.
- **All-or-nothing per step.** A step that fails leaves the database as it was.
- **Safe under concurrency.** At most one process may apply changes at a time,
  and the others wait rather than failing. Two servers starting against one
  database is normal: a deployment that replaces the instance overlaps the
  outgoing and incoming ones.
- **Confined to the default namespace.** The mechanism must not create, alter, or
  drop anything in a suite's namespace, and must not treat its contents as
  something to reconcile. A tool that compares the database against the global
  definitions would otherwise see every per-suite table as unaccounted for, and
  propose dropping all of them.
- **Seeds `schema_version`.** The single row D5 requires (`id = 1`,
  `version = 0`) exists from the moment the global tables do, so that every
  reader can address it without coping with its absence.

The server applies it at startup, before it begins serving, and refuses to
serve if it fails -- a server whose tables are not those its code expects would
fail every request. It is also available as a standalone administrative
operation, so an operator can apply or inspect it without starting a server.
