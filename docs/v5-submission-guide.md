# Submitting Data to a v5 LNT Instance

## Quick Start

A v5 LNT instance uses the v5 REST API exclusively. The submission format
is **different from v4** — you cannot use `format_version: "2"` payloads.

**Base URL**: `http://<host>/api/v5`

**Authentication**: `Authorization: Bearer <token>` header on all write
requests. The token configured via `--api-auth-token` during `lnt create`
acts as an admin-scoped bootstrap token.

## Step 1: Create a Test Suite

Before submitting runs, the test suite must exist.

```
POST /api/v5/test-suites/
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "name": "nts",
  "metrics": [
    {"name": "execution_time", "type": "real", "bigger_is_better": false,
     "display_name": "Execution Time", "unit": "seconds", "unit_abbrev": "s"},
    {"name": "compile_time", "type": "real", "bigger_is_better": false},
    {"name": "compile_status", "type": "status"},
    {"name": "execution_status", "type": "status"},
    {"name": "score", "type": "real", "bigger_is_better": true},
    {"name": "hash", "type": "hash"}
  ],
  "commit_fields": [
    {"name": "llvm_project_revision", "searchable": true, "display": true}
  ],
  "machine_fields": [
    {"name": "hardware", "searchable": true},
    {"name": "os", "searchable": true}
  ]
}
```

Returns 201 on success, 409 if it already exists. Requires `manage` scope.

**Metric types**: `real` (float), `status` (integer), `hash` (string).

**commit_fields**: Optional typed metadata columns on the Commit table.
`display: true` means the UI shows this field's value instead of the raw
commit string. `searchable: true` enables `?search=` prefix matching.

**machine_fields**: Optional typed columns on the Machine table.

**Note**: There is no `run_fields` section in v5. The v4 concept of
`run_fields` with `order: true` is replaced by the built-in `commit`
concept. Extra run metadata goes in `run_parameters` (JSONB).

## Step 2: Submit Runs

```
POST /api/v5/<suite>/runs?on_machine_conflict=update
Authorization: Bearer <token>
Content-Type: application/json
```

### v5 Submission Format

```json
{
  "format_version": "5",
  "machine": {
    "name": "my-machine",
    "hardware": "x86_64",
    "os": "linux"
  },
  "commit": "abc123def456",
  "commit_fields": {
    "llvm_project_revision": "abc123def456"
  },
  "run_parameters": {
    "build_config": "Release",
    "start_time": "2024-01-15T10:30:00"
  },
  "tests": [
    {
      "name": "nts.suite/benchmark",
      "execution_time": 1.23,
      "compile_time": 0.45
    }
  ]
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `format_version` | string | Must be `"5"` (not `"2"`) |
| `machine` | object | Must have `name`. Other keys matching `machine_fields` go to columns; unknown keys go to `parameters` JSONB |
| `commit` | string | Groups runs. Can be a git SHA, version number, or ad-hoc label |
| `tests` | array | Each entry has `name` plus metric values matching the schema. Metric values may be scalars or arrays — arrays create multiple samples per test (e.g. `"execution_time": [0.1, 0.2]`) |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `commit_fields` | object | Metadata for the commit. First-write-wins (use PATCH to update later) |
| `run_parameters` | object | Stored as JSONB on the Run. Put `start_time`, `end_time`, `build_config`, etc. here |

### Query Parameters

| Param | Values | Default | Description |
|-------|--------|---------|-------------|
| `on_machine_conflict` | `match`, `update` | `match` | `match` rejects if machine fields differ; `update` overwrites |

### Response (201)

```json
{
  "success": true,
  "run_uuid": "a1b2c3d4-...",
  "result_url": "/api/v5/nts/runs/a1b2c3d4-..."
}
```

## Converting v4 Data to v5 Format

When scraping from a v4 server (e.g. lnt.llvm.org), the scraped data uses
the v4 format. Here's how to convert:

| v4 Field | v5 Field |
|----------|----------|
| `format_version: "2"` | `format_version: "5"` |
| `run.llvm_project_revision` (or primary order field) | `commit` (top-level string) |
| `run.llvm_project_revision` | `commit_fields.llvm_project_revision` |
| `run.start_time`, `run.end_time` | `run_parameters.start_time`, `run_parameters.end_time` |
| Other `run.*` fields | `run_parameters.*` or `commit_fields.*` |
| `machine.name` | `machine.name` (unchanged) |
| Machine info fields | `machine.*` (unchanged — schema fields go to columns, rest to parameters) |
| `tests[].name` | `tests[].name` (unchanged) |
| `tests[].<metric>` | `tests[].<metric>` (unchanged) |

**Key difference**: In v4, the order/revision was inside `run`. In v5,
it's `commit` at the top level. The `run` section is gone entirely —
use `run_parameters` for any extra run metadata.

## Step 3: Assign Ordinals (Optional)

Commits are created without ordinals (they have no position in the
time series). To enable time-series graphing, assign ordinals:

```
PATCH /api/v5/<suite>/commits/<commit_value>
Authorization: Bearer <token>
Content-Type: application/json

{"ordinal": 12345}
```

Ordinals must be unique integers. They define the x-axis order on graphs.
Commits without ordinals are excluded from time-series queries sorted by
commit.

## Step 4: Verify

```bash
# List machines
curl http://localhost:8000/api/v5/<suite>/machines

# List runs (newest first)
curl "http://localhost:8000/api/v5/<suite>/runs?sort=-submitted_at&limit=10"

# Get run detail
curl http://localhost:8000/api/v5/<suite>/runs/<uuid>

# Get samples for a run
curl http://localhost:8000/api/v5/<suite>/runs/<uuid>/samples

# List commits
curl http://localhost:8000/api/v5/<suite>/commits
```

All GET endpoints allow unauthenticated access by default.

## Important Notes

- **format_version must be "5"** — the v5 API rejects `"2"`.
- **No `on_existing_run` param** — v5 always creates a new run. Multiple
  runs per machine+commit are allowed.
- **Null metrics** — omit metrics with null values from the tests array.
  Only include metrics that have actual values.
- **commit_fields are first-write-wins** — if the commit already exists,
  `commit_fields` in the submission are ignored. Use
  `PATCH /api/v5/<suite>/commits/<value>` to update.
- **No regression auto-detection** — v5 does not auto-detect regressions.
  Use `POST /api/v5/<suite>/field-changes` to create them externally.
- **Postgres required** — v5 instances only work with PostgreSQL.
