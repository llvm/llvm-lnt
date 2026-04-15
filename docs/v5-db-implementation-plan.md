# LNT v5 Database Layer — Implementation Plan

This document is the step-by-step guide for implementing the v5 database layer
as specified in `docs/design/v5-db.md`. Each phase is a separate commit.

---

## Phase 1: v5 Database Package — DONE

**Commit**: `ce50c4e` on branch `v5`

Created `lnt/server/db/v5/` with schema parsing, dynamic models, CRUD
interface, time-series queries, and schema-in-DB storage. Modified `config.py`
and `app.py` for db_version selection.

**Files created**:
- `lnt/server/db/v5/__init__.py` — V5DB, V5TestSuiteDB
- `lnt/server/db/v5/models.py` — Dynamic model factory, global tables
- `lnt/server/db/v5/schema.py` — YAML schema parser
- `tests/server/db/v5/test_schema.py` — Schema parsing tests
- `tests/server/db/v5/test_models.py` — Model CRUD, constraint tests
- `tests/server/db/v5/test_import.py` — Import, search, suite management tests
- `tests/server/db/v5/test_time_series.py` — Time-series, field change, regression tests

**Files modified**:
- `lnt/server/config.py` — Accept `db_version: '5.0'`, branch `get_database()`
- `lnt/server/ui/app.py` — Conditional v4/v5 route registration

---

## Phase 1b: Complete v5 DB CRUD Interface — DONE

**Commit**: `f66311e` on branch `v5`

Completed all Phase 1b items as part of the Phase 1 commit. All items below
were verified present in the codebase.

### 1b.1 Strict `format_version` validation

In `import_run()`, reject if `format_version` is missing (not just if it's
wrong). The design (D6) says it is required.

### 1b.2 Remove `cursor` parameter from DB methods

Cursor-based pagination (encoding, decoding, tiebreakers) is an API-layer
concern (see design D10). Remove the `cursor` parameter from:
- `list_commits()`
- `list_runs()`
- `list_field_changes()`
- `list_regressions()`
- `query_time_series()`

The DB layer provides filtering, sorting, and limit only.

### 1b.3 Regression state validation

Add `VALID_REGRESSION_STATES` constant (mapping integers 0-4 to state names)
and validate in `create_regression()` and `update_regression()`.

### 1b.4 Add missing CRUD methods to `V5TestSuiteDB`

- `get_test(session, *, id=None, name=None)` — fetch single Test
- `list_tests(session, *, search=None, limit=None)` — list with optional
  name prefix search
- `list_samples(session, *, run_id=None, test_id=None, limit=None)` — list
  samples with optional filters
- `update_machine(session, machine, *, name=None, parameters=None, **fields)`
  — update name, parameters, and/or schema-defined fields
- `delete_field_change(session, field_change_id)` — delete (cascades to
  regression indicators)
- `add_regression_indicator(session, regression, field_change)` — add a
  single indicator
- `remove_regression_indicator(session, regression_id, field_change_id)` —
  remove a single indicator

### 1b.5 Change ordinal constraint to regular unique

In `models.py`, change the deferred unique constraint on `ordinal` to a
regular unique constraint. Ordinals are assigned once and not reassigned.

### 1b.6 Tests

**Files modified**:
- `tests/server/db/v5/test_time_series.py` — Remove
  `TestDeferredOrdinalConstraint` class. Add tests for new CRUD methods,
  regression state validation.
- `tests/server/db/v5/test_import.py` — Add test for missing format_version.

**New tests**:
- get_test by name/id, list_tests, list_tests with search
- list_samples by run, by test
- update_machine name/fields/parameters
- delete_field_change, delete cascades to indicators
- add/remove regression indicator, duplicate indicator rejected
- regression state validation (create and update)
- import_run with missing format_version rejected

---

## Phase 2: v5 API — Rewrite to Use V5TestSuiteDB

Rewrite every file in `lnt/server/api/v5/` to use `V5TestSuiteDB` (from
`lnt/server/db/v5/`) instead of v4 DB models (from
`lnt.server.db.testsuitedb`). After this phase, the v5 API has zero imports
from v4 DB code. The v5 API is served only on v5 instances
(`db_version: '5.0'`).

**Implementation order**: Schema renames (2.16-2.24) should be done
alongside or before their corresponding endpoint changes, since endpoints
import from their schema modules. Do each endpoint+schema pair together.

### 2.1 Middleware (`middleware.py`)

Replace testsuite resolution:
- Call `db.ensure_fresh(g.db_session)` on every `/api/v5/` request to detect
  schema changes made by other workers.
- Resolve the testsuite (if any) with `g.ts = db.get_suite(testsuite)`.
  Return 404 if `None`.
- `g.db` is now always a `V5DB`. No dual-path code.
- `v5_teardown_request()` unchanged (session commit/rollback/close).

### 2.2 Helpers (`helpers.py`)

**Delete**:
- `escape_like()` — API no longer builds LIKE queries; DB layer owns search.
- `validate_tag()` — No tags in v5 commits.
- `resolve_metric()` — v4 `SampleField` objects replaced by schema metrics.

**Replace** `resolve_metric()` with:
```python
def validate_metric_name(ts, field_name):
    for m in ts.schema.metrics:
        if m.name == field_name:
            return
    abort_with_error(400, "Unknown metric '%s'" % field_name)
```

**Rewrite lookups** to use `V5TestSuiteDB` methods:
- `lookup_machine()` → `ts.get_machine(session, name=name)`, 404 if None.
  Remove the "multiple machines" 409 check (v5 enforces uniqueness).
- `lookup_run_by_uuid()` → `ts.get_run(session, uuid=uuid)`.
- `lookup_fieldchange()` → `ts.get_field_change(session, uuid=uuid)`.
- `lookup_test()` → `ts.get_test(session, name=name)`.
- `lookup_regression()` → `ts.get_regression(session, uuid=uuid)`.

**Rewrite `serialize_run()`**:
```python
def serialize_run(run, ts):
    return {
        'uuid': run.uuid,
        'machine': run.machine.name if run.machine else None,
        'commit': run.commit_obj.commit if run.commit_obj else None,
        'submitted_at': run.submitted_at.isoformat() if run.submitted_at else None,
        'run_parameters': dict(run.run_parameters) if run.run_parameters else {},
    }
```
Changes: `order` dict → `commit` string, `start_time`/`end_time` →
`submitted_at`, `parameters` → `run_parameters`. Note: callers must use
`joinedload(ts.Run.commit_obj)` and `joinedload(ts.Run.machine)` to avoid
N+1 queries.

**Rewrite `serialize_fieldchange()`**:
```python
def serialize_fieldchange(fc):
    return {
        'test': fc.test.name if fc.test else None,
        'machine': fc.machine.name if fc.machine else None,
        'metric': fc.field_name,
        'old_value': fc.old_value,
        'new_value': fc.new_value,
        'start_commit': fc.start_commit.commit if fc.start_commit else None,
        'end_commit': fc.end_commit.commit if fc.end_commit else None,
    }
```
Changes: `fc.field.name` → `fc.field_name`, `start_order`/`end_order` →
`start_commit`/`end_commit`, `run_uuid` dropped (no run FK on v5
FieldChange). Note: the `uuid` key is added by callers (not the helper)
since different callers use different key names (`uuid` vs
`field_change_uuid`).

Keep `parse_datetime()` unchanged.

### 2.3 Endpoint: Orders → Commits

**Rename** `endpoints/orders.py` → `commits.py`.

Blueprint name: `'Commits'`, URL prefix unchanged.

**Delete** all v4 helpers: `_serialize_order_fields()`,
`_serialize_order_summary()`, `_order_detail_url()`,
`_serialize_order_neighbor()`, `_serialize_order_detail()`,
`_lookup_order_by_value()`.

**New helpers**:
- `_serialize_commit_summary(commit, ts)` — returns `{commit, ordinal,
  ...commit_field_values}`.
- `_get_neighbor_commits(session, ts, commit)` — queries nearest
  lower/higher ordinal, returns `(prev, next)`.
- `_serialize_commit_detail(commit, testsuite, ts, session)` — summary +
  `previous_commit`/`next_commit` neighbors.

**Endpoints**:
- `GET /commits` — `?search=` param (replaces `tag`/`tag_prefix`). Build
  query inline with OR-prefix search on `commit` + searchable
  `commit_fields`, pass to `cursor_paginate()`.
- `POST /commits` — Accept `{"commit": "...", ...commit_field_values}`. Use
  `ts.get_or_create_commit()`. Return 409 if already exists.
- `GET /commits/<value>` — `ts.get_commit(session, commit=value)`, 404 if
  None. Serialize with `_serialize_commit_detail()`.
- `PATCH /commits/<value>` — Accept `{ordinal, ...commit_fields}`. Use
  `ts.update_commit()`. Accept `ordinal: null` for `clear_ordinal=True`.
- `DELETE /commits/<value>` — `ts.delete_commit()`. Catch `ValueError` →
  409 (FieldChanges reference it). Return 204.

### 2.4 Endpoint: Runs (`runs.py`)

**`POST /runs`** — Complete rewrite:
- Remove `lnt.util.ImportData` import.
- Accept format_version `"5"` (reject anything else).
- Call `ts.import_run(session, parsed_body)` directly.
- Return `{success, run_uuid, result_url}`.
- Remove `_CONFLICT_MAP`/`_MERGE_MAP`. Simplify `on_machine_conflict`:
  `"reject"` → `machine_strategy="match"`, `"update"` → `"update"`.
- Drop `on_existing_run` param (v5 always creates a new run).
- Catch `ValueError` → 400.

**`GET /runs`** — Rewrite filters:
- Replace `order=` filter with `commit=` (string). Look up commit by
  `ts.get_commit()` to get `commit_id`.
- Replace `ts.Run.start_time` filter with `ts.Run.submitted_at`.
- Replace `joinedload(ts.Run.order)` with `joinedload(ts.Run.commit_obj)`.
- Use new `serialize_run()`.

**`GET /runs/<uuid>`** — Same serialization changes.

**`DELETE /runs/<uuid>`** — Use `ts.get_run(session, uuid=...)` then
`ts.delete_run(session, run.id)`.

### 2.5 Endpoint: Query (`query.py`)

This is the most complex endpoint. Keep the inline query approach (supports
multi-test disjunction and complex cursor pagination that
`V5TestSuiteDB.query_time_series()` does not handle).

**Param renames**: `order` → `commit`, `after_order` → `after_commit`,
`before_order` → `before_commit`.

**Sort fields**: `_ALLOWED_SORT_FIELDS = {'test', 'commit', 'timestamp'}`.

**`_parse_sort()`**: Change default sort from `[('order', True), ('test',
True)]` to `[('commit', True), ('test', True)]`. Change tiebreaker list
from `('order', 'test')` to `('commit', 'test')`.

**`_resolve_sort_column()`**: `'commit'` → `ts.Commit.ordinal`,
`'timestamp'` → `ts.Run.submitted_at`.

**`_coerce_cursor_value()`**: Rename `'order'` branch to `'commit'`,
still returns `int(value)` (now represents ordinal).

**`_extract_cursor_values()`**: Rename `'order'` branch to `'commit'`,
extract `row_data['ordinal']` instead of `row_data['order_id']`.

**`_resolve_order()`** → **`_resolve_commit()`**: Look up by
`ts.get_commit(session, commit=value)`.

**`_resolve_machine()`**: Remove "multiple machines" check (v5 enforces
uniqueness).

**Metric resolution**: Replace `resolve_metric(ts, name)` (returns
`SampleField`) with `getattr(ts.Sample, name, None)` to get the column.
Remove `from lnt.testing import PASS`.

**Core query rewrite**:
- Replace `ts.Order` joins with `ts.Commit` joins:
  `join(ts.Commit, ts.Run.commit_id == ts.Commit.id)`.
- Remove entire `sample_field.status_field` filter block (no status
  pairing in v5). This is the block that imports `PASS`.
- Order range filters: `after_commit.ordinal` / `before_commit.ordinal`.
  If commit has no ordinal, abort 400.
- When sorting by `commit`, filter `ts.Commit.ordinal.isnot(None)`.
- Serialize: `commit` string + `ordinal` int instead of `order` dict.
  Use `'_ordinal'` as internal cursor key (was `'_order_id'`).

**Result row construction**: Change `'_order_id': order.id` to
`'_ordinal': commit_obj.ordinal`. Change cursor extraction at end of
endpoint to use `'ordinal'` key.

**Remove** `from lnt.testing import PASS`.

### 2.6 Endpoint: Machines (`machines.py`)

**`_serialize_machine()`** — Rewrite:
- Replace `machine.fields`/`machine.get_field()` with iteration over
  `ts.schema.machine_fields` + `getattr(machine, mf.name)`.
- Keep `machine.parameters` JSONB blob.
- Preserve the flat `info` dict shape (schema fields + parameters merged)
  to avoid breaking the `MachineResponseSchema` contract.

**`GET /machines`** — Replace `name_contains`/`name_prefix` with `search`.
Keep offset pagination.

**`POST /machines`** — Check for existing machine first with
`ts.get_machine(session, name=name)`, abort 409 if found. Then use
`ts.get_or_create_machine()` to create. Split `info` dict into schema
fields vs parameters using `ts.schema.machine_fields`.

**`PATCH /machines/{name}`** — Use `ts.update_machine()`.

**`DELETE /machines/{name}`** — Replace entire manual cascade (ChangeIgnore
cleanup, batched run deletion) with `ts.delete_machine(session, machine.id)`.
v5 models have proper CASCADE. Delete all ChangeIgnore references (model
does not exist in v5).

**`GET /machines/{name}/runs`** — Replace `start_time` → `submitted_at`.
Rename sort parameter value from `-start_time` to `-submitted_at` (update
`MachineRunsQuerySchema` to match). Use new `serialize_run()`.
Add `joinedload(ts.Run.commit_obj)` for serialization.

### 2.7 Endpoint: Field Changes — REMOVED

Field changes have been removed from v5. The `field_changes.py` endpoint
file should be deleted. Regressions directly reference affected machines,
tests, and metrics via RegressionIndicator.

### 2.8 Endpoint: Regressions (`regressions.py`)

**State mapping**: `STATE_TO_DB` uses v5 integer values:
`detected=0, active=1, not_to_be_fixed=2, fixed=3,
false_positive=4`.

**New model**: Regressions have a nullable `commit_id` FK and `notes` TEXT
column. RegressionIndicator contains `(regression_id, machine_id, test_id,
metric)` directly — no FieldChange indirection.

**`POST /regressions`** — Create regression with optional commit, notes, and
inline indicators. Each indicator is `{machine, test, metric}` resolved by name.

**`PATCH /regressions/{uuid}`** — Update title, bug, notes, state, commit.

**`DELETE /regressions/{uuid}`** — Cascades to indicators.

**`POST .../indicators`** — Batch add. Each indicator is `{machine, test,
metric}` resolved by name. Duplicates silently ignored.

**`DELETE .../indicators`** — Batch remove by indicator UUIDs in body.

**Filtering**: `state=` (multiple values), `machine=`, `test=`, `metric=`,
`commit=`, `has_commit=`. Machine/test filters JOIN through indicators.
`ts.FieldChange.field_name == metric_name` directly (no SampleField
lookup, no `field_id`).

### 2.9 Endpoint: Discovery (`discovery.py`)

Change `'orders'` → `'commits'` in `_suite_links()`.

### 2.10 Endpoint: Test Suites (`test_suites.py`)

**Remove all v4 imports**: `lnt.server.db.testsuite`,
`lnt.server.db.testsuitedb`.

**`_suite_links()`**: `'orders'` → `'commits'`.

**`_suite_detail()`**: Replace `tsdb.test_suite.__json__()` with
`V5DB._schema_to_dict(tsdb.schema)`.

**`POST /test-suites`** — Accept v5 schema format (name, metrics,
commit_fields, machine_fields). Parse with
`lnt.server.db.v5.schema.parse_schema()`. Create with
`db.create_suite(session, schema)`. Catch `ValueError` → 409,
`SchemaError` → 400.

**`DELETE /test-suites/<name>`** — Replace manual v4 metadata cleanup with
`db.delete_suite(session, name)`.

### 2.11 Endpoint: Tests (`tests.py`)

Replace `resolve_metric(ts, metric_name)` (returns SampleField with
`.column` attribute) with `getattr(ts.Sample, metric_name, None)` which
returns the Column directly. Replace `field.column.isnot(None)` with
`metric_col.isnot(None)`.

Keep `name_contains` (substring) and `name_prefix` filter params — these
are useful and not replaced by the DB layer's prefix-only `search`.
Inline the ILIKE escape logic (the DB layer's `_escape_like` is private).

### 2.12 Endpoint: Samples (`samples.py`)

**`_serialize_sample()`** — Replace `ts.sample_fields` iteration with
`ts.schema.metrics`:
```python
for metric in ts.schema.metrics:
    value = getattr(sample, metric.name, None)
    if value is not None:
        metrics[metric.name] = value
```
Remove `has_profile` from response and query params (no profiles in v5).
Also remove the query filter on `ts.Sample.profile_id` (`profile_id`
column does not exist in v5 Sample model).

### 2.13 Endpoint: Profiles (`profiles.py`)

Left in place for now. Profiles are not part of the v5 DB layer (design
D13) and the v5 Sample model has no `profile_id` column, so this endpoint
will break once the full API rewrite is complete. It will be removed or
reimplemented at that point.

### 2.14 Endpoint: Agents / llms.txt (`agents.py`)

Rewrite `LLMS_TEXT`: replace "Order" with "Commit", explain ordinals,
commit_fields, PATCH workflow. Update URLs (`/orders` → `/commits`),
submission format (format_version `"5"`), `submitted_at`.

### 2.15 Blueprint registration (`endpoints/__init__.py`)

Replace `'orders'` with `'commits'` in `_ENDPOINT_MODULES`. Keep
`'profiles'` registered for now (it will break naturally when endpoints
are fully on v5 models; see 2.13).

### 2.16 Schemas: Orders → Commits

**Rename** `schemas/orders.py` → `commits.py`.

New schemas: `CommitSummarySchema` (commit, ordinal, dynamic fields),
`CommitDetailSchema` (adds previous/next neighbors),
`CommitUpdateSchema` (ordinal nullable, dynamic fields),
`CommitCreateSchema`, `CommitListQuerySchema` (search param),
`PaginatedCommitResponseSchema`.

### 2.17 Schemas: Runs (`schemas/runs.py`)

`RunResponseSchema`: `order` dict → `commit` string, `start_time`/`end_time`
→ `submitted_at`, `parameters` → `run_parameters`.

`RunListQuerySchema`: `order` → `commit`, sort references `submitted_at`.

`RunSubmitQuerySchema`: Remove `on_existing_run`.

### 2.18 Schemas: Query (`schemas/query.py`)

`QueryDataPointSchema`: `order` dict → `commit` string + `ordinal` int.

`QueryEndpointQuerySchema`: `order`/`after_order`/`before_order` →
`commit`/`after_commit`/`before_commit`.

### 2.19 Schemas: Regressions (`schemas/regressions.py`)

Update `STATE_TO_DB` integer values to v5 mapping.

`IndicatorResponseSchema`/`FieldChangeResponseSchema`:
`start_order`/`end_order` → `start_commit`/`end_commit`. Remove `run_uuid`.

`FieldChangeCreateSchema`: same renames, remove `run_uuid`.

### 2.20 Schemas: Machines (`schemas/machines.py`)

`MachineListQuerySchema`: `name_contains`/`name_prefix` → `search`.

`MachineRunResponseSchema`: `order` → `commit`, `start_time`/`end_time` →
`submitted_at`.

### 2.21 Schemas: Common (`schemas/common.py`)

`TestSuiteLinksSchema`: `orders` → `commits`.

Delete `FieldChangeIgnoreResponseSchema`.

### 2.22 Schemas: Test Suites (`schemas/test_suites.py`)

Rewrite `TestSuiteCreateRequestSchema` for v5 format: remove
`format_version`, remove `run_fields`, add `commit_fields` (name, type,
searchable, display). `MetricDefSchema`: add `type` (real/status/hash),
remove `ignore_same_hash`.

### 2.23 Schemas: Samples (`schemas/samples.py`)

Remove `has_profile` from `SampleResponseSchema` and
`RunSamplesQuerySchema`.

### 2.24 Schemas: Profiles (`schemas/profiles.py`)

Left in place for now (see 2.13).

### 2.25 Unchanged files

No changes needed:
- `auth.py` — APIKey model is independent of v4/v5.
- `pagination.py` — Generic cursor pagination, works with any query.
- `etag.py` — Generic ETag support.
- `errors.py` — Generic error handling.
- `__init__.py` (API factory) — Delegates to sub-modules.
- `app.py` — Already branches on `db_version`.
- `config.py` — Already handles `'5.0'`.

### 2.26 DB model fix: Regression back-reference

The v5 `Regression` model has no back-reference to `RegressionIndicator`.
The FK `ondelete="CASCADE"` on `RegressionIndicator.regression_id` handles
DB-level cascade, but SQLAlchemy needs a relationship for
`cascade="all, delete-orphan"` to work via `session.delete()`. Add a
`Regression.indicators` relationship in `models.py` (similar to
`FieldChange.regression_indicators`).

### 2.27 Phase 2 Tests

#### Test helpers (`v5_test_helpers.py`) — Complete rewrite

All data creation helpers use v4 constructors. Replace with V5TestSuiteDB
methods:

- `create_machine()` → `ts.get_or_create_machine(session, name, parameters=..., **fields)`
- `create_order()` → `create_commit()`: `ts.get_or_create_commit(session, commit_str, **metadata)`
- `create_run()` → `ts.create_run(session, machine, commit=commit, submitted_at=..., run_parameters=...)`
- `create_test()` → `ts.get_or_create_test(session, name)`
- `create_sample()` → `ts.create_samples(session, run, [{'test_id': test.id, ...metrics}])[0]`
- `create_fieldchange()` → `ts.create_field_change(session, machine, test, field_name, start_commit, end_commit, old_value, new_value)`. Note: `field` param changes from SampleField object to string.
- `create_regression()` → `ts.create_regression(session, title, [fc.id ...], state=...)`

The test app factory must create a `V5DB` instance and test suite instead of
v4 metadata tables.

#### Test file changes

**`test_orders.py` → `test_commits.py`**: URLs `/orders` → `/commits`.
Assertions: `fields` dict → `commit` string, `tag` → removed,
`previous_order`/`next_order` → `previous_commit`/`next_commit`. New tests:
ordinal PATCH, commit_fields PATCH, `?search=`, DELETE cascade/409.

**`test_runs.py`**: `order` → `commit`, `start_time`/`end_time` →
`submitted_at`, `parameters` → `run_parameters`. Submission format_version
`"2"` → `"5"` with top-level `commit`. Remove `on_existing_run` tests.

**`test_query.py`**: `order` → `commit`/`ordinal` in request and response.
`after_order`/`before_order` → `after_commit`/`before_commit`.
`timestamp` → `submitted_at`.

**`test_machines.py`**: `name_contains`/`name_prefix` → `search`. Run
serialization: `commit`, `submitted_at`.

**`test_field_changes.py`**: Remove ignore/un-ignore tests.
`start_order`/`end_order` → `start_commit`/`end_commit`. Remove `run_uuid`.

**`test_regressions.py`**: Indicator assertions: `start_commit`/`end_commit`.
Remove `run_uuid`. Update state integer values.

**`test_samples.py`**: Remove `has_profile` assertions.

**`test_profiles.py`**: Left in place for now (see 2.13). Will break when
the samples endpoint no longer exposes `profile_id`.

**`test_test_suites.py`**: Creation payload → v5 format. Discovery links:
`commits`.

**`test_discovery.py`**: `orders` → `commits`.

**`test_integration.py`**: Rewrite `_make_submission_payload()` for v5
format. All `order` → `commit`, `start_time` → `submitted_at`. New test
classes: `TestOrdinalAssignmentWorkflow`, `TestCommitMetadataWorkflow`,
`TestSearchWorkflow`, `TestMachineUniquenessWorkflow`,
`TestCommitDeletionWorkflow`.

**`test_agents.py`**: Verify "commit" terminology in llms.txt.

**`test_helpers.py`**: Update for new `serialize_run()` /
`serialize_fieldchange()` output shapes.

---

## Phase 3: v5 UI — Replace Orders with Commits — DONE

**Branch**: `v5`

Updated the entire v5 frontend to use the new commit-based API. All 26
test files (631 tests) pass. All tox environments pass.

**Key changes**:
- Types: `OrderSummary/Detail/Neighbor` → `CommitSummary/Detail/Neighbor`.
  `RunInfo.order` (dict) → `.commit` (string), `.start_time`/`.end_time` →
  `.submitted_at`, `.parameters` → `.run_parameters`. Removed `has_profile`
  from `SampleInfo`. `QueryDataPoint.order` (dict) → `.commit` (string) +
  `.ordinal`. `SideSelection.order` → `.commit`.
- API: `getOrders/Order/RunsByOrder/OrdersPage` →
  `getCommits/Commit/RunsByCommit/CommitsPage`. `searchOrdersByTag` →
  `searchCommits` (uses `?search=`). `updateOrderTag` → `updateCommit`.
  Query params: `order`→`commit`, `afterOrder`→`afterCommit`.
  `getMachines` params: `namePrefix/nameContains` → `search`.
- Pages: `order-detail.ts` → `commit-detail.ts`, tab "Orders" → "Commits",
  all order field-dict extraction replaced with direct commit string usage.
- Components: `order-search.ts` → `commit-search.ts`, combobox renamed
  (`createOrderPicker` → `createCommitPicker`, etc.), `primaryOrderValue()`
  removed. State URL params: `order_a/b` → `commit_a/b`.
- CSS: `.order-*` classes → `.commit-*`.
- Backend test: `/orders/some-value` route → `/commits/some-value`.

### 3.1 Types (`types.ts`)

- `OrderSummary` → `CommitSummary`: `{ commit: string, ordinal: number|null, ...metadata }`
- `OrderDetail` → `CommitDetail`: adds previous/next neighbors
- `RunInfo.order` dict → `RunInfo.commit: string`
- `RunInfo.start_time`/`end_time` → `RunInfo.submitted_at`
- `QueryDataPoint.order` dict → `QueryDataPoint.commit: string`
- `MachineRunInfo`: same changes

### 3.2 API layer (`api.ts`)

- `getOrder()` → `getCommit()`, URL `/commits/`
- `getRunsByOrder()` → `getRunsByCommit()`
- `updateOrderTag()` → `updateCommitMetadata()`
- New: `updateCommitOrdinal(ts, commit, ordinal)`
- `searchOrdersByTag()` → `searchCommits(ts, search)`
- All run-related functions: expect `commit` string, `submitted_at`

### 3.3 Pages

- `order-detail.ts` → `commit-detail.ts` — show commit string, ordinal
  (editable), metadata fields, prev/next
- `graph.ts` — X-axis uses commit string, only plot commits with ordinals
- `compare.ts` — select by commit string
- `test-suites.ts` — "Orders" tab → "Commits" tab

### 3.4 Components and State

- `order-search.ts` → `commit-search.ts` — uses `?search=`
- `state.ts` — `order_a`/`order_b` → `commit_a`/`commit_b`
- `selection.ts` — order → commit throughout
- `utils.ts` — remove `primaryOrderValue()` (commits are simple strings)
- `graph-data-cache.ts` — cache keys use commit strings
- `combobox.ts` — remove field-dict extraction

### 3.5 Routes

- `main.ts` — `/orders/:value` → `/commits/:value`
- `views.py` — update SPA catch-all routes

### 3.6 Phase 3 Tests

- Frontend unit tests (vitest): update types, API function references
- SPA route tests: `/commits/:value` renders commit-detail

---

## Phase 4: Migration Tool

### 4.1 New file: `lnt/lnttool/migrate_v4_to_v5.py`

CLI command integrated into `lnt admin`:
```
lnt admin migrate-to-v5 --input <v4-db-path> --output <v5-db-path>
```

### 4.2 Migration logic

1. Open v4 database (SQLite or Postgres), read all test suites
2. Create v5 Postgres database
3. Create v5 global tables (`v5_schema`, `v5_schema_version`)
4. For each test suite:
   a. Generate v5 schema from v4 suite definition (map order fields →
      commit_fields, run_fields → dropped, machine_fields preserved)
   b. Insert schema into `v5_schema` table
   c. Create per-suite v5 tables
   d. Copy Machines (map fields, extra params → JSONB)
   e. Convert Orders → Commits:
      - `commit` = primary order field value
      - `ordinal` = position from linked-list traversal (walk NextOrder
        pointers from first order) or from ordinal column if present
      - v4 `tag` column → a `label` commit_field if defined in schema
   f. Copy Runs (map order_id → commit_id, start_time → submitted_at)
   g. Copy Tests (1:1)
   h. Copy Samples (map run_id, preserve metric values)
   i. Copy FieldChanges (map order FKs → commit FKs, resolve field_id FK
      to field_name string via SampleField metatable)
   j. Copy Regressions + RegressionIndicators (1:1, preserve UUIDs)
5. Copy global APIKey table

### 4.3 Phase 4 Tests

- `tests/lnttool/test_migrate_v4_to_v5.py`:
  - Create v4 database with known data
  - Run migration
  - Verify commit strings, ordinals, run mappings, samples, field changes
  - Edge cases: NULL order fields, orphaned runs, empty linked lists
  - Idempotency: running twice fails cleanly

---

## Commit Strategy

1. `ce50c4e` — "Add v5 database layer with Commit model" — DONE
2. Phase 1b — "Complete v5 DB CRUD interface" — DONE (in Phase 1 commit)
3. Phase 2 — "Rewrite v5 API to use v5 DB layer" — DONE
4. Phase 3 — "Update v5 UI: replace orders with commits" — DONE
5. Phase 4 — "Add v4-to-v5 migration tool"

Each phase is a separate commit. All tox environments must pass before each
commit.
