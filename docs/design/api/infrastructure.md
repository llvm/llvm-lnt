# v5 REST API: Infrastructure

This document covers the framework, URL structure, pagination, filtering,
response format, authentication, testing strategy, and deferred features for
the v5 REST API.

For endpoint specifications, see [`endpoints.md`](endpoints.md).


## R1: Framework and Standards

- Implement using flask-smorest within the existing Flask application
- OpenAPI 3.x specification auto-generated from code annotations and marshmallow schemas
- Target Python 3.10+
- New code lives in `lnt/server/api/v5/` package, completely separate from existing API code
- Existing v4 API remains unchanged -- no modifications to `api.py` or its behavior
- Reuse existing database models (SQLAlchemy schemas in `testsuitedb.py`, `testsuite.py`, etc.) but do not treat reuse of existing API implementation code as a requirement -- write clean new implementations where appropriate
- CORS headers enabled on all v5 endpoints (`Access-Control-Allow-Origin: *`)


## R2: URL Structure and Identifiers

- Base path: `/api/v5/{testsuite}/`
- Always uses the default database (no `db_<database>` prefix)
- Entities addressed by natural keys (machine name, test name) or server-generated UUIDs (runs, regressions) -- never by internal auto-increment database IDs
- A discovery endpoint at `GET /api/v5/` lists available test suites with links to their resources


## R4: Pagination

- Cursor-based pagination for unbounded lists: runs, tests, commits, samples, regressions, regression indicators, time series
- Simple offset-based or unpaginated for bounded/small lists: machines, API keys
- Cursor-paginated response envelope: `{"items": [...], "cursor": {"next": "...", "previous": "..."}}`
- Default page size 25 with configurable `limit` parameter (max 10,000)
- Cursors are opaque strings (clients must not parse them)


## R5: Filtering and Sorting

- Named query parameters per endpoint, documented in OpenAPI spec
- Supported filter types per endpoint (examples):
  - `machine=`, `test=`, `metric=`, `search=` (case-insensitive substring; see D9)
  - `after=`, `before=` (for timestamps and order values; exclusive)
  - `state=` (for regressions, supports multiple values: `?state=active&state=detected`)
  - `commit=`, `has_commit=` (for regressions)
  - `sort=<field>` (prefix with `-` for descending: `sort=-start_time`)
- Exact filters and available sort fields defined per endpoint in the OpenAPI spec
- Filtering by a nonexistent entity name (`machine=`, `test=`) returns 404. Filtering by an unknown metric returns 400.


## R6: Response Format

- All responses in JSON
- Standardized error format:
  `{"error": {"code": "not_found", "message": "Machine 'foo' not found in test suite 'nts'"}}`
- Standard HTTP status codes: 200, 201, 204, 304, 400, 401, 403, 404, 409, 422
- ETag headers on GET responses; support `If-None-Match` for conditional requests returning 304 Not Modified when data hasn't changed


## R7: Authentication and Authorization

- `Authorization: Bearer <token>` header on all requests
- API keys with scopes (each scope includes all scopes above it):
  - **read** -- all GET endpoints
  - **submit** -- submit runs (`POST /runs`), create commits (`POST /commits`)
  - **triage** -- create/update/delete regressions, manage regression indicators
  - **manage** -- create/update/delete machines; update/delete commits; delete runs
  - **admin** -- create/revoke API keys
- Keys stored hashed in the database
- Admin endpoints (outside any test suite):

```
GET    /api/v5/admin/api-keys          -- List keys (admin)
POST   /api/v5/admin/api-keys          -- Create key (admin), returns the raw token once
DELETE /api/v5/admin/api-keys/{prefix}  -- Revoke key (admin)
```


## R8: Testing

- All API endpoints must have automated tests
- Use current best practices for Flask API testing (e.g. pytest with Flask test client, or similar)
- Tests should cover: happy paths, error cases, authentication/authorization, pagination, filtering


## R9: Not in Scope (Deferred)

- Webhooks / change notifications
- Multi-database support
- Rate limiting
- Run comparison / derived analytics endpoints
- Report endpoints (daily, summary, latest runs)
- Machine merge


## R10: AI Agent Orientation

- Serve a plain-text orientation document at `GET /llms.txt` (following the
  llms.txt convention, analogous to robots.txt)
- Content: what LNT is, key domain concepts, API structure, common workflows,
  and links to Swagger UI / OpenAPI spec
- Static content, no authentication required
- Served as `text/plain` with UTF-8 charset
- Registered as a plain Flask blueprint (not flask-smorest) so it does not
  appear in the OpenAPI spec
