#!/usr/bin/env bash
#
# Integration tests for the v5 image: every numbered check in this directory, in order.
#
# `npm run test:integration` runs this inside tools/stack.sh, against the image in the Compose stack
# that production runs (stack.sh says which image that is). stack.sh's COMPOSE_PROJECT_NAME and
# COMPOSE_FILE make plain `docker compose` commands here act on the stack. The stack's .env adds
# two settings to production's: BODY_LIMIT is lowered from its 128 MiB default so that body-size
# checks can be done without having to send huge payloads, and WEB_CONCURRENCY=4 exercises several
# workers at once.
#
# Each check is run with what stack.sh provides:
#   CONTAINER     the app container, for checks that signal or restart it
#   DB_CONTAINER  the Postgres container, for checks that work on the database directly
#   PROXY_URL     where the server is reachable through Nginx, whose certificate is a throwaway one
#                 (so requests to it need `--insecure`)
#
# Checks source lib.sh for strict mode and test helpers, and for BASE_URL, where the server is
# reachable directly. They run in filename order and are independent, with one exception: anything
# that stops the server has to sort last, which is what the numeric prefixes are for.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "${CONTAINER:-}" ] || [ -z "${PROXY_URL:-}" ]; then
    echo "The stack is not set up: run the integration tests with \`npm run test:integration\`" >&2
    exit 1
fi

# restarts -- how many times Docker has restarted the stack's containers on its own.
#
# Production's restart policy would otherwise hide a crash of the app or Nginx behind a restart.
# Checked after each check, since restarting a container by hand (`docker restart`) resets it.
restarts() {
    local total=0 container
    for container in $(docker compose ps --all --quiet); do
        total=$((total + $(docker inspect -f '{{.RestartCount}}' "$container")))
    done
    echo "$total"
}

group_start() { [ -n "${GITHUB_ACTIONS:-}" ] && echo "::group::$1" || echo "--- $1"; }
group_end() { [ -n "${GITHUB_ACTIONS:-}" ] && echo "::endgroup::" || true; }

passed=0
failed=()
for check in "$HERE"/[0-9]*.sh; do
    name="$(basename "$check")"
    group_start "$name"
    before="$(restarts)"
    # Checks report their own diagnostics on stderr; fold it into stdout so it stays next to
    # the check it belongs to rather than surfacing wherever the two streams happen to meet.
    status=0
    bash "$check" 2>&1 || status=$?
    if [ "$status" -eq 0 ] && [ "$(restarts)" -gt "$before" ]; then
        echo "  a container restarted on its own during the check"
        status=1
    fi
    group_end
    if [ "$status" -eq 0 ]; then
        echo "PASS  $name"
        passed=$((passed + 1))
    else
        echo "FAIL  $name"
        failed+=("$name")
    fi
done

# Container logs first, summary last: whatever a failure left on screen should be the list of
# what failed, not fifty lines of request log scrolled past it. The logs are context for a check
# that failed because the *server* or the proxy misbehaved; an assertion that simply did not match
# has already said so above.
if [ ${#failed[@]} -gt 0 ]; then
    group_start "container log (last 20 lines)"
    docker compose logs --no-log-prefix --tail 20 app 2>&1 | sed 's/^/  /'
    group_end
    # Without the line Nginx logs for each worker it starts, one per CPU.
    group_start "proxy log (last 20 lines)"
    docker compose logs --no-log-prefix nginx 2>&1 | { grep -v 'start worker process' || true; } \
        | tail -n 20 | sed 's/^/  /'
    group_end
fi

echo
echo "${passed} passed, ${#failed[@]} failed"
if [ ${#failed[@]} -gt 0 ]; then
    printf '  FAILED: %s\n' "${failed[@]}"
    exit 1
fi
