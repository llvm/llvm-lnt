#!/usr/bin/env bash
#
# One run, submitted and then read back.
#
# The server's own tests cover all of this in depth against the same PostgreSQL; what this adds is
# that the built image can do it, and that it can do it across the four workers `run.sh` starts.
# Until now the integration checks only ever created suites, so nothing proved that a deployed
# instance can accept data at all -- and a submission touches far more of the stack than a schema
# does: the per-suite tables, the implicit creation of a machine, a commit and a test (D7), and the
# two aggregation endpoints.
#
# Profiles are deliberately left out: producing a valid version 2 blob is not something to do in
# bash, and the format has a test suite of its own.

source "$(dirname "$0")/lib.sh"

readonly SUITES="${BASE_URL}/api/suites"
readonly SUITE="${SUITES}/lifecycle"

# One key per scope, so that each request is made with exactly what R5 says it needs.
readonly MANAGE="Authorization: Bearer $(mint_key lifecycle-manage manage)"
readonly SUBMIT="Authorization: Bearer $(mint_key lifecycle-submit submit)"

# Client-provided, so the checks below can address the run without parsing a response.
readonly RUN='11111111-1111-4111-8111-111111111111'

# Enough times that every one of the four workers has almost certainly answered.
readonly ATTEMPTS=12

cleanup() { request -X DELETE -H "$MANAGE" "${SUITE}?confirm=true"; }
trap cleanup EXIT

echo "  a suite to submit into"
request -X POST -H "$MANAGE" -H "$JSON" --data @- "$SUITES" <<'JSON'
{
  "name": "lifecycle",
  "metrics": [{"name": "execution_time", "type": "real"}],
  "commit_fields": [{"name": "git_sha", "type": "text", "searchable": true}],
  "machine_fields": [{"name": "hardware", "type": "text", "searchable": true}]
}
JSON
expect_status 201

echo "  a submission creates its machine, commit and test as it goes"
request -X POST -H "$SUBMIT" -H "$JSON" --data @- "${SUITE}/runs" <<JSON
{
  "format_version": "5",
  "uuid": "${RUN}",
  "machine": {"name": "bot-1", "fields": {"hardware": "x86_64"}},
  "commit": {"value": "c0ffee", "ordinal": 1, "fields": {"git_sha": "c0ffee00"}},
  "tests": [{"name": "suite/bench", "execution_time": [1.0, 1.5]}]
}
JSON
expect_status 201
expect_body "\"uuid\":\"${RUN}\""
expect_header Location "/api/suites/lifecycle/runs/${RUN}"

echo "  and a second one, on the next commit"
request -X POST -H "$SUBMIT" -H "$JSON" --data @- "${SUITE}/runs" <<'JSON'
{
  "format_version": "5",
  "machine": {"name": "bot-1"},
  "commit": {"value": "deadbeef", "ordinal": 2},
  "tests": [{"name": "suite/bench", "execution_time": 3.0}]
}
JSON
expect_status 201

echo "  re-submitting different metadata for the machine is refused (D7)"
request -X POST -H "$SUBMIT" -H "$JSON" --data @- "${SUITE}/runs" <<'JSON'
{
  "format_version": "5",
  "machine": {"name": "bot-1", "fields": {"hardware": "aarch64"}},
  "commit": {"value": "deadbeef"},
  "tests": []
}
JSON
expect_status 409
expect_body '"code":"conflict"'

echo "  every worker sees what was written, and reads need no credential (R5)"
for _ in $(seq 1 "$ATTEMPTS"); do
    request "${SUITE}/machines"
    expect_status 200
    expect_body '"name":"bot-1"'
    expect_body '"total":1'

    request "${SUITE}/runs/${RUN}"
    expect_status 200
    expect_body '"machine":"bot-1"'
    expect_body '"commit":"c0ffee"'
done

echo "  the run's samples are one per repetition (D6)"
request "${SUITE}/runs/${RUN}/samples?test=suite/bench"
expect_status 200
expect_body '"execution_time":1.0'
expect_body '"execution_time":1.5'

echo "  the time series carries every sample, placed by ordinal"
request -X POST -H "$JSON" \
    --data '{"metric": "execution_time", "sort": "commit"}' "${SUITE}/query"
expect_status 200
expect_body '"ordinal":1'
expect_body '"ordinal":2'
expect_body '"cursor":\{"next":null'

echo "  and the trends endpoint aggregates it per machine and commit"
request -X POST -H "$JSON" --data '{"metric": "execution_time"}' "${SUITE}/trends"
expect_status 200
expect_body '"machine":"bot-1"'
# One geomean per (machine, commit), both placed by ordinal. Not asserting the values: they are
# `exp(avg(ln ...))` computed in SQL, and pinning their last digits here would test nothing.
expect_body '"ordinal":1.*"ordinal":2'
