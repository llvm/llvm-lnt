# v5 REST API: Infrastructure

This document covers the framework, URL structure, pagination, filtering,
response format, and authentication for the v5 REST API.

API documentation is generated using the OpenAPI 3.x format.


## R1: URL Structure and Identifiers

- Base path: `/api/suites/{testsuite}/`
- Entities addressed by natural keys (machine name, test name) or UUIDs (runs, regressions,
  regression indicators, profiles) -- never
  by internal auto-increment database IDs. Run UUIDs may be client-provided or server-generated; all
  other UUIDs are server-generated.
- An index endpoint at `GET /api/` links to the test suite list and the API documentation
- Suite-scoped resources live one level below the suite collection, under
  `/api/suites/{testsuite}/`. This keeps them disjoint from instance-level
  routes (`/api/suites`, `/api/admin/...`), so no suite names need to be
  reserved -- a suite may legally be named `admin` or even `suites`.


## R2: Pagination

- Cursor-based pagination for unbounded lists: runs, tests, commits, samples, regressions, time series
- Simple offset-based or unpaginated for bounded/small lists: machines, API keys
- Cursor-paginated response envelope: `{"items": [...], "cursor": {"next": "...", "previous": null}}`.
  Pagination is forward-only: `previous` is always `null` (reserved for future backward pagination)
  and clients must not rely on it.
- Default page size 25 with configurable `limit` parameter (max `10 000`)
- Cursors are opaque strings (clients must not parse them)


## R3: Filtering and Sorting

- Named query parameters per endpoint, documented in OpenAPI spec
- Supported filter types per endpoint (examples):
  - `machine=`, `test=`, `metric=`, `search=` (case-insensitive substring; see D9)
  - `after=`, `before=` (submission-time range; exclusive). This is the generic
    convention for endpoints that only need to filter on one time dimension
    (currently `GET /api/suites/{testsuite}/runs` and
    `GET /api/suites/{testsuite}/machines/{name}/runs`, both filtering
    `submitted_at`). The `/api/suites/{testsuite}/query` time-series endpoint needs
    both a commit-ordinal range and a submission-time range simultaneously, so
    it uses the more specific
    `after_commit`/`before_commit`/`after_time`/`before_time` instead (see the
    endpoints spec). `GET /api/suites/{testsuite}/commits`, `GET /api/suites/{testsuite}/regressions`,
    `GET /api/suites/{testsuite}/tests`, and `POST /api/suites/{testsuite}/trends` do not
    support time-range filtering.
  - `state=` (for regressions, supports multiple values via a comma-separated
    list: `?state=active,detected`)
  - `commit=`, `has_commit=` (for regressions), `has_profiles=` (for commits and runs)
  - `tracked=` (boolean, for machines; omitted returns both)
  - `sort=<field>` (prefix with `-` for descending: `sort=-submitted_at`)
- Exact filters and available sort fields defined per endpoint in the OpenAPI spec
- Filtering by a nonexistent entity name (`machine=`, `test=`) returns 404. Filtering by an unknown metric returns 400. Filtering by a commit value that doesn't exist (`commit=`) returns an empty result set, not 404.


## R4: Response Format

- All responses in JSON
- Standardized error format:
  `{"error": {"code": "not_found", "message": "Machine 'foo' not found in test suite 'nts'"}}`
- Standard HTTP status codes: 200, 201, 204, 400, 401, 403, 404, 409, 422, 500


## R5: Authentication and Authorization

- `Authorization: Bearer <token>` header is required on any endpoint whose
  required scope exceeds what unauthenticated access grants. By default,
  `read`-scoped endpoints (all GET routes) allow unauthenticated access; this
  can be tightened via a server configuration. All higher scopes (`submit`,
  `triage`, `manage`, `admin`) always require a valid Bearer token, regardless
  of configuration.
- API keys with scopes (each scope includes all scopes above it):
  - **read** -- all GET endpoints
  - **submit** -- submit runs (`POST /api/suites/{testsuite}/runs`), create commits (`POST /api/suites/{testsuite}/commits`)
  - **triage** -- create/update/delete regressions, manage regression indicators
  - **manage** -- create/update/delete machines; update/delete commits; delete
    runs; create/delete test suites and change their schemas
  - **admin** -- create/revoke API keys
- Keys stored hashed in the database
- Admin endpoints (outside any test suite):

```
GET    /api/admin/api-keys          -- List keys (admin)
POST   /api/admin/api-keys          -- Create key (admin), returns the raw token once
DELETE /api/admin/api-keys/{prefix}  -- Revoke key (admin)
```

**Create request body** (`POST /api/admin/api-keys`): `name` (string,
required), `scope` (string, required -- one of `read`, `submit`, `triage`,
`manage`, `admin`). The response includes the created key's fields plus the
raw token; the raw token is shown only once and cannot be retrieved again.

**Key fields** (`GET /api/admin/api-keys`): each item has `prefix`, `name`,
`scope`, `created_at`, `last_used_at`, `is_active`.


## R6: AI Agent Orientation

- Serve a plain-text orientation document at `GET /llms.txt` (following the
  llms.txt convention, analogous to robots.txt)
- Content: what LNT is, key domain concepts, API structure, common workflows,
  and links to an interactive API documentation viewer / OpenAPI spec
- Static content, no authentication required
- Served as `text/plain` with UTF-8 charset


## R7: Health Check

- `GET /healthz` reports whether the server is able to serve traffic. It
  verifies database connectivity by issuing a trivial query, so a 200 means the
  process is up *and* can reach Postgres.
- Returns `200 {"ok": true}` on success, `500 {"ok": false}` if the database
  cannot be reached.
- No authentication, always public, regardless of server configuration.
- Deliberately outside `/api/`, and deliberately not using the R4 error
  envelope: this is an infrastructure probe rather than part of the REST API
  surface.
