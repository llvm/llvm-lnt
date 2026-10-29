# v5 Database Layer: Data Model

This document defines the v5 database architecture, the Commit concept, schema
storage and format, and all table definitions.

## D1: The Commit Concept (replaces Orders)

The v4 "Order" concept mixed three concerns: identity (what groups runs),
ordering (position in the time series), and display (what the UI shows). The
v5 "Commit" concept separates them.

- **Commit**: a named point that groups runs. The `commit` column is a single
  string (e.g. a Git SHA, a version number, or an ad-hoc label like
  `"experiment-vectorizer-v2"`), and it is the commit's identity. By default
  the UI also displays it, but a `commit_field` marked `display: true`
  overrides what is shown (see D4). Every run must have a commit.
- **Ordinal**: an optional integer that places the commit in a total order. It
  can be set inline in a run submission, at creation via
  `POST /api/suites/{testsuite}/commits`, or at any later time via PATCH. It is
  never inferred from the commit string, even if the string is numeric. `NULL`
  means unordered.

Runs therefore come in two tiers:
1. A run on an ordered commit (ordinal set) takes full part in time series.
2. A run on an unordered commit (ordinal NULL) is grouped, but has no position
   in time series. This is used for throwaway
   A/B comparisons (with an ad-hoc commit string like
   `"experiment-vectorizer-v2"`), or as a transient state until an external
   process assigns an ordinal.

**Deletion**: any commit can be deleted through the API, ordered or not.
Deleting a commit deletes its runs, and in turn their samples and profiles (see
D5). The regressions attributed to it are kept, with no commit.

A commit can also ask to be deleted automatically once it has seen no activity
for a given number of days (see O10). This is how the commits of throwaway A/B
experiments clean up after themselves. The request has no effect while the
commit has an ordinal: an ordered commit is part of the suite's history.


## D2: Schema Storage and Lifecycle

Test suite schemas are created through the API (`POST /api/suites`), evolved
with `PATCH /api/suites/{name}/schema`, and stored in the database.

Two global tables hold this state: `schema`, with one row per suite, and
`schema_version`, a single-row counter. See D5 for their columns.

The server reads every row of `schema`, builds an in-memory model of each
schema, and caches the `schema_version` counter alongside them. This may happen
at startup or on first use; correctness does not depend on which. An
implementation that loads at startup must still serve if the load fails.

**Multi-process safety.** In a deployment with several workers, a worker that
creates, modifies or deletes a suite bumps the `schema_version` counter in the
same transaction. Every request path that reads the in-memory suite registry
must first compare its cached counter with the one in the database, and reload
all schemas from the database if they differ. This check is a single-row
integer read per request.

The counter and the schemas must be read from the same snapshot: a reader must
never cache a counter that is newer than the schemas cached with it.

A reader's version check must be able to see writes that committed after its
request began, so an implementation must not read the counter under a
transaction snapshot fixed at the start of the transaction.

**Schema writes do not read the registry.** A write that changes a suite's
*schema* reads the schema it is changing from the stored row, under a lock that
serializes schema writes to that suite. It never uses the cached copy, which
is allowed to lag by a commit. Every such write takes that lock *before* it
changes any table. Ordinary data writes, such as creating a machine or
submitting a run, are not covered by this rule: they derive nothing from the
schema that they could lose, and read the registry like any other request.

A schema write waits only a bounded time for the locks it needs, and returns a
retryable 409 (`retry`, see I4) rather than waiting indefinitely. This wait must
be shorter than the time a request waits for a database connection, so that
schema changes queued behind a long-running reader cannot exhaust the
connection pool. A request and a concurrent schema change may also deadlock.
Avoiding that is not required, but whichever one is aborted gets the same
retryable 409.

**A stale reader gets an answer, not a silently wrong result.** Between a
reader's version check and its next query, another worker may remove a field,
so a request can reach a column that no longer exists. Closing that window is
not required, but a request that hits it must return the same retryable 409
(`retry`) rather than a 500.
A streaming response (see I2) that has already started cannot change its
status, so it is aborted instead.

**Schema evolution.** A suite's `metrics`, `commit_fields` and
`machine_fields` lists can be changed after creation with
`PATCH /api/suites/{name}/schema`, which adds, updates and/or removes entries
in any of the three. This is the only way a suite can start accepting metadata
it did not declare at creation: undeclared keys are rejected on submission, for
both machines and commits (see O2).

- **Adding** an entry leaves existing rows with no value for it.
- Only presentation metadata can be **updated**: whichever of `display_name`,
  `unit`, `unit_abbrev`, `bigger_is_better`, `dashboard`, `searchable`,
  `display` and `listed` the entry accepts (see D4). A `type` cannot be changed
  in place, because the conversion is not always defined (`text` to `integer`
  can fail for some rows, and `real` to `integer` truncates).
- **Removing** an entry permanently destroys every value stored for it. Since
  those values are destroyed, an implementation may reuse whatever storage the
  removed entry used. Removing a metric also removes every regression
  indicator naming it and every run summary of it (see D5); re-adding a metric
  with the same name brings none of them back.

In an `update` entry, an omitted key leaves the stored value unchanged. An
explicit `null` clears one of the nullable keys (`display_name`, `unit`,
`unit_abbrev`); an empty string does not, and is rejected with 400 (see D4).
The boolean keys (`bigger_is_better`, `dashboard`, `searchable`, `display`,
`listed`) are not nullable, because D4 normalizes them to `false` rather than to
null, so `null` for one of them is rejected with 400.

The same request can change the suite's `repository` (D4), with the same rule:
an omitted key is left unchanged, and an explicit `null` clears one. `null` for
the whole `repository` is rejected with 400, since there is one way to clear
it, key by key. A change to it destroys nothing and changes no table, but it is
a schema write all the same: it takes the lock above, and bumps
`schema_version`.

Notes:
- Renaming is not supported: it is semantically a remove plus an add.
- A schema change is atomic: it applies entirely or not at all.
- A field cannot be the target of more than one add, update or remove
  operation in a single request, including by being repeated within one
  operation's own list.
- The resulting schema is validated in full, exactly as if it had been sent to
  `POST /api/suites`, not just the entries the request touched.


## D3: Attribute Types

`metrics`, `commit_fields` and `machine_fields` entries each declare a `type`
from one shared set of attribute types. `type` is required on every entry of
all three lists: there is no default type. A schema is rejected with 400, when
it is created or changed, if `type` is missing or is not one of the values
below.

| Type       | Meaning                | SQL column type             | JSON representation         |
|------------|------------------------|------------------------------|------------------------------|
| `real`     | Floating-point number  | DOUBLE PRECISION             | number                       |
| `integer`  | Whole number           | BIGINT                       | number                       |
| `text`     | Free-form string       | TEXT                         | string                       |
| `datetime` | Timestamp              | TIMESTAMP WITH TIME ZONE     | ISO 8601 string, `Z` suffix  |

`searchable: true` (D4, O4) is only valid on `text` entries: setting it on a
`real`, `integer` or `datetime` field is rejected with 400 when the schema is
created or changed. Likewise, `display: true` (D4) is only valid on a `text`
commit field, and `dashboard: true` (D4) only on a numeric metric (see below).

**Only the JSON representation is accepted.** A submitted value whose JSON type
is not the one its declared type calls for is rejected with 400, not
converted: `"5"` is not an `integer`, `5` is not `text`, and `true` is neither.

JSON has a single number type, so each of the two numeric types also accepts
the other's values wherever nothing is lost: an `integer` is accepted where a
`real` is declared, and a number with no fractional part (`8.0`) is accepted
where an `integer` is declared. A number with a fractional part where an
`integer` is declared is rejected, not rounded.

A value that its stored representation cannot hold is rejected with 400:
- an integer outside the range of its column (the column type above for a
  declared `integer`, or the column D5 gives a built-in, such as a commit's
  `ordinal`);
- a non-finite `real` (`NaN` and the infinities are not JSON, but some
  producers emit them anyway);
- a string containing the NUL character (see D5).

The last two apply to every value in a request, including keys and values at
any depth inside a run's `run_parameters`.

A `datetime` is an ISO 8601 string in both directions, and nothing else is
accepted for one. On input, a string with an offset is converted to UTC, and
one without an offset is read as UTC. On output, it is always rendered in UTC
with a `Z` suffix (see D5).

**Numeric types.** `real` and `integer` together are the *numeric* types.
Wherever the design needs a metric to be quantitative (e.g. geomean
aggregation, or a card on the Dashboard), the metric must be numeric.
Arithmetic is well-defined over both `real` and `integer` metrics, and both are
useful for different kinds of quantities (e.g. code size, execution time).

Being numeric does not guarantee that a metric is a meaningful *quantity*,
however. An `integer` metric may encode an enum (a status code, say), and a
`real` metric may be signed, in which case a geomean silently skips its
non-positive samples. The type system deliberately does not try to catch this:
a type describes how data is represented, not whether it suits a given
aggregation. Choosing sensible metrics is the schema author's responsibility.


## D4: Schema Format

A test suite's schema is a JSON document: the body of `POST /api/suites`, the
body `GET /api/suites/{name}` returns, and what the `schema` table stores (see
D2 and D5). This is a clean break from v4, where suites were defined by YAML
files shipped with the server: in v5, a schema only ever exists as JSON sent
through the API. The two formats still share much of their vocabulary.

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
      "bigger_is_better": false,
      "dashboard": true
    },
    {"name": "execution_time", "type": "real", "dashboard": true},
    {"name": "compile_status", "type": "integer"}
  ],
  "machine_fields": [
    {"name": "hardware", "type": "text", "searchable": true},
    {"name": "os", "type": "text", "searchable": true, "listed": true},
    {"name": "core_count", "type": "integer"}
  ],
  "commit_fields": [
    {"name": "git_sha", "type": "text", "searchable": true},
    {"name": "author", "type": "text", "searchable": true},
    {"name": "commit_message", "type": "text"},
    {"name": "commit_timestamp", "type": "datetime", "listed": true}
  ],
  "repository": {
    "label": "GitHub",
    "commit_url": "https://github.com/llvm/llvm-project/commit/{commit}",
    "range_url": "https://github.com/llvm/llvm-project/compare/{from}...{to}"
  }
}
```

Notes:
- `metrics`, `commit_fields` and `machine_fields` entries all declare a `type`
  from the shared attribute types (see D3).
- `commit_fields` and `machine_fields` define optional metadata columns on the
  Commit and Machine tables, respectively.
- `searchable: true` on a commit or machine field makes `?search=` match that
  field in the list endpoints that search commits or machines (see O4). It is
  only valid on `text` fields (see D3).
- `display: true` on at most one `commit_field` is a hint for the UI: when it is
  set and the field has a non-null value, the UI shows that value instead of
  the raw commit string (e.g. a shortened SHA, or a version tag). Since it
  stands in for the commit string, it is only valid on a `text` field. This is
  purely a UI concern: the database layer does not treat display fields
  specially. A schema with more than one `commit_field` marked
  `display: true`, or with one that is not `text`, is rejected with 400 when it
  is created or changed.
- `dashboard: true` on a metric is a hint for the UI: the Dashboard shows a
  card for each metric that sets it (see DA1). A card charts a geomean, so it is
  only valid on a numeric metric (see D3). Like `display`, it is purely a UI
  concern: the API treats metrics alike whether or not they set it, in trends,
  series and everywhere else.
- `listed: true` on a commit or machine field is a hint for the UI: the Commits
  and Machines tabs of the Test Suites page show a column for each field that
  sets it (see TS3, TS4). Like `display`, it is purely a UI concern: the API
  treats fields alike whether or not they set it.
- `repository` says where the suite's commits come from, so that the UI can
  link to them (see Repository below). Like `display`, it is purely a UI
  concern: the server stores and validates it, but never fills its templates in.
- There is no `format_version` in the schema: v5 has only one format.

**Presentation keys.** Besides `name` and `type`, each list accepts only the
optional keys that mean something for it. A key outside its list's set is
rejected with 400.

| List | Accepts, in addition to `name` and `type` |
|------|-------------------------------------------|
| `metrics` | `display_name`, `unit`, `unit_abbrev`, `bigger_is_better`, `dashboard` |
| `commit_fields` | `display_name`, `searchable`, `display`, `listed` |
| `machine_fields` | `display_name`, `searchable`, `listed` |

Only metrics accept `bigger_is_better` and `dashboard`, only commit and machine
fields can be searchable or listed, and only a commit field can be the UI's
display value.

**Normalization.** The stored and returned form of a schema contains every
optional key, filled in with the default below when the submitted document
omitted it. This lets a suite fetched from one instance be posted unchanged to
another, so these defaults are part of the wire contract.

| Key | Default |
|-----|---------|
| `display_name` | `null` |
| `unit`, `unit_abbrev` | `null` |
| `bigger_is_better` | `false` |
| `dashboard` | `false` |
| `searchable` | `false` |
| `display` | `false` |
| `listed` | `false` |
| `repository`'s `label`, `commit_url`, `range_url` | `null` |

A schema that omits one of the three lists entirely gets it back as an empty
list, and one that omits `repository` gets it back with all of its keys. Like a
list, `repository` itself cannot be `null`.

`display_name`, `unit` and `unit_abbrev`, and the keys of `repository`, are
each either `null`, meaning there is none, or a non-empty string. An empty
string is rejected with 400 rather than read as `null`: it would only be a
second spelling of `null`.

**Repository.** `repository` accepts only the keys below, each optional. Any
other key is rejected with 400.

- `label` names the repository in the UI's links to it, such as `GitHub` in
  "View on GitHub". When it is `null`, the UI names the repository generically.
- `commit_url` is a template of the URL of a commit, in which `{commit}` stands
  for a commit string -- the commit's identity, not its display value (see D1).
- `range_url` is a template of the URL of the changes between two commits, in
  which `{from}` stands for the commit string of the commit the changes start
  after and `{to}` for that of the commit they end at. As in Git's `from..to`,
  the changes of `from` are excluded and those of `to` are included. GitHub's
  `compare/{from}...{to}` fits, since on a linear history its three dots mean
  the same.

A template is rejected with 400 unless:
- it contains each of its placeholders at least once, in any order, and no other
  `{` or `}`: `commit_url` only `{commit}`, `range_url` only `{from}` and
  `{to}`;
- it starts with `http://` or `https://`, in any case;
- its authority, everything between that `://` and the first `/`, `?` or `#`
  after it, is not empty and contains no placeholder;
- it contains no space or ASCII control character (U+0000 to U+0020, and
  U+007F).

Together, these make a filled-in template an `http` or `https` link to the
host the template names, whatever the commit strings filling it in, which
anyone who can submit a run chooses. Refusing any other brace keeps the syntax
free for further placeholders.

The UI fills a template in by replacing every occurrence of each placeholder
with its commit string, percent-encoded: every character other than an ASCII
letter, a digit, or one of `-_.!~*'()` is replaced by `%` and two hexadecimal
digits for each byte of its UTF-8 encoding. Since I1 rejects the commit strings
`.` and `..`, a placeholder that is a whole path segment never fills it with a
dot segment, which would change the path.

**Suite name.** `name` must match `^[a-z0-9][a-z0-9_-]*$` and be at most 64
characters; anything else is rejected with 400. The name identifies the suite in
URLs and on command lines, and names nothing in the database: the namespace
holding the suite's tables is chosen by the server (see D5). No name that
matches the pattern is reserved.

**Entry names.** Each entry becomes a column, so every `name` in `metrics`,
`commit_fields` and `machine_fields` is an identifier too: it must match
`^[A-Za-z][A-Za-z0-9_]*$` and be at most 63 characters. Unlike a suite name,
which appears in every URL of the suite, an entry name may contain capitals,
and is case-sensitive. The rule deliberately does not
exclude SQL reserved words (`order`, `user`, `table` are all valid entry
names): an implementation quotes identifiers rather than restricting metric
names, which also preserves their case.

A name must be unique within its list, but the three lists are independent: a
metric and a machine field may have the same name, because they are columns of
different tables. A name that collides with a built-in column of a table the
entry extends is rejected (see D5 for each table's built-in columns). Both
checks compare names exactly, so names that differ only by case do not collide.


## D5: Data Model

The v5 tables fall into two groups: **global tables**, which exist once per
instance, and **per-suite tables**, which are created for each test suite.

**Timestamps.** All timestamp columns are `TIMESTAMP WITH TIME ZONE` and store
UTC values. Implementations must ensure timestamps are converted to UTC before
they are stored. API responses serialize timestamps as ISO 8601 with a `Z`
suffix (e.g. `"2026-04-15T14:30:00Z"`).

**Strings.** PostgreSQL cannot store the NUL character (U+0000) in a string
column or in a `jsonb` value, although JSON can contain one. See D3 for how a
request containing one is handled. A URL containing one -- in a path segment or
in a filter such as `search=` -- is rejected as a whole with 400 before routing
(see I4). This covers every segment and every filter, including ones added
later.

**Indexes.** A `unique` constraint or primary key implies an index, and each
table's notes list its compound indexes. `indexed` therefore marks only the
columns that need a single-column index of their own and are not already
unique.

### Global Tables

These exist once per instance, independently of any test suite. They live in
the database's default namespace, whereas each suite's tables live in a
namespace of their own (see below).

#### `schema`

| Column | Type | Constraints |
|--------|------|-------------|
| name | VARCHAR | PK |
| namespace | VARCHAR | unique, not null |
| schema_json | TEXT | not null |
| created_at | TIMESTAMP WITH TIME ZONE | not null |
| migration_version | INTEGER | not null |

- One row per test suite, holding the suite's schema (see D4).
- `namespace` is the PostgreSQL schema holding the suite's tables (see
  Per-Suite Tables below), and nothing but them. The server chooses it when it
  creates the suite, and nothing done to a suite after its creation changes it.
  It is never derived from the suite's name, and nothing may assume that the
  two are related. How the server names a namespace is up to the
  implementation, as long as no namespace of that name exists in the database
  already. Suites created before namespaces were recorded keep the namespace
  they were created in. An implementation may label a namespace with its
  suite's name, in a comment on the namespace rather than in its name, for
  those reading the database directly.
- `schema_json` holds the *normalized* schema -- the same content
  `GET /api/suites/{name}` returns, with omitted optional keys filled in --
  rather than the request body as submitted. It is stored as text rather than
  JSONB because the server never queries inside it: it is read whole, parsed
  into the in-memory model, and written whole.
- `migration_version` is the number of per-suite migrations (see D6) that have
  been applied to the suite's tables. It is unrelated to `schema_version`
  below, which only signals that some suite has changed.
- See D4 for the limits on the schema name.

#### `schema_version`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK, always `1` |
| version | INTEGER | not null |

- Exactly one row, created with `version = 0` when the database is initialized
  (see D6) and never deleted. Readers may rely on it being there. `id` is fixed
  at `1` so that the row can be addressed without a search.
- Bumped whenever a suite is created, modified or deleted, so that other
  workers can detect that their cached schemas are stale (see D2). Migrating a
  suite's tables (D6) does not change its schema, so it does not bump the
  counter.

#### `api_key`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| prefix | VARCHAR(8) | unique, not null |
| key_hash | VARCHAR(64) | unique, not null |
| name | VARCHAR(256) | not null |
| scope | VARCHAR(32) | not null |
| suites | VARCHAR(64)[] | nullable |
| created_at | TIMESTAMP WITH TIME ZONE | not null |
| last_used_at | TIMESTAMP WITH TIME ZONE | nullable |
| is_active | BOOLEAN | not null, default `true` |

- `prefix` is the first 8 characters of the token (see I5). Since the token
  itself cannot be recovered once hashed, the prefix is the only stable handle
  on a key, and it is how the API addresses one. It is unique, so a prefix is
  never reused. Because it is derived from the token rather than chosen
  separately, a newly generated token whose prefix collides with an existing
  key's is discarded and a new token generated, rather than the request
  failing.
- `key_hash` is the token's hash (see I5). No part of the token other than
  `prefix` is stored in recoverable form.
- `name` is a human-readable label, deliberately not unique: two keys may share
  a name.
- `scope` is one of `read`, `submit`, `triage`, `manage`, `admin` (see I5). The
  database layer validates it on create. It is stored as text rather than as an
  integer code (unlike `{suite}.regression.state`, below), because it is read
  once per authenticated request and never filtered or sorted on, so
  readability in the database matters more than compactness.
- `suites` is null for an instance-wide key, and otherwise the non-empty list of
  suite names the key is restricted to, in ascending order and without
  duplicates (see I5). The database layer rejects an empty list, a null element,
  and a list on a `read` or `admin` key. The names are not foreign keys to
  `schema`: deleting a suite leaves its name on its keys (see I5). The list is a
  column of the row rather than a table of its own because it is read with the
  rest of the row on every authenticated request, which keeps that a single
  lookup (see I5), and keys are never looked up by suite.
- `last_used_at` is null until the key is first used. It is recorded on
  successful authentication, on a best-effort basis: an implementation may
  coalesce or drop these writes, so the value may lag actual use. It is not an
  audit log, and clients must not rely on its precision. Writing it must not be
  part of the request's transaction, and no request's outcome may depend on it.
  A single key may be shared by many submitting bots, so updating it inside the
  transaction would serialize every request using that key behind one row
  lock, held for the length of each request.
- `is_active` is false once the key has been revoked. Revocation does not
  delete the row (see E11).

### Per-Suite Tables

Each suite's tables live in a namespace of their own: the PostgreSQL schema
recorded as the suite's `namespace` in `schema`, holding `commit`, `machine`,
`metric`, `run`, `test`, `sample`, `test_coverage`, `regression`,
`regression_indicator`, `profile`, `profile_function` and `run_summary`.
`{suite}.commit` stands for the `commit` table in the namespace of the suite,
and the tables below are named that way.

#### `{suite}.commit`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| commit | VARCHAR(256) | unique, not null |
| ordinal | INTEGER | nullable, unique |
| tag | VARCHAR(256) | nullable, indexed (partial: WHERE tag IS NOT NULL) |
| first_seen_at | TIMESTAMP WITH TIME ZONE | not null, default `now()` |
| delete_after_inactive_days | INTEGER | nullable, between 1 and 36500, indexed (partial: WHERE delete_after_inactive_days IS NOT NULL) |
| _(dynamic)_ | per commit_fields | nullable |

- `commit` is the identity string, submitted as `commit.value` (see O1).
- `ordinal` has a regular unique constraint.
- `tag` is an optional human-readable label (e.g. `release-18.1`), which can be
  set on every commit write path (see O2). Several commits may share a tag. The
  tag is always included in `?search=` substring matching (see O4).
- `first_seen_at` is when the server created the commit, from the database's
  clock. It is internal: no API response includes it. O10 counts it as
  activity. It is not what E3's `first_seen` order sorts by: that order is
  total, whereas several commits can share a `first_seen_at` (the commits that
  existed before the column was added all have the time it was).
- `delete_after_inactive_days` is the number of days without activity after
  which the commit is deleted, or null if it is kept however long it is
  inactive (see O10). Its index lets O10 find the commits that have it set
  without scanning this table.
- Dynamic columns are created from the schema's `commit_fields` (see D3 for the
  type-to-column mapping).
- Commits can be deleted, whether or not `ordinal` is set. Deleting a commit
  deletes its runs, which in turn deletes their samples and profiles. The
  regressions attributed to it are kept, with no commit (see
  `{suite}.regression`).
- `commit_fields` names must not collide with the built-in column names (`id`,
  `commit`, `ordinal`, `tag`, `first_seen_at`, `delete_after_inactive_days`);
  the schema parser rejects them.

#### `{suite}.machine`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| name | VARCHAR(256) | unique, not null |
| tracked | BOOLEAN | not null, default `true` |
| first_seen_at | TIMESTAMP WITH TIME ZONE | not null, default `now()` |
| delete_after_inactive_days | INTEGER | nullable, between 1 and 36500 |
| _(dynamic)_ | per machine_fields | nullable |

- `name` is unique.
- A suite is expected to have few machines: at most a few thousand, retired ones
  included. The machine list (E2) is not paginated, and `last_run_at` (below) is
  computed per machine, on that assumption.
- `tracked` marks whether the machine is part of the set LNT monitors over
  time. It only affects *automatic* machine selection: untracked machines are
  left out when the server or the UI picks machines on the user's behalf (like
  the Dashboard's trend overview; see DA2), but remain fully addressable
  wherever a machine is chosen deliberately, where the UI only lists them after
  the tracked ones (see AR18). Typical uses are one-off
  comparison configurations (e.g. the same hardware built at `-O2` and `-O3`),
  and retired hardware whose history is worth keeping.
- `first_seen_at` and `delete_after_inactive_days` mean what they mean on
  `{suite}.commit`, except that a machine has no exception like a commit's
  ordinal: a machine with `delete_after_inactive_days` set is deleted once it
  has been inactive for that long (see O10).
- Dynamic columns are created from the schema's `machine_fields` (see D3 for
  the type-to-column mapping). Keys submitted for a machine that are not
  declared as `machine_fields` are rejected (see O1).
- `machine_fields` names must not collide with the built-in column names
  (`id`, `name`, `tracked`, `first_seen_at`, `delete_after_inactive_days`); the
  schema parser rejects them.
- `last_run_at` is not a column. It is the latest `measured_at` among the
  machine's runs, or null if the machine has no runs, computed when read; the
  machine endpoints return it and can sort on it. It is deliberately not
  stored: a stored copy would have to be recomputed whenever a run is deleted,
  and would need extra synchronization on submission. Computing it is cheap
  because a suite has few machines (see above), and the compound index on
  `{suite}.run(machine_id, measured_at)` reduces it to one index probe per
  machine. An implementation must not compute it by aggregating over the whole
  run table.
- Deleting a machine deletes its runs (and in turn their samples and
  profiles), and every regression indicator naming it. A regression left with
  no indicators is not itself deleted: it keeps its title, bug, notes and
  commit, and an empty indicator set is a valid state.

#### `{suite}.metric`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| name | VARCHAR(63) | unique, not null |

- One row per metric the suite's schema declares, so that a regression
  indicator can reference its metric with a foreign key. It holds identity
  only: everything else about a metric stays in the schema (see D4).
- Rows are written with the suite at creation, and by a schema change that
  adds or removes a metric, in that change's transaction (see D2). Deleting a
  row deletes the regression indicators naming the metric, and its run
  summaries.

#### `{suite}.run`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| uuid | VARCHAR(36), collation `C` | unique, not null |
| machine_id | INTEGER FK -> Machine | not null |
| commit_id | INTEGER FK -> Commit | not null, indexed |
| submitted_at | TIMESTAMP WITH TIME ZONE | not null, default `now()` |
| measured_at | TIMESTAMP WITH TIME ZONE | not null, default `now()` |
| run_parameters | JSONB | not null, default `{}` |

- Every run must have a commit (`commit_id` is not null).
- No route updates a run once it is stored: a run is only created or deleted.
- `submitted_at` is recorded by the server when the run is accepted; a
  submission cannot supply it. It comes from the database's clock at the start
  of the storing transaction, so it is comparable across workers, but does not
  reflect the order in which runs became visible.
- `measured_at` is when the run's data was measured, as its submission states
  it (see O1), and `submitted_at` when the submission omits it. The server
  accepts any value, including one later than `submitted_at`.
- Compound index on `(machine_id, measured_at)`. Its leading column serves
  lookups of all the runs of a machine, and the pair keeps both
  `GET /api/suites/{testsuite}/runs?machine={name}&sort=-measured_at` and the
  `last_run_at` computation described under `{suite}.machine` to a bounded
  index scan rather than a scan of this table.
- Compound index on `(machine_id, submitted_at)`: O10's check of whether a
  machine has had a run submitted since a given time, which must be a single
  index probe even on a machine with a long history.
- Compound indexes on `(submitted_at, id)` and `(measured_at, id)`: serve
  `GET /api/suites/{testsuite}/runs?sort=-submitted_at` and `?sort=-measured_at`
  without `machine=`. `id` is the cursor's tiebreaker (O5).
- `uuid` uses the `C` collation so that its unique index also serves O4's
  match by prefix, which an index under a linguistic collation cannot.
  Equality is the same under either, and nothing sorts by `uuid`. With that
  index, the one on `commit_id` and the one on `(machine_id, measured_at)`,
  `GET /api/suites/{testsuite}/runs?search=` must not scan this table when
  fewer runs match than fill a page.
- Deleting a run deletes its samples, profiles and run summaries.

#### `{suite}.test`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| name | VARCHAR(256) | unique, not null |

- Nothing deletes a test: the Tests endpoint is read-only, and tests are
  created implicitly by run submission. The references to this table from
  `sample`, `test_coverage`, `profile` and `regression_indicator` therefore do
  not cascade, and an attempt to delete a test anyway is refused.

#### `{suite}.sample`

| Column | Type | Constraints |
|--------|------|-------------|
| run_id | INTEGER FK -> Run | PK |
| test_id | INTEGER FK -> Test | PK |
| repetition | INTEGER | PK |
| _(dynamic)_ | per metrics | nullable |

- `repetition` is the sample's position, from 0, among its test's samples in
  the submission (see O1). It tells the repetitions of a test in a run apart in
  storage, and is not exposed by the API (see E6).
- The primary key leads with the run. It serves
  `GET /api/suites/{testsuite}/runs/{uuid}/samples`, with or without `test=`;
  the deletion of a run's samples; and `GET /api/suites/{testsuite}/series`,
  which reaches one machine's samples through its runs, whatever tests and
  commits it reads.
- Compound index on `(test_id, run_id)`: reaches a test's samples on every
  machine without going through the runs. No endpoint relies on it.
- Dynamic columns are created from the schema's metrics (see D3 for the
  type-to-column mapping).
- Metric names must not collide with the built-in column names (`run_id`,
  `test_id`, `repetition`), or with those of `{suite}.test_coverage`.

#### `{suite}.test_coverage`

| Column | Type | Constraints |
|--------|------|-------------|
| machine_id | INTEGER FK -> Machine | PK |
| test_id | INTEGER FK -> Test | PK |
| _(dynamic)_ | BOOLEAN, one per metric | not null, default `false` |

- One row per machine and test that has had samples, so that the `machine=`
  and `metric=` filters of `GET /api/suites/{testsuite}/tests`, and the tests
  `GET /api/suites/{testsuite}/series` reads, are a lookup rather than a scan of
  `{suite}.sample`. Each metric's column records whether any of those samples
  had a value for that metric.
- It only grows: rows are added and flags only turn true. Run submission adds
  rows and sets flags in the same transaction as its samples (see O8).
  Deleting a run or a commit leaves the table unchanged, so those filters can
  still return a test whose samples on that machine are gone. Deleting a
  machine deletes its rows. Keeping the table exact would require every
  deletion to coordinate with concurrent submissions, which stale entries in a
  test picker do not justify.
- Adding a metric adds its column as `false`; removing a metric drops its
  column here as well as from `{suite}.sample`.

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
| created_at | TIMESTAMP WITH TIME ZONE | not null, default `now()` |

- `created_at` is recorded by the server when the regression is created; a
  request cannot supply it. Like `{suite}.run.submitted_at`, it comes from the
  database's clock at the start of the creating transaction.
- Deleting a commit sets the `commit_id` of the regressions attributed to it to
  null, and changes nothing else about them. A commit created later with the
  same value is a new commit, to which those regressions are not attributed.
- Compound index on `(created_at, id)`: serves
  `GET /api/suites/{testsuite}/regressions?sort=-created_at`. `id` is the
  cursor's tiebreaker (O5).

Regression state values:

| Value | Name             |
|-------|------------------|
| 0     | detected         |
| 1     | active           |
| 2     | not_to_be_fixed  |
| 3     | fixed            |
| 4     | false_positive   |

The database layer validates state values on create and update.

#### `{suite}.regression_indicator`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| uuid | VARCHAR(36) | unique, not null |
| regression_id | INTEGER FK -> Regression | not null |
| machine_id | INTEGER FK -> Machine | not null |
| test_id | INTEGER FK -> Test | not null |
| metric_id | INTEGER FK -> Metric | not null |

- Unique constraint on `(regression_id, machine_id, test_id, metric_id)`. Its
  leading column also serves lookups of all the indicators of a regression.
- Compound index on `(machine_id, test_id, metric_id, id)`: serves the
  indicator lookup across regressions (E8), whose callers narrow by machine and
  test rather than by regression, and which pages in this order; `id` is the
  cursor's tiebreaker (O5). It also keeps the cascade from a deleted machine to
  a bounded index scan rather than a scan of this table.
- Each indicator represents one (machine, test, metric) combination affected
  by the regression.
- Deleted along with its regression, its machine, or its metric (see D2). A
  regression left with no indicators is kept.
- A write naming a metric that a concurrent schema change removed gets D2's
  retryable 409 (`retry`).

#### `{suite}.profile`

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PK |
| uuid | VARCHAR(36) | unique, not null |
| run_id | INTEGER FK -> Run | not null |
| test_id | INTEGER FK -> Test | not null, indexed |
| created_at | TIMESTAMP WITH TIME ZONE | not null, default `now()` |
| disassembly_format | TEXT | not null |
| counters | JSONB | not null |

- One row per profile submitted for a run and test (see O7), holding everything
  about the profile except its functions. `counters` holds the profile's
  top-level counters, keyed by counter name.
- Unique constraint on `(run_id, test_id)`: at most one profile per run and
  test.
- `uuid` is always generated by the server (see I1), and is used by the API's
  profile data endpoints.
- Deleting a run deletes its profiles.

#### `{suite}.profile_function`

| Column | Type | Constraints |
|--------|------|-------------|
| profile_id | INTEGER FK -> Profile | PK |
| name | TEXT | PK |
| counters | JSONB | not null |
| length | INTEGER | not null |
| instructions | BYTEA | not null |

- One row per function of a profile, so that a profile's functions can be
  listed without their instructions, and one function's instructions read
  without any other's.
- `counters` holds the function's counters, one for each counter that at least
  one of its instructions has, each the sum over the instructions that have it
  (see O7), and `length` its number of instructions.
- `instructions` holds the function's instructions, in an encoding the
  implementation chooses; nothing outside the server reads it. It must be
  excluded from the default result set when querying this table, and may only
  be loaded when a request explicitly needs that function's instructions.
- Deleting a profile deletes its functions.

#### `{suite}.run_summary`

| Column | Type | Constraints |
|--------|------|-------------|
| run_id | INTEGER FK -> Run | PK |
| metric_id | INTEGER FK -> Metric | PK |
| geomean_median | DOUBLE PRECISION | nullable |
| geomean_mean | DOUBLE PRECISION | nullable |
| geomean_min | DOUBLE PRECISION | nullable |
| geomean_max | DOUBLE PRECISION | nullable |

- Statistics summarizing a run's samples for one numeric metric, computed at
  submission (see O9), one column per statistic and sample aggregation.
  `GET /api/suites/{testsuite}/trends` reads this table, so that a trend does
  not read every sample in its window.
- A geomean column is null when the run has no geomean of the metric under
  that aggregation. A run with no geomean of a metric under any aggregation has
  no row for it.
- Never updated: a run's samples do not change after submission.
- Deleted along with its run, or with its metric (see D2).

### Tables Dropped from v4

- **Baseline**: v5 comparisons are stateless API operations.
- **ChangeIgnore**: Dropped. Noise dismissal happens at the regression level
  via the `false_positive` state with notes.
- **FieldChange**: Dropped. Regressions directly reference affected machines,
  tests, and metrics via RegressionIndicator.
- **Profile**: Redesigned for v5 (see `{suite}.profile` above).
- **Order**: Replaced by Commit.


## D6: Database Initialization and Evolution

Part of the structure in D5 is decided by data and part by code, and the two
parts change in different ways.

**Which dynamic columns exist is decided by data.** A suite's schema decides
which columns its tables have beyond the built-in ones, so they cannot be
described in advance. They are created by `POST /api/suites`, added or removed
by `PATCH /api/suites/{name}/schema`, and dropped with the suite by
`DELETE /api/suites/{name}` (see D2). This is ordinary request handling, not
initialization.

**Everything else is decided by code.** The global tables (`schema`,
`schema_version`, `api_key`), and everything about a suite's tables except
which dynamic columns they have, are fixed by the server build rather than by
anything a user submits. Before a build serves traffic, the database must
therefore be migrated to the structure that build expects, and migrated again
whenever a later build changes that structure -- including the tables of every
existing suite. This is what "when the database is initialized" means in D5.

These changes form two sequences of migrations: one for the global tables, and
one for the per-suite tables, applied to each suite separately. The mechanism
that applies them must meet these requirements:

- **Ordered and recorded.** The database records how far along each sequence it
  is, so that a build can tell which migrations remain: once for the global
  tables, and once per suite, in that suite's `migration_version` (D5).
  Initializing an empty database is not a separate code path: creating the
  global tables is simply the first migration in their sequence. A suite
  created by a build already has that build's latest structure, so it has no
  migrations to apply.
- **Global tables first.** The global migrations are applied before any suite
  is migrated.
- **Idempotent.** Applying it to an already up-to-date database does nothing
  and succeeds. The server applies it on every start, so doing nothing is the
  common case.
- **All-or-nothing.** If a global migration fails, the database is left as it
  was. A suite's migrations are applied together: if one of them fails, that
  suite is left as it was, while suites that were already migrated stay
  migrated.
- **Equivalent to creation.** Once migrated, a suite has exactly the same
  columns, indexes and constraints as a suite that the same build would create
  from the same schema.
- **Migrations can see the suite's schema and can change data.** Suites have
  different dynamic columns, and some changes apply to each of them -- for
  example, changing the column type used for every `integer` metric. A
  migration therefore receives the suite's schema, so that it knows which
  columns to change, and its namespace, so that it knows where they are. A migration may also update existing rows, not only change
  the tables.
- **Never backwards.** If a newer build has already migrated the database, or
  any suite, past the latest migration the running build knows about, the
  running build refuses to start or to apply migrations, since its code would
  not match the tables.
- **Safe under concurrency.** At most one process may apply migrations at a
  time; the others wait rather than fail. This happens, for example, when two
  servers start against the same database, or when an operator runs the
  migrations by hand while a server is starting.
- **No compatibility with the previous build.** A migration does not need to
  keep the previous build working: a deployment stops the old build before
  starting the new one, and accepts a short outage in exchange.
- **The global migrations are confined to the default namespace.** They must
  not create, alter, or drop anything in a suite's namespace, nor treat its
  contents as something to reconcile. Otherwise, a tool that compares the
  database against the global definitions would see every per-suite table as
  unaccounted for, and propose dropping all of them.
- **Seeds `schema_version`.** The single row D5 requires (`id = 1`,
  `version = 0`) exists from the moment the global tables do, so that every
  reader can address it without handling its absence.

Stored schemas are data in a global table. If the schema format (D4) changes
in a way that existing `schema_json` values no longer satisfy, that would
change what they mean (such as a new key whose default does not preserve how
existing suites behave), or that would leave them no longer normalized (such as
a new key, whatever its default), rewriting them is a global migration. The
rewrite preserves each schema's meaning, keeps the stored form normalized (D5)
by writing out every key it adds, and bumps `schema_version` like any other
change to a stored schema (see D2 and D5).

A build that adds a built-in column to a table with dynamic columns reserves
that column's name (see D4). A suite whose schema already declares an entry
under that name cannot be migrated, so the build refuses to migrate any suite
until that entry has been removed, which takes an earlier build.

The server applies all of this at startup, before it begins serving, and
refuses to serve if any of it fails: a server whose tables are not the ones its
code expects would fail every request. It is also available as a standalone
administrative operation, so that an operator can apply or inspect it without
starting a server.
