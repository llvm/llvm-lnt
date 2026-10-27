#!/usr/bin/env bash
#
# Check the test suite endpoints end to end against the running image.
#
# The point of doing this here rather than in pytest is WEB_CONCURRENCY=4: D2's registry keeps a
# copy of every schema *per worker*, kept honest by the `schema_version` counter, and only a real
# multi-worker deployment can show that a suite created on one worker is visible on the others.
# Everything in-process drives a single application object, where the protocol cannot fail.

source "$(dirname "$0")/lib.sh"

# Not readonly: the restart below moves the server to another port.
SUITES="${BASE_URL}/api/suites"

# Its own key: the checks are declared independent, so this cannot inherit 009's. Assigned apart
# from `readonly`, whose own exit status would otherwise hide a failing `mint_key` from `set -e`.
token="$(mint_key suites manage)"
readonly AUTH="Authorization: Bearer ${token}"
readonly JSON='Content-Type: application/json'

# Enough times that every one of the four workers has almost certainly answered.
readonly ATTEMPTS=12

echo "  creating a suite reports where to find it"
request -X POST -H "$AUTH" -H "$JSON" --data '{
  "name": "integration",
  "metrics": [{"name": "execution_time", "type": "real"}],
  "commit_fields": [{"name": "git_sha", "type": "text", "searchable": true, "display": true}],
  "machine_fields": [{"name": "hardware", "type": "text"}]
}' "$SUITES"
expect_status 201
expect_body '"name":"integration"'
expect_header Location '/api/suites/integration'

echo "  every worker sees it, and none of them 404s"
for _ in $(seq 1 "$ATTEMPTS"); do
    request "${SUITES}/integration"
    expect_status 200
    expect_body '"git_sha"'
done

echo "  it appears in the list, with its schema"
request "$SUITES"
expect_status 200
expect_body '"items":\['
expect_body '"execution_time"'

echo "  the API index points at a list that resolves"
request "${BASE_URL}/api"
expect_body '"suites":"/api/suites"'

echo "  evolving it is visible on every worker"
request -X PATCH -H "$AUTH" -H "$JSON" --data '{
  "metrics": {"add": [{"name": "code_size", "type": "integer"}]},
  "machine_fields": {"remove": ["hardware"]}
}' "${SUITES}/integration/schema?confirm=true"
expect_status 200
expect_body '"code_size"'

for _ in $(seq 1 "$ATTEMPTS"); do
    request "${SUITES}/integration"
    expect_status 200
    expect_body '"code_size"'
    # The removed field is gone everywhere, not just on the worker that removed it.
    if printf '%s' "$BODY" | grep -q '"hardware"'; then
        echo "  a worker is still reporting the removed machine field" >&2
        _show_body
        exit 1
    fi
done

echo "  changing only its repository, which changes no table, is visible on every worker"
request -X PATCH -H "$AUTH" -H "$JSON" \
    --data '{"repository": {"label": "Forge"}}' "${SUITES}/integration/schema"
expect_status 200
expect_body '"label":"Forge"'

for _ in $(seq 1 "$ATTEMPTS"); do
    request "${SUITES}/integration"
    expect_status 200
    expect_body '"label":"Forge"'
done

echo "  a removal without confirmation is refused"
request -X PATCH -H "$AUTH" -H "$JSON" \
    --data '{"metrics": {"remove": ["code_size"]}}' "${SUITES}/integration/schema"
expect_status 400
expect_body '"code":"invalid_request"'

echo "  a key restricted to the suite manages it, and no other suite"
# Minted only now, since the CLI only restricts a key to suites that exist.
restricted="$(mint_key restricted manage --suite integration)"
request -X PATCH -H "Authorization: Bearer ${restricted}" -H "$JSON" \
    --data '{"metrics": {"update": [{"name": "code_size", "display_name": "Code size"}]}}' \
    "${SUITES}/integration/schema"
expect_status 200
request -X POST -H "Authorization: Bearer ${restricted}" -H "$JSON" \
    --data '{"name":"other","metrics":[]}' "$SUITES"
expect_status 403
expect_body '"code":"forbidden"'
# A suite outside its list is a 403 before anything looks the suite up, so it need not exist.
request -X POST -H "Authorization: Bearer ${restricted}" -H "$JSON" \
    --data '{"name":"m"}' "${SUITES}/elsewhere/machines"
expect_status 403
expect_body '"code":"forbidden"'

echo "  writes need a credential of their own"
request -X POST -H "$JSON" --data '{"name":"denied","metrics":[]}' "$SUITES"
expect_status 401

echo "  the schema survives a restart, which is the only test of the lazy load"
restart_server
SUITES="${BASE_URL}/api/suites"
request "${SUITES}/integration"
expect_status 200
expect_body '"code_size"'

echo "  deleting it is visible on every worker"
request -X DELETE -H "$AUTH" "${SUITES}/integration?confirm=true"
expect_status 204

for _ in $(seq 1 "$ATTEMPTS"); do
    request "${SUITES}/integration"
    expect_status 404
    expect_body '"code":"not_found"'
done
