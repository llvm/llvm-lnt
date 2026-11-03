#!/usr/bin/env bash
#
# Check the project and test suite endpoints end to end against the running image.
#
# The point of doing this here rather than in pytest is WEB_CONCURRENCY=4: D2's registry keeps a
# copy of every project and schema *per worker*, kept honest by the `schema_version` counter, and only
# a real multi-worker deployment can show that a suite created on one worker is visible on the
# others.
# Everything in-process drives a single application object, where the protocol cannot fail.

source "$(dirname "$0")/lib.sh"

# Not readonly: the restart below moves the server to another port.
PROJECTS="${BASE_URL}/api/projects"
SUITES="${PROJECTS}/crud/suites"

# Its own key: the checks are declared independent, so this cannot inherit 009's. Assigned apart
# from `readonly`, whose own exit status would otherwise hide a failing `mint_key` from `set -e`.
token="$(mint_key suites manage)"
readonly AUTH="Authorization: Bearer ${token}"
readonly JSON='Content-Type: application/json'

# Enough times that every one of the four workers has almost certainly answered.
readonly ATTEMPTS=12

echo "  creating a project reports where to find it, and every worker sees it"
request -X POST -H "$AUTH" -H "$JSON" --data '{"name": "crud", "display_name": "CRUD"}' "$PROJECTS"
expect_status 201
expect_header Location '/api/projects/crud'
for _ in $(seq 1 "$ATTEMPTS"); do
    request "${PROJECTS}/crud"
    expect_status 200
    expect_body '"display_name":"CRUD"'
done

echo "  a project name is taken once"
request -X POST -H "$AUTH" -H "$JSON" --data '{"name": "crud"}' "$PROJECTS"
expect_status 409
expect_body '"code":"duplicate"'

echo "  creating a suite reports where to find it"
request -X POST -H "$AUTH" -H "$JSON" --data '{
  "name": "suite-crud",
  "metrics": [{"name": "execution_time", "type": "real"}],
  "commit_fields": [{"name": "git_sha", "type": "text", "searchable": true, "display": true}],
  "machine_fields": [{"name": "hardware", "type": "text"}]
}' "$SUITES"
expect_status 201
expect_body '"name":"suite-crud"'
expect_header Location '/api/projects/crud/suites/suite-crud'

echo "  every worker sees it, and none of them 404s"
for _ in $(seq 1 "$ATTEMPTS"); do
    request "${SUITES}/suite-crud"
    expect_status 200
    expect_body '"git_sha"'
done

echo "  it appears in the lists, with its schema"
request "$SUITES"
expect_status 200
expect_body '"items":\['
expect_body '"execution_time"'
request "$PROJECTS"
expect_status 200
expect_body '"name":"suite-crud"'

echo "  the API index points at a list that resolves"
request "${BASE_URL}/api"
expect_body '"projects":"/api/projects"'

echo "  a suite name is taken once per project, and another project can take it too"
request -X POST -H "$AUTH" -H "$JSON" --data '{"name": "suite-crud", "metrics": []}' "$SUITES"
expect_status 409
expect_body '"code":"duplicate"'
create_project crud-other "$AUTH"
request -X POST -H "$AUTH" -H "$JSON" --data '{"name": "suite-crud", "metrics": []}' \
    "${PROJECTS}/crud-other/suites"
expect_status 201
request "${PROJECTS}/crud-other/suites/suite-crud"
expect_status 200
if printf '%s' "$BODY" | grep -q '"execution_time"'; then
    echo "  the other project's suite has the first one's schema" >&2
    _show_body
    exit 1
fi

echo "  a project that still has suites cannot be deleted"
request -X DELETE -H "$AUTH" "${PROJECTS}/crud-other"
expect_status 409
expect_body '"code":"conflict"'
request -X DELETE -H "$AUTH" "${PROJECTS}/crud-other/suites/suite-crud?confirm=true"
expect_status 204
request -X DELETE -H "$AUTH" "${PROJECTS}/crud-other"
expect_status 204
for _ in $(seq 1 "$ATTEMPTS"); do
    request "${PROJECTS}/crud-other"
    expect_status 404
done

echo "  changing a project's display name is visible on every worker"
request -X PATCH -H "$AUTH" -H "$JSON" --data '{"display_name": "Projects CRUD"}' \
    "${PROJECTS}/crud"
expect_status 200
for _ in $(seq 1 "$ATTEMPTS"); do
    request "${PROJECTS}/crud"
    expect_status 200
    expect_body '"display_name":"Projects CRUD"'
done
echo "  evolving it is visible on every worker"
request -X PATCH -H "$AUTH" -H "$JSON" --data '{
  "metrics": {"add": [{"name": "code_size", "type": "integer"}]},
  "machine_fields": {"remove": ["hardware"]}
}' "${SUITES}/suite-crud/schema?confirm=true"
expect_status 200
expect_body '"code_size"'

for _ in $(seq 1 "$ATTEMPTS"); do
    request "${SUITES}/suite-crud"
    expect_status 200
    expect_body '"code_size"'
    # The removed field is gone everywhere, not just on the worker that removed it.
    if printf '%s' "$BODY" | grep -q '"hardware"'; then
        echo "  a worker is still reporting the removed machine field" >&2
        _show_body
        exit 1
    fi
done

echo "  changing only its display name and repository changes no table, and every worker sees it"
request -X PATCH -H "$AUTH" -H "$JSON" \
    --data '{"display_name": "Suite CRUD", "repository": {"label": "Forge"}}' \
    "${SUITES}/suite-crud/schema"
expect_status 200
expect_body '"display_name":"Suite CRUD"'
expect_body '"label":"Forge"'

for _ in $(seq 1 "$ATTEMPTS"); do
    request "${SUITES}/suite-crud"
    expect_status 200
    expect_body '"display_name":"Suite CRUD"'
    expect_body '"label":"Forge"'
done

echo "  a removal without confirmation is refused"
request -X PATCH -H "$AUTH" -H "$JSON" \
    --data '{"metrics": {"remove": ["code_size"]}}' "${SUITES}/suite-crud/schema"
expect_status 400
expect_body '"code":"invalid_request"'

echo "  a key restricted to the suite manages it, and no other suite, nor its project in full"
# Minted only now, since the CLI only restricts a key to suites that exist.
restricted="$(mint_key restricted manage --suite crud/suite-crud)"
request -X PATCH -H "Authorization: Bearer ${restricted}" -H "$JSON" \
    --data '{"metrics": {"update": [{"name": "code_size", "display_name": "Code size"}]}}' \
    "${SUITES}/suite-crud/schema"
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
# Nor the suite of the same name in another project: a suite is its project's name and its own.
request -X POST -H "Authorization: Bearer ${restricted}" -H "$JSON" \
    --data '{"name":"m"}' "${PROJECTS}/crud-other/suites/suite-crud/machines"
expect_status 403
expect_body '"code":"forbidden"'
request -X PATCH -H "Authorization: Bearer ${restricted}" -H "$JSON" \
    --data '{"display_name": "Mine"}' "${PROJECTS}/crud"
expect_status 403
expect_body '"code":"forbidden"'

echo "  a key restricted to the whole project creates and manages its suites, and nothing else"
whole="$(mint_key whole manage --project crud)"
readonly WHOLE="Authorization: Bearer ${whole}"
request -H "$WHOLE" "${BASE_URL}/api/auth"
expect_status 200
# Without a `suite` key at all (E11).
expect_body '"restricted_to":\[\{"project":"crud"\}\]'
request -X POST -H "$WHOLE" -H "$JSON" --data '{"name":"whole","metrics":[]}' "$SUITES"
expect_status 201
request -X POST -H "$WHOLE" -H "$JSON" --data '{"name":"whole-m"}' "${SUITES}/suite-crud/machines"
expect_status 201
request -X PATCH -H "$WHOLE" -H "$JSON" --data '{"display_name": "CRUD"}' "${PROJECTS}/crud"
expect_status 200
request -X DELETE -H "$WHOLE" "${SUITES}/whole?confirm=true"
expect_status 204
request -X POST -H "$WHOLE" -H "$JSON" \
    --data '{"name":"m"}' "${PROJECTS}/crud-other/suites/suite-crud/machines"
expect_status 403
expect_body '"code":"forbidden"'
request -X POST -H "$WHOLE" -H "$JSON" --data '{"name":"crud-whole"}' "$PROJECTS"
expect_status 403
expect_body '"code":"forbidden"'

echo "  moving and renaming a suite is visible on every worker, and its key follows it"
request -X POST -H "$AUTH" -H "$JSON" --data '{"name":"moving","metrics":[]}' "$SUITES"
expect_status 201
mover="$(mint_key mover manage --suite crud/moving)"
readonly MOVER="Authorization: Bearer ${mover}"
create_project crud-moved "$AUTH"
request -X PATCH -H "$AUTH" -H "$JSON" --data '{"project": "crud-moved", "name": "moved"}' \
    "${SUITES}/moving"
expect_status 200
expect_body '"name":"moved"'
for _ in $(seq 1 "$ATTEMPTS"); do
    request "${PROJECTS}/crud-moved/suites/moved"
    expect_status 200
    request "${SUITES}/moving"
    expect_status 404
done
request -H "$MOVER" "${BASE_URL}/api/auth"
expect_body '"restricted_to":\[\{"project":"crud-moved","suite":"moved"\}\]'
request -X POST -H "$MOVER" -H "$JSON" --data '{"name":"m"}' \
    "${PROJECTS}/crud-moved/suites/moved/machines"
expect_status 201

echo "  a key restricted to the old project no longer covers it, nor moves a suite out, nor renames"
request -X POST -H "$WHOLE" -H "$JSON" --data '{"name":"m2"}' \
    "${PROJECTS}/crud-moved/suites/moved/machines"
expect_status 403
request -X PATCH -H "$WHOLE" -H "$JSON" --data '{"project": "crud-moved"}' "${SUITES}/suite-crud"
expect_status 403
expect_body 'covering that project in full'
request -X PATCH -H "$WHOLE" -H "$JSON" --data '{"name": "crud-renamed"}' "${PROJECTS}/crud"
expect_status 403
expect_body 'instance-wide'

echo "  renaming a project is visible on every worker, and its suite's key follows it"
request -X PATCH -H "$AUTH" -H "$JSON" --data '{"name": "crud-renamed"}' "${PROJECTS}/crud-moved"
expect_status 200
expect_body '"name":"crud-renamed"'
for _ in $(seq 1 "$ATTEMPTS"); do
    request "${PROJECTS}/crud-renamed/suites/moved"
    expect_status 200
    request "${PROJECTS}/crud-moved"
    expect_status 404
done
request -H "$MOVER" "${BASE_URL}/api/auth"
expect_body '"restricted_to":\[\{"project":"crud-renamed","suite":"moved"\}\]'
request -X DELETE -H "$AUTH" "${PROJECTS}/crud-renamed/suites/moved?confirm=true"
expect_status 204
request -X DELETE -H "$AUTH" "${PROJECTS}/crud-renamed"
expect_status 204

echo "  a key restricted over the API lists a whole project as such, and not with its own suites"
admin="$(mint_key crud-admin admin)"
readonly ADMIN="Authorization: Bearer ${admin}"
request -X POST -H "$ADMIN" -H "$JSON" \
    --data '{"name":"whole","scope":"submit","restricted_to":[{"project":"crud"}]}' \
    "${BASE_URL}/api/admin/api-keys"
expect_status 201
expect_body '"restricted_to":\[\{"project":"crud"\}\]'
for entries in '[{"project":"crud"},{"project":"crud","suite":"suite-crud"}]' \
    '[{"project":"crud","suite":null}]'; do
    request -X POST -H "$ADMIN" -H "$JSON" \
        --data "{\"name\":\"bad\",\"scope\":\"submit\",\"restricted_to\":${entries}}" \
        "${BASE_URL}/api/admin/api-keys"
    expect_status 400
    expect_body '"code":"invalid_request"'
done

echo "  writes need a credential of their own"
request -X POST -H "$JSON" --data '{"name":"denied","metrics":[]}' "$SUITES"
expect_status 401

echo "  the schema survives a restart, which is the only test of the lazy load"
restart_server
PROJECTS="${BASE_URL}/api/projects"
SUITES="${PROJECTS}/crud/suites"
request "${SUITES}/suite-crud"
expect_status 200
expect_body '"code_size"'

echo "  deleting it is visible on every worker"
request -X DELETE -H "$AUTH" "${SUITES}/suite-crud?confirm=true"
expect_status 204

for _ in $(seq 1 "$ATTEMPTS"); do
    request "${SUITES}/suite-crud"
    expect_status 404
    expect_body '"code":"not_found"'
done

echo "  deleting it removes it from the key restricted to it, which does not cover a namesake"
request -H "Authorization: Bearer ${restricted}" "${BASE_URL}/api/auth"
expect_status 200
expect_body '"restricted_to":\[\]'
request -X POST -H "$AUTH" -H "$JSON" --data '{"name":"suite-crud","metrics":[]}' "$SUITES"
expect_status 201
request -X POST -H "Authorization: Bearer ${restricted}" -H "$JSON" \
    --data '{"name":"m"}' "${SUITES}/suite-crud/machines"
expect_status 403
expect_body '"code":"forbidden"'
request -X DELETE -H "$AUTH" "${SUITES}/suite-crud?confirm=true"
expect_status 204

echo "  a suite deleted and created again from the same schema serves its new tables on every worker"
readonly RECREATED='{"name": "recreated", "metrics": [{"name": "execution_time", "type": "real"}]}'
request -X POST -H "$AUTH" -H "$JSON" --data "$RECREATED" "$SUITES"
expect_status 201
# Every worker reads the suite's tables, so that each holds its copy of the suite.
for _ in $(seq 1 "$ATTEMPTS"); do
    request "${SUITES}/recreated/machines"
    expect_status 200
done
# Back to back, so that no worker reloads in between: the new suite has the same name and schema as
# the copy each worker holds, but its tables are in a namespace of its own (D5).
request -X DELETE -H "$AUTH" "${SUITES}/recreated?confirm=true"
expect_status 204
request -X POST -H "$AUTH" -H "$JSON" --data "$RECREATED" "$SUITES"
expect_status 201
for _ in $(seq 1 "$ATTEMPTS"); do
    request "${SUITES}/recreated/machines"
    expect_status 200
done
request -X DELETE -H "$AUTH" "${SUITES}/recreated?confirm=true"
expect_status 204

echo "  deleting the project, once it has no suites, is visible on every worker"
request -X DELETE -H "$AUTH" "${PROJECTS}/crud"
expect_status 204
for _ in $(seq 1 "$ATTEMPTS"); do
    request "${SUITES}"
    expect_status 404
    expect_body '"code":"not_found"'
done

echo "  deleting it removes it from the key restricted to it, which then lists nothing"
request -H "$WHOLE" "${BASE_URL}/api/auth"
expect_status 200
expect_body '"restricted_to":\[\]'
