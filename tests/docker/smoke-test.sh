#!/usr/bin/env bash
# End-to-end smoke test for the Docker-based LNT deployment.
#
# Builds the Docker Compose stack from the currently checked-out source,
# creates a test suite via the API, exercises all key v5 endpoints, and
# tears down with volume removal on exit.
#
# Uses a separate compose project name and host port to avoid interfering
# with any local development stack.
#
# Usage:
#   ./tests/docker/smoke-test.sh
#
# Requirements: docker, docker compose, curl, jq

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker/compose.yaml"
PROJECT_NAME="lnt-smoke-test-$$"
HOST_PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()")
BASE_URL="http://localhost:${HOST_PORT}"
AUTH_TOKEN="smoke-test-token"
SUITE="smoketest"

# Export secrets and port override for docker compose.
export LNT_DB_PASSWORD="smoke-test-password"
export LNT_AUTH_TOKEN="${AUTH_TOKEN}"
export LNT_HOST_PORT="${HOST_PORT}"

# Common compose flags: use isolated project name.
COMPOSE_CMD=(docker compose -f "$COMPOSE_FILE" -p "$PROJECT_NAME")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
pass_count=0
fail_count=0

pass() { echo "  PASS  $1"; pass_count=$((pass_count + 1)); }
fail() { echo "  FAIL  $1 -- $2"; fail_count=$((fail_count + 1)); }

# check_endpoint LABEL URL EXPECTED_STATUS [METHOD [BODY [JQ_EXPR]]]
#
# Single curl call that checks the HTTP status code and optionally validates
# a jq expression on the response body.
check_endpoint() {
    local label="$1" url="$2" expected="$3" method="${4:-GET}" body="${5:-}" jq_expr="${6:-}"
    local args=(-s -w '\n%{http_code}' -L -X "$method")
    if [ -n "$body" ]; then
        args+=(-H 'Content-Type: application/json' -d "$body")
    fi
    args+=(-H "Authorization: Bearer ${AUTH_TOKEN}")

    local output status json_body
    output=$(curl "${args[@]}" "$url")
    status="${output##*$'\n'}"
    json_body="${output%$'\n'*}"

    if [ "$status" = "$expected" ]; then
        pass "$label (HTTP $status)"
    else
        fail "$label" "expected $expected, got $status"
        return
    fi

    if [ -n "$jq_expr" ]; then
        local result
        result=$(echo "$json_body" | jq -r "$jq_expr" 2>/dev/null)
        if [ -n "$result" ] && [ "$result" != "null" ]; then
            pass "$label: $jq_expr = $result"
        else
            fail "$label: $jq_expr" "returned empty/null"
        fi
    fi
}

cleanup() {
    echo ""
    echo "Tearing down smoke-test Docker stack..."
    "${COMPOSE_CMD[@]}" down -v --remove-orphans 2>/dev/null || true
    docker rmi "${PROJECT_NAME}-webserver" 2>/dev/null || true
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Start
# ---------------------------------------------------------------------------
echo "=== LNT Docker Smoke Test ==="
echo "    project: ${PROJECT_NAME}"
echo "    port:    ${HOST_PORT}"
echo ""

echo "Building and starting Docker Compose stack..."
"${COMPOSE_CMD[@]}" up --build --detach

# Wait for the container's webserver to be listening, using the API discovery
# endpoint (simpler than the SPA route which depends on templates).
echo "Waiting for server to be ready..."
timeout 120 bash -c "
    until curl -sf http://localhost:${HOST_PORT}/api/v5/ > /dev/null 2>&1; do
        sleep 2
    done
" || {
    echo "Server did not become ready in 120s. Logs:"
    "${COMPOSE_CMD[@]}" logs
    exit 1
}
echo "Server is ready."
echo ""

# ---------------------------------------------------------------------------
# Test: SPA shell
# ---------------------------------------------------------------------------
echo "--- SPA Shell ---"
check_endpoint "GET /v5/" "${BASE_URL}/v5/" 200

# ---------------------------------------------------------------------------
# Test: Discovery
# ---------------------------------------------------------------------------
echo "--- Discovery ---"
check_endpoint "GET /api/v5/" "${BASE_URL}/api/v5/" 200 GET "" ".test_suites | type"

# ---------------------------------------------------------------------------
# Test: Create test suite
# ---------------------------------------------------------------------------
echo "--- Test Suite CRUD ---"
SUITE_BODY=$(cat <<'ENDJSON'
{
    "name": "smoketest",
    "metrics": [
        {"name": "execution_time", "type": "real", "unit": "seconds"},
        {"name": "compile_time", "type": "real", "unit": "seconds"}
    ],
    "commit_fields": [
        {"name": "git_sha", "searchable": true}
    ],
    "machine_fields": [
        {"name": "os", "searchable": true}
    ]
}
ENDJSON
)
check_endpoint "POST /api/v5/test-suites (create)" \
    "${BASE_URL}/api/v5/test-suites" 201 POST "$SUITE_BODY"

check_endpoint "GET /api/v5/test-suites/${SUITE}" \
    "${BASE_URL}/api/v5/test-suites/${SUITE}" 200 GET "" ".schema.name"

# Verify the SPA shell reflects the newly created suite.  With 8 gunicorn
# workers, the request may land on a worker that did not handle the POST;
# ensure_fresh must propagate the new suite to that worker's cache.
spa_html=$(curl -s -H "Authorization: Bearer ${AUTH_TOKEN}" "${BASE_URL}/v5/test-suites")
if echo "$spa_html" | grep -q "${SUITE}"; then
    pass "SPA shell lists new suite '${SUITE}'"
else
    fail "SPA shell lists new suite '${SUITE}'" "suite name not found in /v5/test-suites HTML"
fi

# ---------------------------------------------------------------------------
# Test: Submit a run
# ---------------------------------------------------------------------------
echo "--- Run Submission ---"
RUN_BODY=$(cat <<'ENDJSON'
{
    "format_version": "5",
    "machine": {"name": "smoke-machine", "os": "linux"},
    "commit": "abc123",
    "commit_fields": {"git_sha": "abc123def456"},
    "tests": [
        {"name": "test.suite/bench1", "execution_time": 1.5, "compile_time": 0.3},
        {"name": "test.suite/bench2", "execution_time": 2.0, "compile_time": 0.5}
    ]
}
ENDJSON
)
check_endpoint "POST /api/v5/${SUITE}/runs (submit)" \
    "${BASE_URL}/api/v5/${SUITE}/runs" 201 POST "$RUN_BODY"

# ---------------------------------------------------------------------------
# Test: Concurrent submission (same machine, commit, and test names)
# ---------------------------------------------------------------------------
echo "--- Concurrent Submission ---"

CONCURRENT=20
tmpdir=$(mktemp -d)
pids=()
for i in $(seq 1 $CONCURRENT); do
    curl -s -o /dev/null -w '%{http_code}' -X POST \
        -H "Authorization: Bearer ${AUTH_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "{
            \"format_version\": \"5\",
            \"machine\": {\"name\": \"concurrent-machine\", \"os\": \"linux\"},
            \"commit\": \"concurrent-rev\",
            \"commit_fields\": {\"git_sha\": \"concurrent-sha\"},
            \"tests\": [
                {\"name\": \"test.suite/concurrent-bench\", \"execution_time\": ${i}.0}
            ]
        }" \
        "${BASE_URL}/api/v5/${SUITE}/runs" \
        > "${tmpdir}/status-${i}" 2>/dev/null &
    pids+=($!)
done

concurrent_failures=0
for i in $(seq 1 $CONCURRENT); do
    wait "${pids[$((i-1))]}" || true
    status=$(cat "${tmpdir}/status-${i}" 2>/dev/null || echo "000")
    if [ "$status" != "201" ]; then
        concurrent_failures=$((concurrent_failures + 1))
    fi
done
rm -rf "$tmpdir"

if [ "$concurrent_failures" -eq 0 ]; then
    pass "All $CONCURRENT concurrent submissions returned 201"
else
    fail "Concurrent submission" "$concurrent_failures of $CONCURRENT requests failed"
fi

# Verify exactly 1 machine, 1 commit, and N runs were created.
check_endpoint "Exactly 1 concurrent machine" \
    "${BASE_URL}/api/v5/${SUITE}/machines?search=concurrent-machine" 200 \
    GET "" '.items | length | if . == 1 then "1" else null end'

check_endpoint "Exactly 1 concurrent commit" \
    "${BASE_URL}/api/v5/${SUITE}/commits?search=concurrent" 200 \
    GET "" '.items | length | if . == 1 then "1" else null end'

check_endpoint "All $CONCURRENT concurrent runs exist" \
    "${BASE_URL}/api/v5/${SUITE}/runs?machine=concurrent-machine&limit=100" 200 \
    GET "" ".items | length | if . == $CONCURRENT then \"$CONCURRENT\" else null end"

check_endpoint "Exactly 1 concurrent test" \
    "${BASE_URL}/api/v5/${SUITE}/tests?name_contains=concurrent-bench" 200 \
    GET "" '.items | length | if . == 1 then "1" else null end'

# ---------------------------------------------------------------------------
# Test: Read endpoints
# ---------------------------------------------------------------------------
echo "--- Read Endpoints ---"
check_endpoint "GET /api/v5/${SUITE}/runs" \
    "${BASE_URL}/api/v5/${SUITE}/runs" 200 GET "" ".items | length"

check_endpoint "GET /api/v5/${SUITE}/machines" \
    "${BASE_URL}/api/v5/${SUITE}/machines" 200 GET "" ".items | length"

check_endpoint "GET /api/v5/${SUITE}/commits" \
    "${BASE_URL}/api/v5/${SUITE}/commits" 200 GET "" ".items | length"

check_endpoint "GET /api/v5/${SUITE}/tests" \
    "${BASE_URL}/api/v5/${SUITE}/tests" 200 GET "" ".items | length"

# ---------------------------------------------------------------------------
# Test: Time-series query
# ---------------------------------------------------------------------------
echo "--- Time-Series Query ---"
QUERY_BODY=$(cat <<'ENDJSON'
{
    "metric": "execution_time",
    "machine": "smoke-machine"
}
ENDJSON
)
check_endpoint "POST /api/v5/${SUITE}/query" \
    "${BASE_URL}/api/v5/${SUITE}/query" 200 POST "$QUERY_BODY" ".items | length"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Results: ${pass_count} passed, ${fail_count} failed ==="
if [ "$fail_count" -gt 0 ]; then
    echo ""
    echo "Docker logs:"
    "${COMPOSE_CMD[@]}" logs --tail=50
    exit 1
fi
