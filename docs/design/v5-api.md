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
- Entities addressed by natural keys (machine name, test name) or server-generated UUIDs (runs, regressions) — never by internal auto-increment database IDs
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

Commits

GET    /commits                      — List (cursor-paginated, searchable)
POST   /commits                      — Create with metadata (commit_fields)
GET    /commits/{value}              — Detail (includes previous/next commit by ordinal)
PATCH  /commits/{value}              — Update ordinal and/or commit_fields
DELETE /commits/{value}              — Delete commit (cascades to runs/samples; 409 if referenced by regressions)
The {value} in the path is the commit identity string. Commits are also created implicitly during run submission.
Ordinals are always NULL on creation and assigned exclusively via PATCH (see D11 in v5-db.md).

Runs

GET    /runs                         — List (cursor-paginated, filterable by machine=, after=, before=)
POST   /runs                         — Submit run (server generates UUID, returns it)
GET    /runs/{uuid}                  — Detail
DELETE /runs/{uuid}                  — Delete run
The UUID is a new field, generated server-side on submission. The submission endpoint requires JSON format with format_version '5'. Legacy formats (v0, v1, v2) and non-JSON payloads are rejected.

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

GET    /regressions                              — List (cursor-paginated, filterable by state=, machine=, test=, metric=, commit=, has_commit=)
POST   /regressions                              — Create (accepts title, bug, notes, state, commit, indicators)
GET    /regressions/{uuid}                       — Detail (indicators embedded)
PATCH  /regressions/{uuid}                       — Update title, bug, notes, state, commit
DELETE /regressions/{uuid}                       — Delete (cascades indicators)
POST   /regressions/{uuid}/indicators            — Add indicator(s) (batch)
DELETE /regressions/{uuid}/indicators            — Remove indicator(s) (batch, UUIDs in body)

Auth scopes: read=GET, triage=POST/PATCH/DELETE and indicator management.

Regressions are identified by server-generated UUID.

Regression states (string enum):
detected, active, not_to_be_fixed, fixed, false_positive

State transitions are unconstrained — any state can be set to any other
state via PATCH.

Create request body:
- title (string, optional — auto-generated if omitted)
- bug (string, optional — URL to external bug tracker)
- notes (string, optional — investigation findings, A/B results, etc.)
- state (string, optional — default: detected)
- commit (string, optional — suspected introduction commit, resolved by value)
- indicators (array, optional — list of {machine, test, metric} objects,
  all resolved by name)

Detail response (GET /regressions/{uuid}):
- uuid, title, bug, notes, state
- commit (commit identity string, or null)
- indicators: list of {uuid, machine, test, metric}

List response items include: uuid, title, bug, state, commit, machine_count, test_count.
The notes field is included in detail responses only, not in list.

Indicator add request (POST /regressions/{uuid}/indicators):
- Array of {machine, test, metric} objects. Each object is one indicator.
  Duplicates (same regression+machine+test+metric) are silently ignored.

Indicator remove request (DELETE /regressions/{uuid}/indicators):
- Body: {"indicator_uuids": ["...", "..."]}

Time Series

POST   /query
  Body (JSON): {metric, machine, test, commit, after_commit, before_commit,
                after_time, before_time, sort, limit, cursor}
The metric field is required; all other fields are optional.
The test field accepts a list of names for disjunction queries.
The commit field filters for an exact commit match and cannot be combined with after_commit/before_commit.
Returns cursor-paginated time-series data for graphing. Each data point contains: test, machine, metric, value, commit, ordinal, run_uuid, submitted_at.
Sort fields: test, commit (by ordinal), submitted_at. Default sort: commit,test.

Trends (Aggregated)

POST   /trends
  Body (JSON): {metric, machine, after_time, before_time}
The metric field is required and must have type `real`; `status` and `hash` metrics are rejected with 400. All other fields are optional.
Unlike the query endpoint's single machine string, machine accepts a list of names — the Dashboard needs data for multiple machines in one call.
Order-based filters are intentionally omitted; the Dashboard uses time-based filtering exclusively.
Returns geomean-aggregated trend data per (machine, commit). Not paginated — the result set is bounded by (machines × commits in range), typically < 2000 rows.
Each item contains: machine name, commit string, ordinal (nullable), submitted_at (latest run submission time), and geomean value.
Geomean is computed in SQL: `exp(avg(ln(positive_values)))`, skipping zero/negative values.

Schema and Fields

Schema definitions and metric field metadata are returned as part of the test suite
detail response (GET /api/v5/test-suites/{name}) rather than as standalone endpoints.
The response includes a "schema" object containing machine_fields, commit_fields, and
metrics (with name, type, display_name, unit, unit_abbrev, bigger_is_better for each).
There are no separate /fields or /schema endpoints.

R4: Pagination

- Cursor-based pagination for unbounded lists: runs, tests, commits, samples, regressions, regression indicators, time series
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
  - commit=, has_commit= (for regressions)
  - has_profile=true (for samples)
  - sort=<field> (prefix with - for descending: sort=-start_time)
- Exact filters and available sort fields defined per endpoint in the OpenAPI spec
- Filtering by a nonexistent entity name (machine=, test=) returns 404. Filtering by an unknown metric returns 400.

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
  - submit — submit runs (POST /runs), create commits (POST /commits)
  - triage — create/update/delete regressions, manage regression indicators
  - manage — create/update/delete machines; update commits; delete runs
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
