#!/usr/bin/env bash
#
# Sourced by every check. Provides simple utilities to test and produce useful error messages
# on failure.

set -euo pipefail

trap 'echo "  FAILED ${0##*/}:${LINENO} -> ${BASH_COMMAND}" >&2' ERR

# The content type every write in these checks sends, spelled once.
readonly JSON='Content-Type: application/json'

# Set by `request`, read by the expect_* helpers.
STATUS=""
BODY=""
HEADERS=""

_show_body() {
    echo "  actual status: ${STATUS}" >&2
    echo "  actual body:" >&2
    printf '%s\n' "$BODY" | head -10 | cut -c1-200 | sed 's/^/    /' >&2
}

# mint_key <name> <scope> -- create an API key through the CLI and echo its token.
#
# R5 requires an out-of-band way to create a key, and this is it. `create-key` prints the token
# alone on stdout and everything a human reads on stderr, which is what makes this capture yield
# just the token. Checks are independent, so each one that needs a key mints its own.
mint_key() {
    local token
    token="$(docker exec "$CONTAINER" lnt-v5 server create-key --name "$1" --scope "$2" 2>/dev/null)"
    # Narrow on purpose: it matches the 64 hex characters R5 fixes, so a create-key that stopped
    # printing one fails here rather than silently yielding "".
    if ! printf '%s' "$token" | grep -Eq '^[0-9a-f]{64}$'; then
        echo "  expected a 64-character hex token from create-key, got: ${token}" >&2
        exit 1
    fi
    printf '%s' "$token"
}

# wait_for_health [seconds] -- block until the server answers /healthz, or fail saying so.
wait_for_health() {
    local limit="${1:-60}"
    for _ in $(seq 1 "$limit"); do
        curl --silent --fail --output /dev/null "${BASE_URL}/healthz" && return 0
        sleep 1
    done
    echo "  server never became reachable at ${BASE_URL}/healthz within ${limit}s" >&2
    exit 1
}

# request <curl args...> -- perform a request, capturing status, headers and body.
#
# Deliberately does not use --fail: a check asserts the status itself, and --fail would turn an
# unexpected one into a bare non-zero exit with nothing to read.
request() {
    local body_file header_file
    body_file="$(mktemp)"
    header_file="$(mktemp)"
    STATUS="$(curl --silent --output "$body_file" --dump-header "$header_file" \
        --write-out '%{http_code}' "$@")"
    BODY="$(cat "$body_file")"
    # CRs stripped here rather than worked around in each assertion: they are how HTTP ends a
    # header line, and they would otherwise sit between the value and any `$` an expectation
    # anchors with.
    HEADERS="$(tr -d '\r' < "$header_file")"
    rm -f "$body_file" "$header_file"
}

# expect_status <code>
expect_status() {
    if [ "$STATUS" != "$1" ]; then
        echo "  expected status $1" >&2
        _show_body
        exit 1
    fi
}

# expect_body <extended regex>
expect_body() {
    if ! printf '%s' "$BODY" | grep -Eq -- "$1"; then
        echo "  expected body to match: $1" >&2
        _show_body
        exit 1
    fi
}

# expect_header <name> <extended regex>
#
# The name is matched case-insensitively, since HTTP does not fix a casing for it.
expect_header() {
    if ! printf '%s' "$HEADERS" | grep -iEq "^$1: *$2"; then
        echo "  expected a $1 header matching: $2" >&2
        printf '%s\n' "$HEADERS" | sed 's/^/    /' >&2
        exit 1
    fi
}
