# v5 Design Documentation

This directory contains the design documentation for the LNT v5 project. It is
the authoritative reference for what v5 does and why.

## What is v5?

LNT v5 is a ground-up redesign of the database, REST API, and web UI layers.
Key changes from v4:

- **Database**: PostgreSQL-only, schema-in-DB, the "Commit" concept replaces
  "Order" (cleanly separating identity, ordering, and display), no FieldChange
  table (regressions use direct indicators).
- **API**: flask-smorest with OpenAPI 3.x, cursor-based pagination, bearer
  token auth with scope hierarchy, all JSON responses.
- **UI**: Single-page application in vanilla TypeScript + Vite, client-side
  routing, all data from the v5 REST API.

v4 and v5 coexist in the same codebase, selected by `db_version` in `lnt.cfg`
(`'0.4'` for v4, `'5.0'` for v5). They are fully disjoint: a v4 instance
serves only v4 views, and a v5 instance serves only v5 API endpoints and the
v5 frontend.

## Design Principles

- **PostgreSQL only**. No SQLite or MySQL support.
- **SQLAlchemy 1.3** (same version as v4, to avoid upgrade risk).
- **Python 3.10+** idioms: type hints (`X | Y`, `list[T]`), dataclasses,
  f-strings, `match` where appropriate.
- **No backward compatibility** with v4 formats or APIs. Clean break.
- **No auto-detection** of regressions. External tools create regressions via
  the API.

## Document Map

### Database Layer — [`db/`](db/)

| Document | Contents |
|----------|----------|
| [Data Model](db/data-model.md) | Architecture, Commit concept, schema storage and format, all table definitions |
| [Operations](db/operations.md) | Run submission, commit metadata, search, time-series queries, ordinal management, v4 migration, deferred features |

### REST API — [`api/`](api/)

| Document | Contents |
|----------|----------|
| [Infrastructure](api/infrastructure.md) | Framework (flask-smorest), URL structure, pagination, filtering, response format, authentication, testing, deferred features, AI orientation |
| [Endpoints](api/endpoints.md) | All entity endpoint specifications: machines, commits, runs, tests, samples, profiles, regressions, time series, schema, admin |

### Web UI — [`ui/`](ui/)

| Document | Contents |
|----------|----------|
| [Architecture](ui/architecture.md) | SPA design, client-side routing, Flask backend routes, navigation bar, frontend code structure, build config, implementation phases |
| [Dashboard](ui/dashboard.md) | Landing page with sparkline trend overview across test suites |
| [Browsing Pages](ui/browsing.md) | Test Suites page (suite picker + tabs), Machine Detail, Run Detail, Commit Detail, Regression Detail, and inline regression list/triage |
| [Graph](ui/graph.md) | Time-series visualization: multi-machine, lazy loading, test selection, baselines, regression annotations |
| [Compare](ui/compare.md) | Side-by-side comparison of two commits/runs: selection panel, ratio chart, geomean summary, bidirectional sync |
| [Admin](ui/admin.md) | API key management, test suite schema management |

### Historical Discussion

| Document | Contents |
|----------|----------|
| [Discussion: Orders](v5-discussion-about-orders.md) | Exploration of approaches that led to the Commit concept (design rationale) |


## v4 Features NOT Carried Forward

These v4 pages are intentionally omitted from the v5 UI:

| v4 Feature | Rationale |
|------------|-----------|
| Daily Report | Subsumed by Dashboard + Graph. The dashboard shows sparkline trends; the graph page shows detailed time-series. |
| Latest Runs Report | Subsumed by Dashboard (sparkline trend overview) and Test Suites page (Recent Activity tab). |
| Summary Report | Low usage, "WIP" in v4. Can be added later if needed. |
| Matrix View | Niche use case. The Graph page with per-test drill-down covers the same need. |
| Global Status | Subsumed by Dashboard (sparkline trend overview with per-machine traces). |
| Profile Admin | Operational concern, not a core user workflow. Keep in v4. |
| Submit Run page | Runs are submitted via CLI (`lnt submit`) or API. A form-based UI is rarely used. |
| Rules page | Read-only diagnostic page. Keep in v4 for ops. |
