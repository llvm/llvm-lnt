# LNT v5 REST API — Implementation Plan

## 0. Prerequisites — VERIFIED

### 0.1 flask-smorest + SQLAlchemy 1.3.24 Compatibility — PASS

Verified: `flask-smorest==0.46.2` installs cleanly alongside `SQLAlchemy==1.3.24`.
pip does not force an SQLAlchemy upgrade. Transitive deps installed:
marshmallow 4.2.2, webargs, apispec. All imports work correctly.

### 0.2 flask-smorest + Flask-RESTful Coexistence — PASS

Verified: Both `flask_restful.Api(app)` and `flask_smorest.Api(app)` can be registered
on the same Flask app. A minimal test confirmed:
- v4-style Flask-RESTful endpoint returns 200 with correct JSON
- v5-style flask-smorest endpoint returns 200 with correct JSON
- OpenAPI spec is generated and accessible at the configured URL
- No error handler conflicts observed

---

## 1. Dependencies

Add to `pyproject.toml` under `[project.dependencies]`:

```
flask-smorest>=0.44.0
```

This transitively installs `marshmallow>=4.0`, `webargs>=8.0.0`, `apispec>=6.0.0`.
(Tested: flask-smorest 0.46.2 with marshmallow 4.2.2, SQLAlchemy 1.3.24 unchanged.)

Add to `[project.optional-dependencies].dev`:

```
pytest>=8.0
```

(`pytest-flask` is not needed — Flask's built-in `test_client()` suffices.)

---

## 2. Package Structure

```
lnt/server/api/                     # NEW directory
    __init__.py                     # empty
    v5/
        __init__.py                 # create_v5_api() factory
        middleware.py               # testsuite resolution, CORS, request lifecycle
        auth.py                     # Bearer token auth, API key model, scope decorators
        errors.py                   # Standardized error handlers (blueprint-scoped)
        pagination.py               # Cursor-based and offset pagination utilities
        etag.py                     # ETag computation and conditional request support
        schemas/
            __init__.py             # Base schema classes, dynamic schema factory
            common.py               # Error, pagination envelope schemas
            machines.py             # Machine request/response schemas
            orders.py               # Order request/response schemas
            runs.py                 # Run request/response schemas
            tests.py                # Test schemas
            samples.py              # Sample schemas
            profiles.py             # Profile schemas
            regressions.py          # Regression, indicator, field change schemas
            series.py               # Time series schemas
            admin.py                # API key schemas
        endpoints/
            __init__.py             # register_all_endpoints()
            discovery.py            # GET /api/v5/
            machines.py             # Machine CRUD
            orders.py               # Order CRU
            runs.py                 # Run CRD + submission
            tests.py                # Test list/detail
            samples.py              # Sample listing (under runs)
            profiles.py             # Profile data (under runs/tests)
            regressions.py          # Regression CRUD + merge/split/indicators
            field_changes.py        # Field change triage
            series.py               # Time series query
            admin.py                # API key management
```

---

## 3. Database Migrations

### 3.1 New migration: `upgrade_18_to_19.py`

This migration adds:

**A) UUID columns** to per-testsuite `Run`, `Regression`, and `FieldChange` tables:
- Column: `UUID`, String(36) — added **without** UNIQUE constraint (SQLite does not
  support UNIQUE in ALTER TABLE ADD COLUMN)
- Backfill existing rows with `uuid.uuid4()` values **in batches** (1000 rows per batch)
  to avoid OOM on large databases
- After backfill, create a unique index separately via `CREATE UNIQUE INDEX`
- The migration discovers test suites via the `TestSuite` table (pattern from upgrade_7_to_8.py)

**B) `APIKey` table** (global, not per-testsuite):
- Created via raw DDL in the migration (NOT via ORM Base.metadata.create_all)
- Columns: ID (PK), Name (String 256), KeyPrefix (String 8), KeyHash (String 64, unique index),
  Scope (String 32), CreatedAt (DateTime), LastUsedAt (DateTime nullable), IsActive (Boolean)

### 3.2 Model changes in `testsuitedb.py`

Add UUID column to dynamic model definitions:

```python
# In Run class (around line 347):
uuid = Column("UUID", String(36), unique=True, index=True)

# In FieldChange class (around line 605):
uuid = Column("UUID", String(36), unique=True, index=True)

# In Regression class (around line 662):
uuid = Column("UUID", String(36), unique=True, index=True)
```

Ensure UUID is generated on creation:
- In `_getOrCreateRun()`: set `run.uuid = str(uuid.uuid4())` when creating a new run
- For the `merge='replace'` strategy: generate a NEW UUID (not reuse the old one),
  since the old run is being replaced with different data
- In `new_regression()` in `regression.py`: set `regression.uuid = str(uuid.uuid4())`
- FieldChange UUIDs: set in `regenerate_fieldchanges_for_run()` in `fieldchange.py` when creating new FieldChanges

### 3.3 APIKey runtime model

Define a standalone SQLAlchemy model for `APIKey` using a declarative base (consistent
with the rest of the codebase), mapped to the table created by the migration. Use a
separate base to avoid contaminating the testsuite metadata and the per-suite bases.
The session used to query APIKey is engine-bound, not metadata-bound, so queries work
through the same session as other models.

```python
# In lnt/server/api/v5/auth.py
from sqlalchemy.ext.declarative import declarative_base

APIKeyBase = declarative_base()

class APIKey(APIKeyBase):
    __tablename__ = 'APIKey'
    id = Column("ID", Integer, primary_key=True)
    name = Column("Name", String(256), nullable=False)
    key_prefix = Column("KeyPrefix", String(8), nullable=False)
    key_hash = Column("KeyHash", String(64), nullable=False, unique=True, index=True)
    scope = Column("Scope", String(32), nullable=False)
    created_at = Column("CreatedAt", DateTime, nullable=False)
    last_used_at = Column("LastUsedAt", DateTime, nullable=True)
    is_active = Column("IsActive", Boolean, nullable=False, default=True)
```

---

## 4. Core Infrastructure

### 4.1 App Registration (`lnt/server/api/v5/__init__.py`)

```python
from flask_smorest import Api as SmorestApi

def create_v5_api(app):
    app.config.update({
        "API_TITLE": "LNT API",
        "API_VERSION": "v5",
        "OPENAPI_VERSION": "3.0.3",
        "OPENAPI_URL_PREFIX": "/api/v5/openapi",
        "OPENAPI_JSON_PATH": "openapi.json",
    })
    smorest_api = SmorestApi(app)

    from .middleware import register_middleware
    register_middleware(app)

    from .endpoints import register_all_endpoints
    register_all_endpoints(smorest_api)

    return smorest_api
```

Integration in `app.py` — add after line 153 (`load_api_resources(app.api)`):

```python
from lnt.server.api.v5 import create_v5_api
app.v5_api = create_v5_api(app)
```

### 4.2 Middleware (`middleware.py`)

**Testsuite resolution** — `before_request` hook scoped to `/api/v5/` paths:

1. Parse `testsuite_name` from URL (`request.view_args`)
2. Skip testsuite resolution for discovery (`/api/v5/`), admin (`/api/v5/admin/`), and OpenAPI spec paths
3. Open DB: `g.db = current_app.instance.get_database("default")` (use `current_app`, not `app`)
   **Note**: `Instance.get_database()` returns a cached `V4DB` instance — it does NOT
   create a new connection per request. Verified in `instance.py` line 76-77.
   **Warning**: Do NOT call `Config.get_database()` — that creates a new V4DB every time.
4. Set `g.db_name = "default"` (needed by `import_from_string` and other code that reads `g.db_name`)
5. Create session: `g.db_session = g.db.make_session()`
6. Resolve testsuite (only when URL contains one): `g.ts = g.db.testsuite[testsuite_name]`
7. Register `teardown_request` to close/rollback the session

**CORS** — `after_request` hook for `/api/v5/` paths:
```
Access-Control-Allow-Origin: *  (configurable)
Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type, If-None-Match
Access-Control-Expose-Headers: ETag, Location
Access-Control-Max-Age: 86400
```

**Note**: Must also handle OPTIONS preflight requests correctly. Flask's
`provide_automatic_options` (True by default) generates OPTIONS responses, but the
`after_request` hook must ensure CORS headers are added to these responses too.
Alternatively, consider using `flask-cors` to avoid manual CORS implementation pitfalls.

**Important**: For admin and discovery endpoints that need DB access (e.g., for auth
validation and listing test suites), the middleware must open a DB session even without
a testsuite context. Use a two-phase approach: always open a DB session for `/api/v5/`
paths, and only resolve the testsuite when the URL contains one.

### 4.3 Authentication (`auth.py`)

**Scope hierarchy** (linear, each level includes all below):

| Scope | Level | Can do |
|-------|-------|--------|
| `read` | 0 | All GET endpoints |
| `submit` | 1 | Submit runs (POST /runs) |
| `triage` | 2 | Regression state/title/bug, ignore/un-ignore field changes, create/merge/split regressions |
| `manage` | 3 | Create/update/delete machines, orders; delete runs |
| `admin` | 4 | Create/revoke API keys |

**Token validation flow:**
1. Extract token from `Authorization: Bearer <token>` header
2. Hash with SHA-256, look up in `APIKey` table
3. Verify `is_active == True`
4. Compare granted scope level against required scope level
5. If no token and endpoint requires only `read` scope: allow (unauthenticated reads,
   matching v4 behavior). Configurable via `require_auth_for_reads` in lnt.cfg.

**Bootstrap**: If the existing `api_auth_token` is configured in `lnt.cfg`, a Bearer
token matching it is treated as an `admin`-scoped key. This lets existing deployments
use the v5 API immediately and create proper scoped API keys via
`POST /api/v5/admin/api-keys` without any new CLI commands.

**Decorator**: `@require_scope(scope_name)` — use on each endpoint method.

### 4.4 Error Handling (`errors.py`)

**Error handling scoped to v5 only** — do NOT register error handlers on `app` globally
(that would break v4 error format). Instead, customize error responses at the
`flask_smorest.Api` level by overriding `Api.handle_http_exception` or setting a custom
error handler. Since the `Api` object only handles requests routed through its blueprints,
this naturally scopes to v5 endpoints.

**Note**: flask-smorest's `Blueprint` does NOT have an `errorhandler()` method that works
like Flask's. Error customization must happen at the `Api` level.

For validation errors, flask-smorest/webargs returns `{"errors": {"json": ...}}` by
default. Override this to produce the required format:

```python
# Format: {"error": {"code": "not_found", "message": "Machine 'foo' not found"}}
```

Error codes: `validation_error` (400/422), `unauthorized` (401), `forbidden` (403),
`not_found` (404), `conflict` (409), `internal_error` (500).

### 4.5 Pagination (`pagination.py`)

**Cursor-based** (for unbounded lists):
- Cursor encodes the last-seen primary key ID as base64
- Forward pagination only (no `previous` cursor in v1 — simplifies implementation)
- Response envelope: `{"items": [...], "cursor": {"next": "...", "previous": null}}`
- Helper: `cursor_paginate(query, id_column, cursor_str, limit)` → `(items, next_cursor)`
- Wrap cursor decoding in try/except; return 400 on malformed cursors

**Offset-based** (for bounded lists):
- Same envelope shape for consistency: `{"items": [...], "cursor": {"next": null, "previous": null}}`
- Include `"total"` field alongside `cursor` for bounded lists where the total is cheap to compute

**Note**: Backward cursor pagination (`previous` cursor) is deferred to a later iteration.
The `previous` field is always present in responses but set to `null` in v1. This is a
deliberate simplification; the envelope structure is forward-compatible with adding it later.

### 4.6 ETag Support (`etag.py`)

- Compute ETags from response data hash (MD5 of JSON-serialized response)
- Use weak ETags: `W/"<hash>"`
- Check `If-None-Match` header; return 304 if match
- Parse comma-separated ETags per RFC 7232
- Apply primarily to single-resource GET endpoints (detail views)
- For list endpoints: skip ETags initially (the data changes frequently and computing
  the full response just to check the ETag defeats the purpose)

### 4.7 Dynamic Marshmallow Schemas

The key challenge: LNT models are generated dynamically per test suite, with different
columns depending on the suite's schema. Marshmallow schemas for flask-smorest must be
known at decoration time for OpenAPI generation.

**Solution**: Use a two-layer approach:
1. **Static base schemas** with known fields (uuid, name, start_time, etc.) used for
   flask-smorest decorators and OpenAPI documentation
2. **Dynamic fields** serialized into a `fields` or `parameters` dict (type: `Dict`)
   in the response — this captures the test-suite-specific fields without needing
   per-suite schema classes
3. Cache dynamically-generated schema subclasses per test suite for internal use

This means the OpenAPI spec shows `fields: object` for dynamic portions, which is less
precise but correct and maintainable.

---

## 5. Endpoint Plans

### 5.1 Discovery (`GET /api/v5/`)

Returns list of available test suites with links:
```json
{
  "test_suites": [
    {
      "name": "nts",
      "links": {
        "machines": "/api/v5/nts/machines",
        "orders": "/api/v5/nts/orders",
        "runs": "/api/v5/nts/runs",
        "tests": "/api/v5/nts/tests",
        "regressions": "/api/v5/nts/regressions",
        "field_changes": "/api/v5/nts/field-changes",
        "query": "/api/v5/nts/query"
      }
    }
  ]
}
```

Enumerate via `app.instance.get_database("default").testsuite.keys()`.
Auth: no auth required (public).

### 5.2 Machines

**Endpoints:**
```
GET    /api/v5/{ts}/machines                     — List (offset-paginated, filterable)
POST   /api/v5/{ts}/machines                     — Create
GET    /api/v5/{ts}/machines/{machine_name}       — Detail
PATCH  /api/v5/{ts}/machines/{machine_name}       — Update (including rename)
DELETE /api/v5/{ts}/machines/{machine_name}       — Delete (cascading)
GET    /api/v5/{ts}/machines/{machine_name}/runs  — List runs (cursor-paginated)
```

**Key design decisions:**
- Machine name as URL key. Use `<string:machine_name>` (not `<path:>`). Names with
  slashes must be percent-encoded by clients. Document this.
- Machine name is NOT unique in DB. On lookup: 0 results → 404, 1 result → return it,
  >1 results → 409 Conflict with message.
- On POST: check uniqueness before insert. Catch `IntegrityError` on commit as fallback
  for race conditions. Consider adding a DB unique constraint via migration.
- On PATCH with name change: check new name uniqueness. Response includes new URL in
  `Location` header.
- On DELETE: chunked deletion (batches of 50-100 runs) to avoid OOM/timeout.
  **Important**: `ChangeIgnore` rows have an FK to `FieldChange` but NO cascade configured.
  On Postgres, deleting FieldChanges (via machine cascade) will fail with FK violations
  unless ChangeIgnore rows are deleted first. This is a pre-existing bug in v4. The v5
  delete code must explicitly delete ChangeIgnore rows for the machine's FieldChanges
  before the cascade delete runs.
- Auth: read=GET, manage=POST/PATCH/DELETE.

**Filters** (on list): `name_contains=`, `name_prefix=`
**Filters** (on runs): `after=`, `before=` (ISO datetime), `sort=-start_time`

### 5.3 Orders

**Endpoints:**
```
GET    /api/v5/{ts}/orders                      — List (cursor-paginated, filterable)
POST   /api/v5/{ts}/orders                      — Create with metadata
GET    /api/v5/{ts}/orders/{order_value}         — Detail (includes prev/next)
PATCH  /api/v5/{ts}/orders/{order_value}         — Update metadata
```

**Key design decisions:**
- `order_value` is the primary order field value (e.g., a revision number, git SHA, etc.)
- For multi-field orders: additional query params disambiguate. 409 if ambiguous.
- Order detail includes `previous_order` and `next_order` references (field values + links)
- `after`/`before` filtering: use Order.id comparison in SQL (Order IDs approximate
  insertion order, which correlates with revision order for most deployments). For
  correctness, post-filter in Python using `convert_revision()`. Cap the query with
  a SQL LIMIT as safety net.
- No DELETE (return 405).
- Order metadata storage: if the Order model lacks a `parameters_data` column, the
  PATCH endpoint is deferred until a migration adds one. For v1, POST creates orders
  with field values only.
- Auth: read=GET, submit=POST, manage=PATCH.

### 5.4 Runs

**Endpoints:**
```
GET    /api/v5/{ts}/runs                — List (cursor-paginated, filterable)
POST   /api/v5/{ts}/runs               — Submit (generates UUID, returns it)
GET    /api/v5/{ts}/runs/{uuid}         — Detail
DELETE /api/v5/{ts}/runs/{uuid}         — Delete
```

**Key design decisions:**
- UUID generated server-side in `_getOrCreateRun()` (new `uuid` column on Run).
  **Important**: The UUID must be set right after constructing the Run object (around
  line 1017 of `testsuitedb.py`), BEFORE `import_and_report()` calls `session.commit()`
  at ImportData.py line 147. The import pipeline does multiple commits during a single
  request, so setting the UUID after the function returns would be too late.
- Submission reuses existing `ImportData.import_from_string()` pipeline for backward
  compatibility with `lnt submit` tool. This function requires `current_app.old_config`
  as its `config` argument (it uses `config.tempDir`, `config.databases`, etc.) and
  `g.db_name` must be set to `"default"` (done by middleware).
- `machine=` filter accepts **machine name** (string), NOT machine ID.
  Internally: look up machine by name → filter by machine.id. Handle ambiguous names.
- Response NEVER exposes internal IDs. Use `machine_name` instead of `machine_id`,
  `uuid` instead of `id`.
- Run deletion: `session.delete(run)` with cascading. For runs with many samples,
  consider batched sample deletion.
- For `merge='replace'` strategy: new run gets a NEW UUID.
- Auth: read=GET, submit=POST, manage=DELETE.

**Filters**: `machine=` (name), `order=` (exact match on primary order field value), `after=`, `before=` (ISO datetime), `sort=-start_time`

### 5.5 Tests

**Endpoints:**
```
GET    /api/v5/{ts}/tests                  — List (cursor-paginated, filterable)
GET    /api/v5/{ts}/tests/{test_name}      — Detail
```

**Key design decisions:**
- Read-only. Tests created implicitly via run submission.
- Use `<path:test_name>` converter for test names with slashes
- Filter: `name_contains=`, `name_prefix=`, `machine=`, `metric=`
- `machine=` and `metric=` join through Sample → Run to return only tests
  that have actual data for the given machine and/or metric. The query uses
  `DISTINCT` to deduplicate.
- Escape `%` and `_` in user-supplied LIKE patterns to prevent pattern injection
- Auth: read only.

### 5.6 Samples

**Endpoints:**
```
GET    /api/v5/{ts}/runs/{uuid}/samples                         — All samples (cursor-paginated)
GET    /api/v5/{ts}/runs/{uuid}/samples?has_profile=true         — Filter to profiled samples
GET    /api/v5/{ts}/runs/{uuid}/tests/{test_name}/samples        — Samples for specific test
```

**Key design decisions:**
- Always accessed through parent run (no independent identifier)
- Serialization: `test_name`, `has_profile`, `metrics: {field_name: value, ...}`
- Dynamic metric fields serialized into a `metrics` dict
- No internal IDs exposed
- Auth: read only.

### 5.7 Profiles

**Endpoints:**
```
GET  /api/v5/{ts}/runs/{uuid}/tests/{test_name}/profile                     — Metadata + counters
GET  /api/v5/{ts}/runs/{uuid}/tests/{test_name}/profile/functions            — Function list
GET  /api/v5/{ts}/runs/{uuid}/tests/{test_name}/profile/functions/{fn_name}  — Disassembly
```

**Key design decisions:**
- Find sample for run+test that has a profile attached
- Always load profile from DISK (not the truncated DB `counters` column)
  via `sample.profile.load(profileDir)`
- Use existing methods: `getTopLevelCounters()`, `getFunctions()`, `getCodeForFunction()`
- Handle missing profile files gracefully (404 with clear message)
- Function list: not paginated (typically small). Document that very large profiles
  may produce large responses.
- Use `<path:fn_name>` for C++ mangled function names
- Auth: read only.

### 5.8 Regressions

**Endpoints:**
```
GET    /api/v5/{ts}/regressions                              — List (cursor-paginated)
POST   /api/v5/{ts}/regressions                              — Create from field changes
GET    /api/v5/{ts}/regressions/{uuid}                       — Detail with indicators
PATCH  /api/v5/{ts}/regressions/{uuid}                       — Update
DELETE /api/v5/{ts}/regressions/{uuid}                       — Delete
POST   /api/v5/{ts}/regressions/{uuid}/merge                 — Merge
POST   /api/v5/{ts}/regressions/{uuid}/split                 — Split
GET    /api/v5/{ts}/regressions/{uuid}/indicators            — List indicators
POST   /api/v5/{ts}/regressions/{uuid}/indicators            — Add indicator
DELETE /api/v5/{ts}/regressions/{uuid}/indicators/{fc_uuid}  — Remove indicator
```

**Key design decisions:**
- Identified by **UUID** (NOT integer ID). Requires migration.
- State mapping: API strings ↔ DB integers:
  `detected`↔0, `staged`↔1, `active`↔10, `not_to_be_fixed`↔20,
  `ignored`↔21, `fixed`↔22, `detected_fixed`↔23
- State transitions unconstrained.

**Detail response** includes embedded indicators:
```json
{
  "uuid": "...", "title": "...", "bug": "...", "state": "active",
  "indicators": [
    {
      "field_change_uuid": "...",
      "test_name": "...", "machine_name": "...", "field_name": "...",
      "old_value": 0.5, "new_value": 0.8,
      "start_order": "154000", "end_order": "154331",
      "run_uuid": "..."
    }
  ]
}
```

**Merge**: target absorbs sources. Sources marked as IGNORED. Indicators moved to target.
Deduplicate indicators (don't link same field change twice). Validate: cannot merge into self.
Request body uses UUIDs: `{"source_regression_uuids": ["...", "..."]}`.

**Split**: move specified field changes to a new regression. Validate: cannot split ALL
indicators (would leave source empty). Request body uses UUIDs:
`{"field_change_uuids": ["...", "..."]}`.

**Filtering**: `state=` (multiple values), `machine=` (name, requires JOIN through
indicators→field_changes→machines), `test=` (name, similar JOIN).

Auth: read=GET, triage=POST/PATCH/DELETE/merge/split/indicators.

### 5.9 Field Changes

**Endpoints:**
```
GET    /api/v5/{ts}/field-changes                 — List unassigned (cursor-paginated)
POST   /api/v5/{ts}/field-changes                 — Create a field change
POST   /api/v5/{ts}/field-changes/{uuid}/ignore    — Ignore
DELETE /api/v5/{ts}/field-changes/{uuid}/ignore    — Un-ignore
```

**Key design decisions:**
- Identified by **UUID** (NOT integer ID). Requires migration.
- "Unassigned" = no RegressionIndicator AND no ChangeIgnore (LEFT JOIN + IS NULL pattern
  from regression_views.py line 77-85)
- Filters: `machine=`, `test=`, `field=`
- Ignore: create ChangeIgnore row. 409 if already ignored.
- Un-ignore: delete ChangeIgnore row. 404 if not ignored.
- Auth: read=GET, triage=POST (ignore/un-ignore), submit=POST (create).

**POST /field-changes (create):**
- Allows creating a field change programmatically (e.g., from external analysis tools)
- Request body fields (all resolved by name, not internal ID):
  - `machine` (string, required) — machine name
  - `test` (string, required) — test name
  - `metric` (string, required) — metric name as defined in the test suite schema
  - `old_value` (float, required) — previous value
  - `new_value` (float, required) — new value
  - `start_order` (string, required) — primary order field value for the start of the change
  - `end_order` (string, required) — primary order field value for the end of the change
  - `run_uuid` (string, optional) — UUID of the associated run
- Returns 404 if machine, test, metric, start_order, end_order, or run_uuid cannot be resolved
- Server generates a UUID for the new field change
- Returns 201 with the serialized field change on success
- Auth: `submit` scope required

### 5.10 Time Series

**Endpoint:**
```
POST /api/v5/{ts}/query
Body (JSON): {metric, machine, test, order, after_order, before_order,
              after_time, before_time, sort, limit, cursor}
```

**Key design decisions:**
- Uses POST with a JSON body (not GET with query params) to avoid URL length
  limits when querying many tests with long names.
- `metric` is REQUIRED (by name, not ID). All other fields are optional.
- `test` is a list of test names for disjunction queries.
  Unknown test names are silently skipped (no 404).
- Field name → Sample column resolution via `ts.sample_fields` name→column mapping
- Core query: `SELECT field.column, order.*, run.* FROM Sample JOIN Run JOIN Order
  WHERE machine_id=X AND test_id IN (...) AND field IS NOT NULL`
- Filter out failing tests if the field has a status_field
- Order filtering: `order` for exact match (=), `after_order`/`before_order` for
  exclusive range (>/< on Order.id). `order` cannot be combined with range params.
- Ordering: fetch with SQL ORDER BY on Order.id, then post-sort in Python using
  `convert_revision()` for correctness. Apply `after`/`before` filters in Python.
  Cap SQL query at 10,000 rows as safety limit.
- Cursor: encode the last order's field values. On next request, use to resume.
- Response per data point: `{value, order: {field_name: value}, run_uuid, timestamp}`
- Auth: read only.

### 5.11 Schema and Fields

Schema definitions and metric field metadata are provided through the test-suites
endpoint rather than as standalone endpoints:

```
GET /api/v5/test-suites/{name}  — Returns schema + fields in the response body
```

The `GET /api/v5/test-suites/{name}` response includes a `schema` object (produced by
`ts.test_suite.__json__()`) containing `machine_fields`, `run_fields`, and `metrics`.
Each metric entry includes: `name`, `type`, `display_name`, `unit`, `unit_abbrev`,
`bigger_is_better`, `ignore_same_hash`.

There are no separate `/fields` or `/schema` endpoints. Clients that need field
metadata should call `GET /api/v5/test-suites/{name}` and read the `schema` object.

Auth: read only (no auth required for test-suite detail).

### 5.12 Admin (API Keys)

**Endpoints:**
```
GET    /api/v5/admin/api-keys              — List keys (admin)
POST   /api/v5/admin/api-keys              — Create key (admin), returns raw token ONCE
DELETE /api/v5/admin/api-keys/{prefix}     — Revoke key by prefix (admin)
```

- Keys identified by their `prefix` (first 8 chars of the token, stored in DB) in URLs.
  This avoids exposing internal integer IDs per R2.
- POST returns `{"key": "raw-token-value", "prefix": "abc12345", "scope": "read"}`
  The raw token is shown ONCE and never stored in plaintext.
- List shows: prefix, name, scope, created_at, last_used_at, is_active (never the hash)
- DELETE sets is_active=False (soft delete for audit trail)
- Auth: admin scope required for all.

### 5.13 AI Agent Orientation (`GET /llms.txt`)

**File**: `lnt/server/api/v5/endpoints/agents.py`

Serves a plain-text orientation document at `GET /llms.txt` following the llms.txt
convention (analogous to robots.txt). Helps AI agents understand what LNT is, its
domain concepts, and how to navigate the API.

**Key design decisions:**
- Plain Flask blueprint (not flask-smorest) — keeps it out of the OpenAPI spec
- Registered on the Flask app directly in `create_v5_api()`
- Static content defined as a Python string constant — no template or DB access
- Content-Type: `text/plain; charset=utf-8`
- No authentication required
- Outside the `/api/v5/` prefix for conventional discoverability

Content includes: LNT description, key concepts (test suite, machine, order, run,
test, sample, regression, field change), endpoint listing, pagination format,
links to Swagger UI and OpenAPI spec, and common workflows.

---

## 6. Testing Strategy

### 6.1 Framework

Use **pytest** for v5 API test logic, running against **PostgreSQL** (not SQLite).
Each test file includes a lit `RUN` line that uses `with_postgres.sh` to set up a
Postgres instance, then invokes pytest. This combines:
- Postgres as the real production database engine (catches type coercion, FK enforcement,
  string comparison, and transaction isolation differences that SQLite would mask)
- lit integration with the existing test infrastructure
- pytest's ergonomics (fixtures, parametrize, clear assertions)

Example test file structure:
```python
# RUN: %{shared_inputs}/with_postgres.sh %s

import pytest
# ... normal pytest tests using Flask test client against Postgres ...
```

### 6.2 Fixtures (`tests/server/api/v5/conftest.py`)

```python
@pytest.fixture(scope="session")
def app():
    """Create Flask app with test instance against Postgres (set up by with_postgres.sh)."""

@pytest.fixture
def client(app):
    """Flask test client."""
    return app.test_client()

@pytest.fixture
def db_session(app):
    """Direct DB session for test setup/assertions. Rolls back after each test."""

@pytest.fixture
def admin_headers(app):
    """Auth headers with admin scope for test requests."""

@pytest.fixture
def read_headers(app):
    """Auth headers with read scope."""
```

Use `scope="function"` for db_session to ensure test isolation. For the client fixture,
consider wrapping each test in a transaction savepoint that gets rolled back.

### 6.3 Test Files

```
tests/server/api/v5/
    conftest.py
    test_discovery.py
    test_machines.py
    test_orders.py
    test_runs.py
    test_tests.py
    test_samples.py
    test_profiles.py
    test_regressions.py
    test_field_changes.py
    test_series.py
    test_admin.py
    test_auth.py
    test_errors.py
    test_pagination.py
    test_etag.py
```

### 6.4 Coverage Requirements

Each endpoint must test:
- Happy path (200/201/204 responses)
- Not found (404)
- Auth required (401 without token)
- Insufficient scope (403 with wrong scope)
- Validation errors (400/422 for bad input)
- Conflict cases (409 for duplicates)
- Pagination (cursor navigation, limit parameter)
- Filtering (each filter parameter)
- ETag (on detail endpoints)

---

## 7. Implementation Phases

### Phase 1: Foundation
1. Add dependencies to pyproject.toml
2. Create package structure (`lnt/server/api/v5/`)
3. Write migration `upgrade_18_to_19.py` (UUID columns + APIKey table)
4. Update model definitions in `testsuitedb.py` (UUID columns)
5. Implement `create_v5_api()` and register in `app.py`
6. Implement middleware (testsuite resolution, CORS, session lifecycle)
7. Implement auth (APIKey model, Bearer validation, scope decorators)
8. Implement error handling (blueprint-scoped)
9. Implement pagination utilities (cursor + offset)
10. Implement ETag utilities
11. Set up pytest infrastructure (conftest.py, fixtures)
12. Implement discovery endpoint
13. Implement admin/API key endpoints
14. Write tests for auth, errors, pagination, discovery, admin

### Phase 2: Core Read Endpoints
15. Machine list and detail + tests
16. Order list and detail + tests
17. Test list and detail + tests

### Phase 3: Write Endpoints
18. Run submission (POST /runs) + tests
19. Run detail and delete + tests
20. Machine create, update, delete + tests
21. Order create and update + tests

### Phase 4: Samples and Profiles
22. Sample listing endpoints + tests
23. Profile endpoints + tests

### Phase 5: Regressions and Field Changes
24. Regression CRUD + tests
25. Regression merge and split + tests
26. Regression indicators + tests
27. Field change triage + tests

### Phase 6: Time Series
28. Series endpoint + tests

### Phase 7: Polish
29. OpenAPI spec review and validation
30. ETag support on all detail endpoints
31. End-to-end integration tests
32. Documentation review

---

## 8. Key Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| flask-smorest incompatible with SQLAlchemy 1.3.24 | **Verified: compatible.** flask-smorest 0.46.2 works with SQLAlchemy 1.3.24 |
| flask-smorest conflicts with Flask-RESTful | **Verified: coexists.** Both frameworks work on the same app without conflicts |
| Dynamic schemas vs OpenAPI generation | Use Dict fields for dynamic portions. Accept less precise OpenAPI docs |
| Large machine deletion timeouts | Chunked deletion (50-100 runs per batch) |
| Migration on large databases | Batched UUID backfill (1000 rows per batch) |
| Machine name ambiguity (duplicates) | 409 Conflict response with guidance to merge/rename |
| Order after/before filtering correctness | Python post-filtering with convert_revision() |
| Test names with slashes in URLs | <path:test_name> converter; document client must not end names with /profile or /samples |

---

## 9. Files Modified in Existing Codebase

| File | Change |
|------|--------|
| `pyproject.toml` | Add flask-smorest dependency |
| `lnt/server/ui/app.py` | Add `create_v5_api(app)` call after line 153 |
| `lnt/server/db/testsuitedb.py` | Add UUID columns to Run, FieldChange, Regression classes |
| `lnt/server/db/testsuitedb.py` | Set UUID in `_getOrCreateRun()` |
| `lnt/server/db/regression.py` | Set UUID in `new_regression()` |
| `lnt/server/db/fieldchange.py` | Set UUID when creating FieldChange objects (in `regenerate_fieldchanges_for_run()`) |
| `lnt/server/db/migrations/` | Add `upgrade_18_to_19.py` |
| `lnt/server/db/migrate.py` | Bump expected schema version |
