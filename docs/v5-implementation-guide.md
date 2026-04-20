# v5 Implementation Guide

This document covers what a developer (or AI agent) needs to know about the v5
codebase that isn't obvious from the design docs or the code itself.

**Relationship to other documentation:**

- **Design docs** (`docs/design/`): The authoritative spec for what v5 does and
  why. Start there for data model, API contracts, and UI behavior.
- **This guide**: Cross-cutting conventions, patterns, and gotchas -- the glue
  between the spec and the code.
- **The code**: The implementation. Read it directly -- this guide does not
  duplicate what the code already says.
- **`docs/v5-todo.md`**: Active work item tracker for remaining tasks.
- **`/llms.txt`**: AI-oriented endpoint describing the API for programmatic
  consumers.
- **Swagger UI** (`/api/v5/openapi/swagger-ui`): Interactive API reference
  with request/response schemas.


## 1. Where Things Live

| Layer | Location | Description |
|-------|----------|-------------|
| Database | `lnt/server/db/v5/` | Schema parser, dynamic model factory, CRUD interface (3 files) |
| API | `lnt/server/api/v5/` | flask-smorest endpoints, marshmallow schemas, middleware, auth |
| Frontend | `lnt/server/ui/v5/frontend/src/` | Vanilla TypeScript SPA (Vite build) |
| Flask routes | `lnt/server/ui/v5/views.py` | SPA shell serving (suite-scoped + suite-agnostic) |
| SPA template | `lnt/server/ui/v5/templates/v5_app.html` | Standalone HTML shell for the SPA |
| Tests (API) | `tests/server/api/v5/` | lit + pytest against Postgres |
| Tests (DB) | `tests/server/db/v5/` | lit + pytest against Postgres |
| Tests (UI) | `lnt/server/ui/v5/frontend/src/__tests__/` | vitest + jsdom |
| Design docs | `docs/design/` | Authoritative spec (DB, API, UI) |


## 2. v4/v5 Coexistence

v4 and v5 coexist in the same codebase, controlled by `db_version` in
`lnt.cfg`:

- **`'0.4'`** (default): v4 Flask/Jinja2 views + Flask-RESTful API only.
  No v5 code is registered.
- **`'5.0'`**: v5-only mode. All v4 views are skipped. Only the v5 frontend
  blueprint and v5 API (flask-smorest) are registered.

Key coexistence rules:

- v4 and v5 DB layers are fully independent -- `lnt/server/db/v5/` has zero
  imports from v4 DB code.
- v5 error handlers are registered AFTER app-level handlers. They delegate
  to the previous handler for non-v5 routes (though in practice non-v5 routes
  don't exist in v5-only mode).


## 3. Database Layer Patterns

See design docs D1-D5 (data model) and D6-D14 (operations) for the full
database specification. The following are implementation patterns not covered
there:

**Dynamic model factory.** The model factory in `models.py` generates
SQLAlchemy classes dynamically using `type()`. This is how per-suite tables
with schema-defined columns are created at runtime.

**`_UNSET` sentinel.** Update methods (e.g., `update_regression()`) need to
distinguish "caller didn't pass this argument" from "caller explicitly passed
`None` to clear the field." A class-level `_UNSET = object()` sentinel is
used as the default. If the argument `is not _UNSET`, it's applied (including
`None` to clear). If it `is _UNSET`, the field is left unchanged.

**Datetime handling.** All DB datetimes are timezone-aware UTC
(`DateTime(timezone=True)`, i.e., `TIMESTAMP WITH TIME ZONE`). API responses
include a `Z` suffix via `format_utc()`. `parse_datetime()` in the API
helpers returns aware UTC (bare strings without timezone info are assumed
UTC).


## 4. API Layer Patterns

See design docs R1-R10 (infrastructure) and the endpoints spec for the full
API specification. The following are implementation patterns not covered there:

**Bootstrap token.** The token configured via `api_auth_token` in `lnt.cfg`
acts as an admin-scoped key, allowing existing deployments to use the v5 API
immediately without creating API keys first. If a Bearer token is provided
but invalid/revoked, the API aborts with 401 -- it never silently downgrades
to unauthenticated access.

**Cursor implementation.** The cursor is a base64-encoded last-seen primary
key. `cursor_paginate()` fetches `limit + 1` rows to detect whether a next
page exists. The `previous` field is always `null` (forward-only in v1);
the envelope shape is forward-compatible with adding backward pagination
later.

**Nullable PATCH fields.** For PATCH endpoints where a field can be cleared
to `null` (e.g., `bug`, `notes`, `commit` on regressions), three layers must
agree: (1) the marshmallow schema field needs `allow_none=True` so
marshmallow doesn't strip `null` values before the endpoint sees them,
(2) the endpoint uses `'key' in body` (not `body.get('key')`) to distinguish
absent from present, and (3) the DB layer uses the `_UNSET` sentinel
(section 3) to distinguish "not provided" from "set to None." Breaking any
one of these layers causes `null` values to be silently ignored.

**Machine/test delete and RegressionIndicators.** `RegressionIndicator` has
`machine_id` and `test_id` FKs with no `ondelete=CASCADE` (intentional --
regressions are triage artifacts that should not vanish when underlying
entities change). The machine and test delete handlers must manually delete
indicators referencing the entity before deleting it, or the FK constraint
will block the delete.

**Middleware.** The v5 middleware intercepts all `/api/v5/` requests and:

1. Opens a DB session (stored in `g.db_session`).
2. Calls `db.ensure_fresh()` to detect schema changes from other workers.
3. Resolves the test suite from the URL path (if applicable).
4. Adds CORS headers.
5. Logs access in Apache combined format.

Note: `ensure_fresh` is a per-request contract for **all** v5 code paths, not
just the API. The SPA shell views also call it via `_setup_testsuite()` (see
Frontend Patterns below).

**Unknown parameter rejection.** Every endpoint calls
`reject_unknown_params(allowed_set)` to return 400 on unrecognized query
parameters. This catches typos and prevents silent filter failures.


## 5. Frontend Patterns

See design docs for architecture, page specs, and UI behavior. The following
are implementation patterns not covered there:

**SPA shell.** The template `v5_app.html` is a standalone HTML page -- it
does NOT extend the v4 `layout.html`. This avoids inheriting Bootstrap 2,
jQuery, and v4 layout artifacts.

The `_setup_testsuite()` helper in `lnt/server/ui/v5/__init__.py` is the
shared entry point for all `/v5/` routes. It calls `_make_db_session()` and
then `db.ensure_fresh()` (for v5 databases) so the server-side
`data-testsuites` attribute is always current, even when another worker has
created or deleted a suite since this worker last checked.

Gotcha: `data-testsuites` uses `| tojson | forceescape` in the Jinja
template. `forceescape` is required because Flask's `tojson` returns a
`Markup` object (marked HTML-safe), making the `| e` filter a no-op. Without
`forceescape`, the JSON double-quotes break the HTML attribute.

**Internal links.** All internal navigation uses the `spaLink()` utility,
which sets a real `href` (so Cmd+Click opens in a new tab) and intercepts
plain clicks for SPA navigation (no full page reload).

**URL state.** Settings changes (filters, sort, aggregation) use
`replaceState` (not `pushState`), so the browser Back button navigates
between pages, not between individual setting changes within a page.

**Component catalog.** Reusable components shared across pages:
`data-table`, `pagination`, `machine-combobox`, `metric-selector`,
`commit-search`, `sparkline-card`, `time-series-chart`, `delete-confirm`.


## 6. Testing

**Python tests** use a lit + pytest hybrid pattern. Each test file has lit
`RUN` lines at the top that:

1. Create a temporary Postgres instance (via `with_postgres.sh`).
2. Create a temporary v5 LNT instance (via `with_temporary_instance.py`).
3. Run the Python test file with the instance path as an argument.

To run a single test:
```bash
tox -e py3 -- path/to/test.py
```

Do not use `lit` or `pytest` directly -- `tox` sets up the environment
correctly. Only one test path can be passed at a time.

Test helpers live in `tests/server/api/v5/v5_test_helpers.py` and provide:
`create_app()`, `create_client()`, `admin_headers()`, data creation
functions, and `collect_all_pages()` for cursor-paginated endpoints.

**Frontend tests** use vitest with jsdom:
```bash
cd lnt/server/ui/v5/frontend && npm test
```

**Full suite:**
```bash
tox
```

This runs all environments (Python tests, frontend tests, type checking).


## 7. Build and Packaging

**Frontend build.** `npm run build` in `lnt/server/ui/v5/frontend/` outputs
to `lnt/server/ui/v5/static/v5/` (IIFE format with source maps). Built
assets are committed to the repo.

**Python packaging.** `pyproject.toml` uses setuptools-scm for versioning.
`MANIFEST.in` includes the v5 static files, and `pyproject.toml` declares
package data for `lnt.server.ui.v5`. If the frontend build output path
changes, both `MANIFEST.in` and `pyproject.toml` package-data globs must
be updated to match, or static assets will be silently excluded from the
installed package.

**Docker.** `docker/compose.yaml` defines a Postgres backend and nginx
reverse proxy. The `lnt.dockerfile` handles DB initialization and startup.


## 8. Remaining Work

- **Migration tool** (`lnt admin migrate-to-v5`): Not started. See design
  doc D12 in `docs/design/db/operations.md` for the specification.
- **Profiles**: The API endpoint stub exists (`endpoints/profiles.py`) but
  the v5 Sample model has no `profile_id` column. Deferred by design (D13 in
  `docs/design/db/operations.md`). The endpoint will need reimplementation
  when profile support is designed for v5.
- **Open work items**: See `docs/v5-todo.md` for the active tracker.
