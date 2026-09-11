#!/usr/bin/env bash
#
# Integration tests for the v5 image.
#
#   ./run.sh [IMAGE]
#
# Starts IMAGE against a throwaway Postgres and runs every numbered check in this directory
# against it, in order. Everything is created here and torn down on exit, so this behaves the
# same on a laptop as on a CI runner and needs neither `npm run db:up` nor a Postgres service
# container.
#
# Each check is run with:
#   BASE_URL      where the server is reachable
#   CONTAINER     the app container, for checks that signal or restart it
#   DB_CONTAINER  the Postgres container, for checks that take the database away
#
# Checks source lib.sh for strict mode and test helpers. They run in filename order and are
# independent, with one exception: anything that stops the server has to sort last, which is
# what the numeric prefixes are for.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# With no argument, build the image from the tree first, so that `npm run test:integration` is
# a single command from a clean checkout. CI passes the tag it just built, and so skips this.
if [ $# -ge 1 ]; then
    IMAGE="$1"
else
    IMAGE="lnt-v5:integration"
    echo "Building ${IMAGE}..."
    docker build --tag "$IMAGE" "${HERE}/.."
fi

# Not 3000: a dev server is often already sitting there.
PORT="${PORT:-3100}"

NETWORK="lnt-v5-integration"
APP="lnt-v5-integration-app"
PG="lnt-v5-integration-db"

export BASE_URL="http://localhost:${PORT}"
export CONTAINER="$APP"
export DB_CONTAINER="$PG"

cleanup() {
    docker rm --force "$APP" "$PG" >/dev/null 2>&1 || true
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT
# Also up front, in case a previous run was killed before its trap fired.
cleanup

echo "Starting Postgres..."
docker network create "$NETWORK" >/dev/null
docker run --detach --name "$PG" --network "$NETWORK" \
    --env POSTGRES_USER=lnt --env POSTGRES_PASSWORD=lnt --env POSTGRES_DB=lnt \
    --health-cmd='pg_isready -U lnt' --health-interval=2s \
    --health-timeout=3s --health-retries=15 \
    postgres:16 >/dev/null

for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$PG")" = healthy ] && break
    sleep 1
done
if [ "$(docker inspect -f '{{.State.Health.Status}}' "$PG")" != healthy ]; then
    echo "Postgres never became healthy" >&2
    docker logs "$PG" >&2
    exit 1
fi

echo "Starting ${IMAGE}..."
# BODY_LIMIT is lowered from its 128 MiB default so that body-size checks can be done without
# having to send huge payloads.
#
# WEB_CONCURRENCY is set to exercise multiple concurrent workers in the integration tests.
docker run --detach --init --name "$APP" --network "$NETWORK" --publish "${PORT}:3000" \
    --env DATABASE_URL="postgres://lnt:lnt@${PG}:5432/lnt" \
    --env BODY_LIMIT=1048576 \
    --env WEB_CONCURRENCY=4 \
    "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
    curl --silent --fail --output /dev/null "${BASE_URL}/healthz" && break
    sleep 1
done
if ! curl --silent --fail --output /dev/null "${BASE_URL}/healthz"; then
    echo "Server never became reachable at ${BASE_URL}/healthz" >&2
    docker logs "$APP" >&2
    exit 1
fi

group_start() { [ -n "${GITHUB_ACTIONS:-}" ] && echo "::group::$1" || echo "--- $1"; }
group_end() { [ -n "${GITHUB_ACTIONS:-}" ] && echo "::endgroup::" || true; }

passed=0
failed=()
for check in "$HERE"/[0-9]*.sh; do
    name="$(basename "$check")"
    group_start "$name"
    # Checks report their own diagnostics on stderr; fold it into stdout so it stays next to
    # the check it belongs to rather than surfacing wherever the two streams happen to meet.
    if bash "$check" 2>&1; then
        group_end
        echo "PASS  $name"
        passed=$((passed + 1))
    else
        group_end
        echo "FAIL  $name"
        failed+=("$name")
    fi
done

# Container log first, summary last: whatever a failure left on screen should be the list of
# what failed, not fifty lines of request log scrolled past it. The log is context for a check
# that failed because the *server* misbehaved; an assertion that simply did not match has
# already said so above.
if [ ${#failed[@]} -gt 0 ]; then
    group_start "container log (last 20 lines)"
    docker logs --tail 20 "$APP" 2>&1 | sed 's/^/  /'
    group_end
fi

echo
echo "${passed} passed, ${#failed[@]} failed"
if [ ${#failed[@]} -gt 0 ]; then
    printf '  FAILED: %s\n' "${failed[@]}"
    exit 1
fi
