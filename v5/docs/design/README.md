# v5 Design Documentation

This directory contains the design documentation for the LNT v5 project. It is
the authoritative reference for what v5 does and why.

## What is v5?

LNT v5 is a ground-up redesign of the database, REST API, and web UI layers.
Key changes from v4:

- **Database**: PostgreSQL-only, schema-in-DB, the `Commit` concept replaces
  `Order` (separating identity, ordering, and display), no `FieldChange` table
  (regressions use direct indicators).
- **API**: A full REST API with OpenAPI 3.x, cursor-based pagination, bearer
  token auth with scope hierarchy, all JSON responses.
- **UI**: Single-page application with client-side routing, all data from the
  v5 REST API.

v4 and v5 coexist in the same codebase for a transitional period. However, they
are fully disjoint, have different DB schemas and concepts, etc.

## Design Principles

- PostgreSQL only: No SQLite or MySQL support.
- No backward compatibility with v4 formats or APIs.
- No automatic regression detection: external tools create regressions via the API.

## Physical organization

The physical organization of this repository is as follows:

```
lnt/            # legacy v4 Python app
tests/          # legacy v4 tests
schemas/        # legacy v4 test-suite YAML schemas
v5/
    docs/       # NEW: v5 documentation
    client/     # NEW: v5 SPA (client-side code)
    server/     # NEW: v5 server-side code
    Dockerfile  # NEW: v5 Dockerfile
    deployment/ # NEW: Terraform infra to deploy the v5 instance
.github/
    workflows/
        v5-deploy.yml   # NEW: v5 deployment workflow
        v5-test.yml     # NEW: v5 testing workflow
        tox.yml         # existing v4 workflows
        etc..
```

## Document Map

### Server Side

| Document | Contents |
|----------|----------|
| [Data Model](server/data-model.md) | Architecture, Commit concept, schema storage and format, all table definitions, database initialization |
| [Operations](server/operations.md) | Run submission, machine and commit metadata, search, time-series queries, ordinal management |
| [Infrastructure](server/infrastructure.md) | URL structure, pagination, filtering, response format, authentication, AI orientation, health check, API documentation |
| [Endpoints](server/endpoints.md) | All entity endpoint specifications: discovery, machines, commits, runs, tests, samples, profiles, regressions, time series, test suites, admin |

### Web UI

| Document | Contents |
|----------|----------|
| [Architecture](client/architecture.md) | SPA design, client-side routing, navigation bar |
| [Dashboard](client/dashboard.md) | Landing page with sparkline trend overview across test suites |
| [Test Suites](client/test-suites.md) | Test Suites page (suite picker + tabs): Recent Activity, Machines, Runs, Commits, Regressions |
| [Detail Pages](client/details.md) | Machine Detail, Run Detail, Commit Detail, and Regression Detail entity pages |
| [Graph](client/graph.md) | Time-series visualization: multi-machine, lazy loading, test selection, baselines, regression annotations |
| [Compare](client/compare.md) | Side-by-side comparison of two commits: selection panel, ratio chart, geomean summary, bidirectional sync |
| [Profiles](client/profiles.md) | A/B profile viewer: cascading pickers, counter stats bar, function selector, disassembly view |
| [Admin](client/admin.md) | API key management, test suite management |
