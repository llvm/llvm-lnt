#!/usr/bin/env bash
#
# Check authentication end to end against the running image (R5).
#
# What only this can show, and the unit tests cannot: a key minted out of band by the CLI, in a
# different process, authenticates over HTTP -- the bootstrap path R5 requires and deployment.md
# documents. The server runs with WEB_CONCURRENCY=4 here, so each request may land on a different
# worker, which is also what makes this a real check that authorization is resolved per request
# rather than cached in whichever worker first saw the key.

source "$(dirname "$0")/lib.sh"

readonly INDEX="${BASE_URL}/api/"
readonly KEYS="${BASE_URL}/api/admin/api-keys"

# Pull the token out of a create response. Narrow on purpose: it matches the 64 hex characters R5
# fixes, so a response that stopped carrying one fails here rather than silently yielding "".
extract_token() {
    printf '%s' "$BODY" | sed -n 's/.*"token":"\([0-9a-f]\{64\}\)".*/\1/p'
}

echo "  anonymous reads are allowed, and anonymous admin is not"
request "$INDEX"
expect_status 200
expect_body '"suites"'

request "$KEYS"
expect_status 401
expect_body '"code":"unauthorized"'

# R5: a 401 says which scheme the caller should have used. Read off a GET rather than a HEAD --
# FastAPI routes only the methods an endpoint declares, so HEAD is a miss like any other.
if ! curl --silent --dump-header - --output /dev/null "$KEYS" \
    | grep -qi '^www-authenticate: *Bearer'; then
    echo "  expected a WWW-Authenticate: Bearer header on the 401" >&2
    exit 1
fi

echo "  a malformed credential is told apart from a rejected one"
request -H 'Authorization: Basic zzz' "$INDEX"
expect_status 400
expect_body '"code":"invalid_request"'

request -H "Authorization: Bearer $(printf 'f%.0s' {1..64})" "$INDEX"
expect_status 401

echo "  a key created out of band by the CLI authenticates over HTTP"
# create-key prints the token on stdout and everything a human reads on stderr, so this captures
# the token alone.
bootstrap="$(docker exec "$CONTAINER" lnt-v5 server create-key --name integration --scope admin 2>/dev/null)"
if ! printf '%s' "$bootstrap" | grep -Eq '^[0-9a-f]{64}$'; then
    echo "  expected a 64-character hex token from create-key, got: ${bootstrap}" >&2
    exit 1
fi

request -H "Authorization: Bearer ${bootstrap}" "$KEYS"
expect_status 200
expect_body '"name":"integration"'

echo "  a key created over the API is usable immediately, on whichever worker answers"
request -X POST -H "Authorization: Bearer ${bootstrap}" -H 'Content-Type: application/json' \
    --data '{"name":"integration-bot","scope":"read"}' "$KEYS"
expect_status 201
bot="$(extract_token)"
if [ -z "$bot" ]; then
    echo "  no token in the create response" >&2
    _show_body
    exit 1
fi

# Several times over, since the worker that minted it is not necessarily the one answering here.
for _ in 1 2 3 4 5 6 7 8; do
    request -H "Authorization: Bearer ${bot}" "$INDEX"
    expect_status 200
done

echo "  that key is held to its scope"
request -H "Authorization: Bearer ${bot}" "$KEYS"
expect_status 403
expect_body '"code":"forbidden"'

echo "  revoking it takes effect immediately, on every worker"
request -X DELETE -H "Authorization: Bearer ${bootstrap}" "${KEYS}/${bot:0:8}"
expect_status 204

for _ in 1 2 3 4 5 6 7 8; do
    request -H "Authorization: Bearer ${bot}" "$INDEX"
    expect_status 401
done

echo "  the revoked key is still listed, marked inactive"
request -H "Authorization: Bearer ${bootstrap}" "$KEYS"
expect_status 200
expect_body '"prefix":"'"${bot:0:8}"'","name":"integration-bot","scope":"read".*"is_active":false'

echo "  the documentation routes never authenticate"
for path in /api/openapi.json /api/docs; do
    request -H 'Authorization: Basic zzz' "${BASE_URL}${path}"
    expect_status 200
done
