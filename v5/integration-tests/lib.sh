#!/usr/bin/env bash
#
# Sourced by every check. Provides simple utilities to test and produce useful error messages
# on failure.

set -euo pipefail

trap 'echo "  FAILED ${0##*/}:${LINENO} -> ${BASH_COMMAND}" >&2' ERR

# look_up_base_url -- set BASE_URL to where the app container is reachable from here.
#
# Docker picks the host port anew each time the container starts, so this is looked up rather than
# handed down by tools/stack.sh: once per check, and again by restart_server. In two steps, so that
# a failing `docker port` stops the check rather than yielding "http://".
look_up_base_url() {
    local address
    address="$(docker port "$CONTAINER" 3000/tcp)"
    BASE_URL="http://${address}"
}
look_up_base_url

# Set by `request`, read by the expect_* helpers.
STATUS=""
BODY=""
HEADERS=""

_show_body() {
    echo "  actual status: ${STATUS}" >&2
    echo "  actual body:" >&2
    printf '%s\n' "$BODY" | head -10 | cut -c1-200 | sed 's/^/    /' >&2
}

# mint_key <name> <scope> [create-key options...] -- create an API key through the CLI and echo its
# token. Any further arguments go to `create-key`, e.g. `--suite nts` to restrict the key.
#
# I5 requires an out-of-band way to create a key, and this is it. `create-key` prints the token
# alone on stdout and everything a human reads on stderr, which is what makes this capture yield
# just the token. Checks are independent, so each one that needs a key mints its own.
mint_key() {
    local token
    token="$(docker exec "$CONTAINER" lnt-v5 server create-key --name "$1" --scope "$2" "${@:3}" 2>/dev/null)"
    # Narrow on purpose: it matches the 64 hex characters I5 fixes, so a create-key that stopped
    # printing one fails here rather than silently yielding "".
    if ! printf '%s' "$token" | grep -Eq '^[0-9a-f]{64}$'; then
        echo "  expected a 64-character hex token from create-key, got: ${token}" >&2
        exit 1
    fi
    printf '%s' "$token"
}

# wait_for_health [base URL] -- block until the server answers /healthz there (by default at
# BASE_URL), or fail saying so within a minute.
wait_for_health() {
    local url="${1:-$BASE_URL}/healthz"
    for _ in $(seq 1 60); do
        curl --silent --fail --insecure --output /dev/null "$url" && return 0
        sleep 1
    done
    echo "  server never became reachable at ${url} within 60s" >&2
    exit 1
}

# restart_server -- restart the app container, and wait until it answers at its new BASE_URL.
restart_server() {
    docker restart "$CONTAINER" >/dev/null
    look_up_base_url
    wait_for_health
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
    HEADERS="$(cat "$header_file")"
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
