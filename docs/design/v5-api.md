R1: Framework and Standards

- Implement using flask-smorest within the existing Flask application
- OpenAPI 3.x specification auto-generated from code annotations and marshmallow schemas
- Target Python 3.10+
- New code lives in lnt/server/api/v5/ package, completely separate from existing API code
- Existing v4 API remains unchanged — no modifications to api.py or its behavior
- Reuse existing database models (SQLAlchemy schemas in testsuitedb.py, testsuite.py, etc.) but do not treat reuse of existing API implementation code as a requirement — write clean new implementations where
appropriate
- CORS headers enabled on all v5 endpoints (Access-Control-Allow-Origin: *)

R2: URL Structure and Identifiers

- Base path: /api/v5/{testsuite}/
- Always uses the default database (no db_<database> prefix)
- Entities addressed by natural keys (machine name, test name) or server-generated UUIDs (runs, regressions, field changes) — never by internal auto-increment database IDs
- A discovery endpoint at GET /api/v5/ lists available test suites with links to their resources

R3: Entity Endpoints

Machines

GET    /machines                     — List (filterable, simple pagination)
POST   /machines                     — Create machine independently
GET    /machines/{machine_name}      — Detail
PATCH  /machines/{machine_name}      — Update metadata/parameters (including rename)
DELETE /machines/{machine_name}      — Delete machine and its runs
GET    /machines/{machine_name}/runs — List runs for this machine (cursor-paginated)
Machines are also created implicitly if a run is submitted for a nonexistent machine.

Orders

GET    /orders                       — List (cursor-paginated, filterable)
POST   /orders                       — Create with metadata (git commit info, etc.)
GET    /orders/{order_id}            — Detail (includes previous/next order references)
PATCH  /orders/{order_id}            — Update metadata
Orders are read/create/update only — no delete. The order_id in the path is the primary order field value (e.g. the revision hash). If order fields are multi-valued and ambiguous, query parameters
disambiguate. Orders are also created implicitly during run submission.

Runs

GET    /runs                         — List (cursor-paginated, filterable by machine=, after=, before=)
POST   /runs                         — Submit run (server generates UUID, returns it)
GET    /runs/{uuid}                  — Detail
DELETE /runs/{uuid}                  — Delete run
The UUID is a new field, generated server-side on submission. This requires a database schema migration to add the column. The submission endpoint requires JSON format with format_version '2'. Legacy formats (v0, v1) and non-JSON payloads are rejected.

Tests

GET    /tests                        — List (cursor-paginated, filterable)
GET    /tests/{test_name}            — Detail
Read-only. Tests are created implicitly via run submission.
Filters: name_contains=, name_prefix=, machine= (only tests with data for this machine), metric= (only tests with non-NULL values for this metric).

Samples

Samples are always accessed through their parent run — they have no external identifier of their own.
GET    /runs/{uuid}/samples                        — All samples for a run (cursor-paginated)
GET    /runs/{uuid}/samples?has_profile=true        — Filter to samples with profiles
GET    /runs/{uuid}/tests/{test_name}/samples       — Samples for a specific test in a run
Read-only. Samples are created as part of run submission.

Profiles

Profiles are accessed through run + test name. Under the hood, the API finds the sample for that run+test that has a profile attached.
GET  /runs/{uuid}/tests/{test_name}/profile                      — Profile metadata + top-level counters
GET  /runs/{uuid}/tests/{test_name}/profile/functions             — List functions with counters
GET  /runs/{uuid}/tests/{test_name}/profile/functions/{fn_name}   — Disassembly + per-instruction counters
Profiles are submitted as base64-encoded data within the run submission payload (existing format). No separate upload endpoint.

Regressions

GET    /regressions                              — List (cursor-paginated, filterable by state=, machine=, test=)
POST   /regressions                              — Create from field changes
GET    /regressions/{uuid}                       — Detail (see response contents below)
PATCH  /regressions/{uuid}                       — Update title, bug URL, state
DELETE /regressions/{uuid}                       — Delete
POST   /regressions/{uuid}/merge                 — Merge source regressions into this one
POST   /regressions/{uuid}/split                 — Split field changes into a new regression
GET    /regressions/{uuid}/indicators            — List field changes (cursor-paginated)
POST   /regressions/{uuid}/indicators            — Add field change
DELETE /regressions/{uuid}/indicators/{fc_uuid}  — Remove field change
Regressions are identified by server-generated UUID (schema migration required).

Regression states (string enum):
detected, staged, active, not_to_be_fixed, ignored, detected_fixed, fixed

State transitions are unconstrained — any state can be set to any other state via PATCH.

Regression detail response (GET /regressions/{uuid}) includes:
- uuid, title, bug, state
- Embedded list of indicators, each containing:
  - field_change_uuid
  - test, machine, metric
  - old_value, new_value
  - start_commit and end_commit (commit identity strings)

Field Changes (triage)

GET    /field-changes                — List unassigned field changes (cursor-paginated, filterable by machine=, test=, metric=)
POST   /field-changes                — Create a field change programmatically (references machine, test, metric, and commits by name)
Field changes are identified by server-generated UUID.
Creating a field change requires: machine (name), test (name), metric (name), old_value, new_value, start_commit, end_commit. All references are resolved by name/value, not internal ID.

Time Series

POST   /query
  Body (JSON): {metric, machine, test, order, after_order, before_order,
                after_time, before_time, sort, limit, cursor}
The metric field is required; all other fields are optional.
The test field accepts a list of names for disjunction queries.
The order field filters for an exact order match and cannot be combined with after_order/before_order.
Returns cursor-paginated time-series data for graphing. Uses field names (not indices) to be self-documenting.

Trends (Aggregated)

POST   /trends
  Body (JSON): {metric, machine, after_time, before_time}
The metric field is required and must be a numeric type (Real or Integer); Status and Hash metrics are rejected with 400. All other fields are optional.
Unlike the query endpoint's single machine string, machine accepts a list of names — the Dashboard needs data for multiple machines in one call.
Order-based filters are intentionally omitted; the Dashboard uses time-based filtering exclusively.
Returns geomean-aggregated trend data per (machine, commit). Not paginated — the result set is bounded by (machines × commits in range), typically < 2000 rows.
Each item contains: machine name, commit string, ordinal (nullable), submitted_at (latest run submission time), and geomean value.
Geomean is computed in SQL: `exp(avg(ln(positive_values)))`, skipping zero/negative values.

Schema and Fields

Schema definitions and metric field metadata are returned as part of the test suite
detail response (GET /api/v5/test-suites/{name}) rather than as standalone endpoints.
The response includes a "schema" object containing machine_fields, run_fields, and
metrics (with name, type, display_name, unit, unit_abbrev, bigger_is_better for each).
There are no separate /fields or /schema endpoints.

R4: Pagination

- Cursor-based pagination for unbounded lists: runs, tests, orders, samples, field changes, regressions, regression indicators, time series
- Simple offset-based or unpaginated for bounded/small lists: machines, API keys
- Cursor-paginated response envelope: {"items": [...], "cursor": {"next": "...", "previous": "..."}}
- Default page size with configurable limit parameter
- Cursors are opaque strings (clients must not parse them)

R5: Filtering and Sorting

- Named query parameters per endpoint, documented in OpenAPI spec
- Supported filter types per endpoint (examples):
  - machine=, test=, metric=, name_contains=, name_prefix=
  - after=, before= (for timestamps and order values)
  - state= (for regressions, supports multiple values: ?state=active&state=detected)
  - has_profile=true (for samples)
  - sort=<field> (prefix with - for descending: sort=-start_time)
- Exact filters and available sort fields defined per endpoint in the OpenAPI spec

R6: Response Format

- All responses in JSON
- Standardized error format:
{"error": {"code": "not_found", "message": "Machine 'foo' not found in test suite 'nts'"}}
- Standard HTTP status codes: 200, 201, 204, 304, 400, 401, 403, 404, 409, 422
- ETag headers on GET responses; support If-None-Match for conditional requests returning 304 Not Modified when data hasn't changed

R7: Authentication and Authorization

- Authorization: Bearer <token> header on all requests
- API keys with scopes (each scope includes all scopes above it):
  - read — all GET endpoints
  - submit — submit runs (POST /runs), create orders (POST /orders)
  - triage — modify regression state/title/bug, create/merge/split regressions, manage regression indicators
  - manage — create/update/delete machines; update orders; delete runs
  - admin — create/revoke API keys
- Keys stored hashed in the database
- Admin endpoints (outside any test suite):
GET    /api/v5/admin/api-keys        — List keys (admin)
POST   /api/v5/admin/api-keys        — Create key (admin), returns the raw token once
DELETE /api/v5/admin/api-keys/{prefix}  — Revoke key (admin)

R8: Testing

- All API endpoints must have automated tests
- Use current best practices for Flask API testing (e.g. pytest with Flask test client, or similar)
- Tests should cover: happy paths, error cases, authentication/authorization, pagination, filtering

R9: Not in Scope (Deferred)

- Webhooks / change notifications
- Bulk/batch query endpoints
- Multi-database support
- Rate limiting
- Run comparison / derived analytics endpoints
- Report endpoints (daily, summary, latest runs)
- Machine merge

R10: AI Agent Orientation

- Serve a plain-text orientation document at GET /llms.txt (following the
  llms.txt convention, analogous to robots.txt)
- Content: what LNT is, key domain concepts, API structure, common workflows,
  and links to Swagger UI / OpenAPI spec
- Static content, no authentication required
- Served as text/plain with UTF-8 charset
- Registered as a plain Flask blueprint (not flask-smorest) so it does not
  appear in the OpenAPI spec
