"""llms.txt endpoint: GET /llms.txt

Serves a plain-text orientation document for AI agents, following the
llms.txt convention (analogous to robots.txt). Describes what LNT is,
its domain concepts, API structure, and common workflows.

Registered as a plain Flask blueprint (not flask-smorest) so it does not
appear in the OpenAPI spec.
"""

from flask import Blueprint, make_response
import hashlib

llms_txt_bp = Blueprint('llms_txt', __name__)

LLMS_TEXT = """\
# LNT — LLVM Nightly Test Infrastructure

LNT is a performance testing infrastructure designed for tracking software
performance over time. It collects benchmark results from test runs, detects
regressions, and provides tools for performance analysis. Originally built
for the LLVM compiler project, it can be used for any software project.

## Key Concepts

- **Test Suite**: A schema defining what metrics to collect (e.g., "nts" for
  the LLVM nightly test suite). Each suite has its own set of machines, orders,
  runs, and tests. All data queries are scoped to a specific test suite.

- **Machine**: A build/test environment identified by name (e.g.,
  "clang-x86_64-linux"). Machines have key-value info fields describing
  their configuration.

- **Order**: A point in the revision history (e.g., a commit hash or revision
  number). Orders define the sequence for time-series analysis. They may have
  multiple fields (e.g., primary revision + dependent project revisions).

- **Run**: A single test execution on a machine at a specific order. Contains
  samples (individual test results) with metric values. Identified by UUID.

- **Test**: A named benchmark or test case (e.g., "SingleSource/Benchmarks/
  Dhrystone/dry"). Tests are created implicitly when runs are submitted.

- **Sample**: A single data point: one test's metric values from one run.
  Each sample records values for the metrics defined by the test suite schema
  (e.g., execution_time, compile_time, code_size).

- **Regression**: A detected performance change, grouping one or more field
  changes. Has a state (detected, active, fixed, ignored, etc.), optional
  title, and optional bug tracker link.

- **Field Change**: A statistically significant change in a metric value
  between two orders for a specific test on a specific machine.

## REST API (v5)

Base URL: /api/v5/
Authentication: Bearer token in Authorization header. Reads are unauthenticated
by default. Write operations require tokens with appropriate scopes
(submit, triage, manage, admin).

### Discovery

  GET /api/v5/                  List test suites and API links

### Per-Suite Endpoints (replace {ts} with suite name, e.g., "nts")

  GET    /api/v5/{ts}/machines              List machines
  GET    /api/v5/{ts}/machines/{name}       Machine detail
  GET    /api/v5/{ts}/orders                List orders
  GET    /api/v5/{ts}/orders/{value}        Order detail (with prev/next)
  GET    /api/v5/{ts}/runs                  List runs
  POST   /api/v5/{ts}/runs                  Submit a run
  GET    /api/v5/{ts}/runs/{uuid}           Run detail
  GET    /api/v5/{ts}/tests                 List tests
  POST   /api/v5/{ts}/query                 Query time-series data
  GET    /api/v5/{ts}/regressions           List regressions
  GET    /api/v5/{ts}/field-changes         List unassigned field changes

### Global Endpoints

  GET    /api/v5/test-suites               List all test suites
  GET    /api/v5/test-suites/{name}        Suite detail (schema + metrics)
  GET    /api/v5/admin/api-keys            List API keys (admin)

The endpoints above cover the most common read operations. The API also
supports write operations (creating/updating/deleting machines, orders,
runs, regressions, field changes, test suites, and API keys) which require
appropriate authentication scopes. See the OpenAPI spec or Swagger UI for
the complete endpoint list including all write operations.

### Interactive Documentation

  OpenAPI spec:  /api/v5/openapi/openapi.json
  Swagger UI:    /api/v5/openapi/swagger-ui

### Pagination

List endpoints return cursor-paginated responses:
  { "items": [...], "cursor": { "next": "...", "previous": null } }
Pass cursor=<next> to get the next page. Use limit= to control page size.

### Common Workflows

1. Discover available data: GET /api/v5/ to list test suites, then
   GET /api/v5/{ts}/machines to see what machines exist.

2. Query performance history: POST /api/v5/{ts}/query with
   { "metric": "execution_time", "machine": "machine-name",
     "test": ["test/name"] } to get time-series data points.

3. Submit a run: POST /api/v5/{ts}/runs with the LNT JSON report format.
   Requires a token with "submit" scope.

4. Check for regressions: GET /api/v5/{ts}/regressions?state=detected
   to find new regressions. PATCH to update state, title, or bug link.

5. Inspect a specific order: GET /api/v5/{ts}/orders/{value} returns
   the order detail with previous/next navigation links.
"""

_ETAG = hashlib.md5(LLMS_TEXT.encode()).hexdigest()


@llms_txt_bp.route('/llms.txt')
def llms_txt():
    """Serve the LNT orientation document for AI agents."""
    resp = make_response(LLMS_TEXT)
    resp.mimetype = 'text/plain'
    resp.charset = 'utf-8'
    resp.headers['Cache-Control'] = 'public, max-age=86400'
    resp.headers['ETag'] = _ETAG
    return resp
